/**
 * Local, zero-cost tool-calling planner via the Ollama HTTP API (no SDK, no API key, no
 * network egress beyond 127.0.0.1). Selected only via `--provider ollama` (scripts/live-eval.ts).
 * No retries. A connection failure, timeout, or malformed response is reported as a real
 * error (thrown), never silently swallowed into a fallback — runAgentTurn's existing
 * provider_error path (runner.ts) is what records it; this file does not catch-and-continue.
 */
import type { ConversationMessage, ModelPlanner, PlannerRequest, PlannerResponse, PlannerStop } from './model.js';

export const DEFAULT_OLLAMA_MODEL = 'llama3.1';
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const REQUEST_TIMEOUT_MS = 60_000;

interface OllamaToolCall {
    id?: string;
    function: { name?: string; arguments?: unknown };
}
interface OllamaChatResponse {
    model?: string;
    message?: { role?: string; content?: string; tool_calls?: OllamaToolCall[] };
    done?: boolean;
    done_reason?: string;
    prompt_eval_count?: number;
    eval_count?: number;
}

export type OllamaFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface OllamaPlannerOptions {
    model?: string;
    baseUrl?: string;
    /** Inject a fetch implementation (tests). Defaults to the global fetch, scoped to 127.0.0.1. */
    fetchImpl?: OllamaFetch;
    /** Request timeout in ms (tests only; production always uses REQUEST_TIMEOUT_MS). */
    timeoutMs?: number;
}

export class OllamaPlanner implements ModelPlanner {
    readonly name = 'ollama/chat-tool-use/v1';
    readonly model: string;
    private readonly baseUrl: string;
    private readonly fetchImpl: OllamaFetch;
    private readonly timeoutMs: number;
    private callSeq = 0;

    constructor(options: OllamaPlannerOptions = {}) {
        this.model = options.model ?? DEFAULT_OLLAMA_MODEL;
        this.baseUrl = options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    }

    buildRequest(req: PlannerRequest): Record<string, unknown> {
        return {
            model: this.model,
            stream: false,
            // Ollama has no distinct system+session fields; concatenate, system policy first (stable prefix).
            messages: [{ role: 'system', content: `${req.systemPolicy}\n\n${req.sessionContext}` }, ...req.messages.flatMap(toOllamaMessage)],
            tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
            options: { num_predict: req.maxOutputTokens }
        };
    }

    async plan(req: PlannerRequest): Promise<PlannerResponse> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        let res: Response;
        try {
            res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(this.buildRequest(req)),
                signal: controller.signal
            });
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') throw new Error(`Ollama request timed out after ${this.timeoutMs}ms (${this.baseUrl})`);
            throw new Error(`Ollama request failed: ${err instanceof Error ? err.message : String(err)} (is the Ollama daemon running at ${this.baseUrl}?)`, { cause: err });
        } finally {
            clearTimeout(timeout);
        }
        if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);

        let body: OllamaChatResponse;
        try {
            body = (await res.json()) as OllamaChatResponse;
        } catch (err) {
            throw new Error(`Ollama response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
        return this.parseResponse(body);
    }

    private parseResponse(body: OllamaChatResponse): PlannerResponse {
        const message = body.message ?? {};
        const text = typeof message.content === 'string' ? message.content : '';
        const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        // Ollama does not always assign tool_call ids; synthesize stable, unique ones when absent.
        const toolCalls = rawCalls
            .filter(c => typeof c.function?.name === 'string' && c.function.name.length > 0)
            .map(c => ({
                id: c.id ?? `ollama_${this.model}_${++this.callSeq}`,
                name: c.function.name!,
                arguments: c.function.arguments && typeof c.function.arguments === 'object' ? c.function.arguments : {}
            }));
        // A malformed tool_calls entry (missing function.name) is dropped above, not silently
        // treated as a valid call — if that drop empties every call, fall through to the
        // empty-reply/truncation handling below rather than claiming a tool was invoked.

        let stop: PlannerStop;
        if (body.done_reason === 'length') stop = 'max_tokens';
        else if (toolCalls.length > 0) stop = 'tool_use';
        else if (text.trim().length > 0) stop = 'end_turn';
        // Empty content AND no tool calls (e.g. the model produced nothing usable, or every
        // tool_calls entry was malformed and dropped): not a crash, but not "the model is
        // done talking" either. Treated as 'other' so the runner does not read empty text
        // as a real final reply.
        else stop = 'other';

        return {
            text,
            toolCalls,
            stop,
            model: body.model ?? this.model,
            usage: {
                inputTokens: body.prompt_eval_count ?? 0,
                outputTokens: body.eval_count ?? 0,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0
            }
            // No providerContent: Ollama turns are stateless role/content, nothing to replay unchanged.
        };
    }
}

function toOllamaMessage(m: ConversationMessage): Record<string, unknown>[] {
    if (m.role === 'user') return [{ role: 'user', content: m.text }];
    if (m.role === 'assistant') {
        return [
            {
                role: 'assistant',
                content: m.text,
                ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, function: { name: c.name, arguments: c.arguments ?? {} } })) } : {})
            }
        ];
    }
    // Ollama expects one "tool" message per result (unlike Anthropic's single batched user message).
    return m.results.map(r => ({ role: 'tool', tool_call_id: r.callId, content: r.content }));
}
