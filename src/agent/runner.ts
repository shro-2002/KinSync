/**
 * One user turn: model proposes -> adapter enforces policy and executes -> result returned
 * as untrusted data -> model decides next -> final reply -> output safety.
 * Hard limits: model iterations, tool calls, per-turn token budgets. No retries anywhere:
 * a provider error ends the turn with a fact-based reply.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { awaitsHuman, readEnvelope, type AgentAdapter, type ModelToolMessage, type TurnContext } from './adapter.js';
import { DEFAULT_LIMITS, estimateCostUsd, ZERO_USAGE, type ConversationMessage, type ModelPlanner, type RunLimits, type TokenUsage } from './model.js';
import { checkFinalReply, summarizeFromTrace, type SafetyVerdict } from './output-safety.js';
import { SYSTEM_POLICY } from './policy.js';
import { traceHeader, type ToolCallTrace, type TraceStep } from './trace.js';

/** Static reply rules appended to SYSTEM_POLICY (also static, so the whole prefix is cacheable). */
export const RESPONSE_POLICY = [
    'Use the tools to do what the person asked, then reply in one to three short, plain sentences suitable for speaking aloud.',
    'Only say something happened if a tool result in this conversation confirms it. Drafted messages are waiting for approval and have not been sent; appointment requests are not bookings.',
    'Do not mention internal ids. Do not mention other households.'
].join('\n');

export type TurnStop = 'completed' | 'awaiting_approval' | 'max_iterations' | 'max_tool_calls' | 'token_budget' | 'provider_error' | 'refusal' | 'output_truncated';

export interface IterationUsage extends TokenUsage {
    iteration: number;
    model: string;
    stop: string;
    toolCalls: number;
    latencyMs: number;
}

export interface AgentTurnResult {
    stop: TurnStop;
    reply: SafetyVerdict & { source: 'model' | 'fallback' };
    trace: ToolCallTrace;
    modelIterations: number;
    usage: { iterations: IterationUsage[]; totals: TokenUsage; estimatedCostUsd: number | null };
    providerError: string | null;
}

export interface RunOptions {
    adapter: AgentAdapter;
    planner: ModelPlanner;
    turn: TurnContext;
    /** Trusted description of the speaker, supplied by the application. */
    sessionContext: string;
    limits?: RunLimits;
    /** JSONL usage log (no utterances, no tool payloads). Omit to skip writing. */
    usageLogPath?: string;
}

const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens
});
const inputOf = (u: TokenUsage) => u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;

export async function runAgentTurn(options: RunOptions): Promise<AgentTurnResult> {
    const { adapter, planner, turn } = options;
    const limits = options.limits ?? DEFAULT_LIMITS;
    const tools = await adapter.listModelTools();
    const conversation: ConversationMessage[] = [{ role: 'user', text: turn.userUtterance }];
    const steps: TraceStep[] = [];
    const toolMessages: ModelToolMessage[] = [];
    const iterations: IterationUsage[] = [];
    let totals = ZERO_USAGE;
    let modelText: string | null = null;
    let stop: TurnStop | null = null;
    let providerError: string | null = null;

    for (let i = 1; i <= limits.maxModelIterations && stop === null; i++) {
        if (inputOf(totals) >= limits.maxInputTokensPerTurn || totals.outputTokens >= limits.maxOutputTokensPerTurn) {
            stop = 'token_budget';
            break;
        }
        const started = Date.now();
        let res;
        try {
            res = await planner.plan({
                systemPolicy: `${SYSTEM_POLICY}\n${RESPONSE_POLICY}`,
                sessionContext: options.sessionContext,
                tools,
                messages: conversation,
                maxOutputTokens: Math.min(limits.maxOutputTokensPerCall, limits.maxOutputTokensPerTurn - totals.outputTokens)
            });
        } catch (err) {
            providerError = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : 'unknown provider error';
            stop = 'provider_error';
            break;
        }
        totals = add(totals, res.usage);
        iterations.push({ iteration: i, model: res.model, stop: res.stop, toolCalls: res.toolCalls.length, latencyMs: Date.now() - started, ...res.usage });

        if (res.stop === 'refusal') {
            stop = 'refusal';
            break;
        }
        if (res.stop === 'max_tokens') {
            stop = 'output_truncated';
            break;
        }
        if (res.toolCalls.length === 0) {
            modelText = res.text;
            break;
        }

        conversation.push({ role: 'assistant', text: res.text, toolCalls: res.toolCalls, providerContent: res.providerContent });
        const results: Extract<ConversationMessage, { role: 'tool_results' }>['results'] = [];
        for (const call of res.toolCalls) {
            if (steps.length >= limits.maxToolCalls) {
                stop = 'max_tool_calls';
                break;
            }
            const { step, message } = await adapter.execute(turn, { name: call.name, arguments: call.arguments }, steps.length + 1);
            steps.push(step);
            toolMessages.push(message);
            results.push({ callId: call.id, tool: call.name, content: message.content, isError: step.decision === 'policy_denied' || step.outcome === 'tool_error' });
        }
        conversation.push({ role: 'tool_results', results });
        if (stop === null && iterations.length >= limits.maxModelIterations) stop = 'max_iterations';
    }
    if (stop === null && modelText === null) stop = 'max_iterations';

    if (stop === null) stop = awaitsHuman(steps) ? 'awaiting_approval' : 'completed';

    const reply: AgentTurnResult['reply'] =
        modelText !== null
            ? { ...checkFinalReply(modelText, steps, toolMessages), source: 'model' }
            : { action: 'replaced', violations: [], text: summarizeFromTrace(steps, toolMessages), originalText: '', source: 'fallback' };

    const traceStop: ToolCallTrace['stop_reason'] =
        stop === 'awaiting_approval' || stop === 'completed' ? stop : stop === 'provider_error' || stop === 'refusal' || stop === 'output_truncated' ? 'error' : 'max_steps';
    const trace: ToolCallTrace = { ...traceHeader(turn.turnId, adapter.actorMemberId, adapter.householdId, turn.userUtterance, planner.name), steps, stop_reason: traceStop };
    const result: AgentTurnResult = {
        stop,
        reply,
        trace,
        modelIterations: iterations.length,
        usage: { iterations, totals, estimatedCostUsd: estimateCostUsd(planner.model, totals) },
        providerError
    };
    if (options.usageLogPath) writeUsageLog(options.usageLogPath, planner, turn.turnId, result);
    return result;
}

function writeUsageLog(path: string, planner: ModelPlanner, turnId: string, r: AgentTurnResult): void {
    mkdirSync(dirname(path), { recursive: true });
    const entry = {
        at: new Date().toISOString(),
        turn_id: turnId,
        planner: planner.name,
        model: planner.model,
        stop: r.stop,
        model_iterations: r.modelIterations,
        tool_calls: r.trace.steps.length,
        policy_denials: r.trace.steps.filter(s => s.decision === 'policy_denied').length,
        reply_action: r.reply.action,
        usage: r.usage.totals,
        estimated_cost_usd: r.usage.estimatedCostUsd
    };
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

export { readEnvelope };
