/**
 * Provider-neutral model planner contract. A planner proposes the next step; it never
 * executes tools. The runner (runner.ts) executes proposals through AgentAdapter.
 */
import type { ModelTool } from './adapter.js';

export interface ToolCallProposal {
    /** Provider's id for this call (e.g. Anthropic tool_use.id); echoed back with the result. */
    id: string;
    name: string;
    arguments: unknown;
}

export type ConversationMessage =
    | { role: 'user'; text: string }
    | {
          role: 'assistant';
          text: string;
          toolCalls: ToolCallProposal[];
          /** Provider-native content, replayed unchanged on the next request (keeps thinking blocks valid). */
          providerContent?: unknown;
      }
    | { role: 'tool_results'; results: Array<{ callId: string; tool: string; content: string; isError: boolean }> };

export interface PlannerRequest {
    /** Static, cacheable instructions (no per-user data). */
    systemPolicy: string;
    /** Application-trusted per-session context (who is speaking). */
    sessionContext: string;
    tools: ModelTool[];
    messages: readonly ConversationMessage[];
    maxOutputTokens: number;
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
}

export type PlannerStop = 'tool_use' | 'end_turn' | 'max_tokens' | 'refusal' | 'other';

export interface PlannerResponse {
    text: string;
    toolCalls: ToolCallProposal[];
    stop: PlannerStop;
    usage: TokenUsage;
    model: string;
    providerContent?: unknown;
}

export interface ModelPlanner {
    readonly name: string;
    readonly model: string;
    plan(request: PlannerRequest): Promise<PlannerResponse>;
}

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

export interface RunLimits {
    maxModelIterations: number;
    maxToolCalls: number;
    maxOutputTokensPerCall: number;
    maxInputTokensPerTurn: number;
    maxOutputTokensPerTurn: number;
}

export const DEFAULT_LIMITS: RunLimits = {
    maxModelIterations: 6,
    maxToolCalls: 8,
    maxOutputTokensPerCall: 2048,
    maxInputTokensPerTurn: 60_000,
    maxOutputTokensPerTurn: 8_000
};

/** Limits from env (CARELOOP_LLM_*), never above the hard caps for iterations (6) and tool calls (8). */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): RunLimits {
    const num = (key: string, fallback: number) => {
        const v = Number(env[key]);
        return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
    };
    return {
        maxModelIterations: Math.min(num('CARELOOP_LLM_MAX_ITERATIONS', DEFAULT_LIMITS.maxModelIterations), DEFAULT_LIMITS.maxModelIterations),
        maxToolCalls: Math.min(num('CARELOOP_LLM_MAX_TOOL_CALLS', DEFAULT_LIMITS.maxToolCalls), DEFAULT_LIMITS.maxToolCalls),
        maxOutputTokensPerCall: num('CARELOOP_LLM_MAX_OUTPUT_TOKENS_PER_CALL', DEFAULT_LIMITS.maxOutputTokensPerCall),
        maxInputTokensPerTurn: num('CARELOOP_LLM_MAX_INPUT_TOKENS_PER_TURN', DEFAULT_LIMITS.maxInputTokensPerTurn),
        maxOutputTokensPerTurn: num('CARELOOP_LLM_MAX_OUTPUT_TOKENS_PER_TURN', DEFAULT_LIMITS.maxOutputTokensPerTurn)
    };
}

/** USD per million tokens (Anthropic first-party list prices, skill cache dated 2026-10-06). Verify before relying on them. */
export const PRICES_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
    'claude-opus-5-5': { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 },
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
};

export function estimateCostUsd(model: string, u: TokenUsage): number | null {
    const p = PRICES_PER_MTOK[model];
    if (!p) return null;
    const usd = (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadInputTokens * p.cacheRead + u.cacheCreationInputTokens * p.cacheWrite) / 1e6;
    return Math.round(usd * 1e6) / 1e6;
}
