/** Mocked OllamaPlanner tests — injected fetch, no Ollama daemon required, no network. */
import { describe, expect, it } from 'vitest';

import type { PlannerRequest } from '../src/agent/model.js';
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL, OllamaPlanner, type OllamaFetch } from '../src/agent/ollama-planner.js';

const REQ: PlannerRequest = {
    systemPolicy: 'policy',
    sessionContext: 'session',
    tools: [{ name: 'get_duty_contact', description: 'd', input_schema: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', text: 'who is on duty?' }],
    maxOutputTokens: 512
};

const okFetch = (body: unknown, status = 200): OllamaFetch => async () =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

describe('OllamaPlanner: construction and request shape', () => {
    it('defaults to llama3.1 and 127.0.0.1:11434', () => {
        const p = new OllamaPlanner();
        expect(p.model).toBe(DEFAULT_OLLAMA_MODEL);
        expect(p.model).toBe('llama3.1');
        expect(DEFAULT_OLLAMA_BASE_URL).toBe('http://127.0.0.1:11434');
    });

    it('buildRequest: tools mapped, stream false, options.num_predict from maxOutputTokens', () => {
        const p = new OllamaPlanner({ model: 'llama3.1' });
        const body = p.buildRequest(REQ) as { model: string; stream: boolean; tools: Array<{ function: { name: string } }>; options: { num_predict: number } };
        expect(body.model).toBe('llama3.1');
        expect(body.stream).toBe(false);
        expect(body.tools[0]!.function.name).toBe('get_duty_contact');
        expect(body.options.num_predict).toBe(512);
    });

    it('a captured POST body hits /api/chat on the configured base URL', async () => {
        let captured: { url: string; body: unknown } | null = null;
        const fetchImpl: OllamaFetch = async (url, init) => {
            captured = { url, body: JSON.parse(init.body as string) };
            return { ok: true, status: 200, json: async () => ({ message: { content: 'hi' }, done_reason: 'stop' }) } as Response;
        };
        const p = new OllamaPlanner({ baseUrl: 'http://127.0.0.1:19999', fetchImpl });
        await p.plan(REQ);
        expect(captured!.url).toBe('http://127.0.0.1:19999/api/chat');
        expect((captured!.body as { model: string }).model).toBe(DEFAULT_OLLAMA_MODEL);
    });
});

describe('OllamaPlanner: tool-call arguments and ids', () => {
    it('parses already-structured arguments and preserves given ids', async () => {
        const fetchImpl = okFetch({
            model: 'llama3.1',
            message: { content: '', tool_calls: [{ id: 'call_abc123', function: { name: 'record_care_event', arguments: { kind: 'meal', note: 'ate rice' } } }] },
            done_reason: 'stop',
            prompt_eval_count: 374,
            eval_count: 68
        });
        const p = new OllamaPlanner({ fetchImpl });
        const res = await p.plan(REQ);
        expect(res.stop).toBe('tool_use');
        expect(res.toolCalls).toEqual([{ id: 'call_abc123', name: 'record_care_event', arguments: { kind: 'meal', note: 'ate rice' } }]);
        expect(res.usage).toEqual({ inputTokens: 374, outputTokens: 68, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    });

    it('synthesizes a stable unique id when Ollama omits one, never reusing a prior id', async () => {
        const fetchImpl = okFetch({ message: { content: '', tool_calls: [{ function: { name: 'get_duty_contact', arguments: {} } }] } });
        const p = new OllamaPlanner({ fetchImpl });
        const r1 = await p.plan(REQ);
        const r2 = await p.plan(REQ);
        expect(r1.toolCalls[0]!.id).toMatch(/^ollama_llama3\.1_\d+$/);
        expect(r1.toolCalls[0]!.id).not.toBe(r2.toolCalls[0]!.id);
    });

    it('parallel tool calls all parsed, each with its own id', async () => {
        const fetchImpl = okFetch({
            message: {
                content: '',
                tool_calls: [
                    { id: 'a', function: { name: 'record_care_event', arguments: { kind: 'medication', note: 'took pills' } } },
                    { id: 'b', function: { name: 'prepare_appointment_request', arguments: { reason_as_reported: 'knee hurts', preferred_window: 'this_week' } } }
                ]
            }
        });
        const res = await new OllamaPlanner({ fetchImpl }).plan(REQ);
        expect(res.toolCalls.map(c => c.name)).toEqual(['record_care_event', 'prepare_appointment_request']);
    });

    it('a tool_calls entry missing function.name is dropped, not treated as a call', async () => {
        const fetchImpl = okFetch({ message: { content: '', tool_calls: [{ id: 'x', function: { arguments: {} } }] } });
        const res = await new OllamaPlanner({ fetchImpl }).plan(REQ);
        expect(res.toolCalls).toEqual([]);
        expect(res.stop).toBe('other'); // no text and no valid call: not a real end_turn
    });

    it('non-object arguments (string/null) are normalized to {} rather than crashing', async () => {
        const fetchImpl = okFetch({ message: { content: '', tool_calls: [{ id: 'x', function: { name: 'get_duty_contact', arguments: 'not-an-object' } }] } });
        const res = await new OllamaPlanner({ fetchImpl }).plan(REQ);
        expect(res.toolCalls[0]!.arguments).toEqual({});
    });
});

describe('OllamaPlanner: empty replies, truncation, malformed bodies', () => {
    it('empty content and no tool calls stops as "other", not a false end_turn', async () => {
        const res = await new OllamaPlanner({ fetchImpl: okFetch({ message: { content: '' }, done_reason: 'stop' }) }).plan(REQ);
        expect([res.stop, res.text]).toEqual(['other', '']);
    });

    it('non-empty text with no tool calls is a genuine end_turn', async () => {
        const res = await new OllamaPlanner({ fetchImpl: okFetch({ message: { content: 'Priya is on duty.' }, done_reason: 'stop' }) }).plan(REQ);
        expect([res.stop, res.text]).toEqual(['end_turn', 'Priya is on duty.']);
    });

    it('done_reason "length" maps to max_tokens even if a tool call is also present', async () => {
        const res = await new OllamaPlanner({
            fetchImpl: okFetch({ message: { content: '', tool_calls: [{ id: 'x', function: { name: 'get_duty_contact', arguments: {} } }] }, done_reason: 'length' })
        }).plan(REQ);
        expect(res.stop).toBe('max_tokens');
    });

    it('a missing message field entirely does not throw; treated as an empty/other response', async () => {
        const res = await new OllamaPlanner({ fetchImpl: okFetch({ done_reason: 'stop' }) }).plan(REQ);
        expect([res.stop, res.text, res.toolCalls]).toEqual(['other', '', []]);
    });

    it('missing usage counters default to 0, not undefined/NaN', async () => {
        const res = await new OllamaPlanner({ fetchImpl: okFetch({ message: { content: 'hi' } }) }).plan(REQ);
        expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    });

    it('invalid JSON body throws a real error (no silent fallback)', async () => {
        const fetchImpl: OllamaFetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } }) as unknown as Response;
        await expect(new OllamaPlanner({ fetchImpl }).plan(REQ)).rejects.toThrow(/not valid JSON/);
    });

    it('a non-2xx HTTP status throws with the status code surfaced', async () => {
        const fetchImpl: OllamaFetch = async () => ({ ok: false, status: 404, text: async () => 'model "llama3.1" not found' }) as Response;
        await expect(new OllamaPlanner({ fetchImpl }).plan(REQ)).rejects.toThrow(/HTTP 404/);
    });
});

describe('OllamaPlanner: connection failures and timeouts — thrown, not swallowed', () => {
    it('a connection refusal (daemon not running) throws a clear, actionable error', async () => {
        const fetchImpl: OllamaFetch = async () => {
            throw new TypeError('fetch failed');
        };
        await expect(new OllamaPlanner({ fetchImpl }).plan(REQ)).rejects.toThrow(/Ollama request failed.*daemon running/s);
    });

    it('an aborted/timed-out request throws a timeout-specific error', async () => {
        const fetchImpl: OllamaFetch = async (_url, init) =>
            new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        const p = new OllamaPlanner({ fetchImpl, timeoutMs: 20 });
        const promise = p.plan(REQ);
        await expect(promise).rejects.toThrow(/timed out/);
    }, 2000);
});

describe('OllamaPlanner: multi-turn message mapping preserves verbatim text', () => {
    it('assistant tool_calls and tool-result messages round-trip through buildRequest', () => {
        const req: PlannerRequest = {
            ...REQ,
            messages: [
                { role: 'user', text: "I took my morning medicines. My knee hurts." },
                { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'record_care_event', arguments: { kind: 'medication', note: 'I took my morning medicines.' } }] },
                { role: 'tool_results', results: [{ callId: 'c1', tool: 'record_care_event', content: '{"trust":"untrusted_data"}', isError: false }] }
            ]
        };
        const body = new OllamaPlanner().buildRequest(req) as { messages: Array<Record<string, unknown>> };
        // [0] system, [1] user, [2] assistant w/ tool_calls, [3] tool result
        expect(body.messages[1]).toEqual({ role: 'user', content: "I took my morning medicines. My knee hurts." });
        expect(body.messages[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'record_care_event', arguments: { kind: 'medication', note: 'I took my morning medicines.' } } }] });
        expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"trust":"untrusted_data"}' });
    });
});
