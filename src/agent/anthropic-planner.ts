/**
 * Real Claude tool-calling planner. Never constructed unless the caller explicitly opts in
 * (see scripts/live-eval.ts). No retries (maxRetries: 0), non-streaming, tool_choice auto.
 * The full assistant content (including thinking blocks) is replayed unchanged each step.
 */
import Anthropic from '@anthropic-ai/sdk';

import type { ConversationMessage, ModelPlanner, PlannerRequest, PlannerResponse, PlannerStop } from './model.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const REQUEST_TIMEOUT_MS = 60_000;

export interface AnthropicPlannerOptions {
    model?: string;
    /** output_config.effort; Claude Opus 5.5 defaults to "medium". */
    effort?: 'low' | 'medium' | 'high';
    /** Inject a messages client (tests). Defaults to a real SDK client with maxRetries: 0. */
    messages?: Pick<Anthropic['messages'], 'create'>;
}

export class AnthropicPlanner implements ModelPlanner {
    readonly name = 'anthropic/messages-tool-use/v1';
    readonly model: string;
    private readonly effort: 'low' | 'medium' | 'high';
    private readonly messages: Pick<Anthropic['messages'], 'create'>;

    constructor(options: AnthropicPlannerOptions = {}) {
        this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
        this.effort = options.effort ?? 'medium';
        this.messages = options.messages ?? new Anthropic({ maxRetries: 0, timeout: REQUEST_TIMEOUT_MS }).messages;
    }

    buildRequest(req: PlannerRequest): Anthropic.MessageCreateParamsNonStreaming {
        const tools: Anthropic.Tool[] = req.tools.map((t, i) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema as Anthropic.Tool.InputSchema,
            // Cache breakpoint after the (static, deterministic) tool list.
            ...(i === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {})
        }));
        return {
            model: this.model,
            max_tokens: req.maxOutputTokens,
            output_config: { effort: this.effort },
            tool_choice: { type: 'auto' },
            tools,
            system: [
                { type: 'text', text: req.systemPolicy, cache_control: { type: 'ephemeral' } },
                { type: 'text', text: req.sessionContext }
            ],
            messages: req.messages.map(toAnthropicMessage)
        };
    }

    async plan(req: PlannerRequest): Promise<PlannerResponse> {
        const response = await this.messages.create(this.buildRequest(req));
        return parseResponse(response);
    }
}

function toAnthropicMessage(m: ConversationMessage): Anthropic.MessageParam {
    if (m.role === 'user') return { role: 'user', content: m.text };
    if (m.role === 'assistant') {
        if (m.providerContent) return { role: 'assistant', content: m.providerContent as Anthropic.ContentBlockParam[] };
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.text) blocks.push({ type: 'text', text: m.text });
        for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments ?? {} });
        return { role: 'assistant', content: blocks };
    }
    // All results for one assistant turn go back in a single user message.
    return {
        role: 'user',
        content: m.results.map(r => ({ type: 'tool_result' as const, tool_use_id: r.callId, content: r.content, is_error: r.isError }))
    };
}

export function parseResponse(response: Anthropic.Message): PlannerResponse {
    const text = response.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
    const toolCalls = response.content.flatMap(b => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, arguments: b.input }] : []));
    const stopMap: Record<string, PlannerStop> = { tool_use: 'tool_use', end_turn: 'end_turn', max_tokens: 'max_tokens', refusal: 'refusal' };
    return {
        text,
        toolCalls,
        stop: stopMap[response.stop_reason ?? ''] ?? 'other',
        model: response.model,
        providerContent: response.content,
        usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0
        }
    };
}
