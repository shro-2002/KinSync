/**
 * AgentAdapter: the only path by which a (future, untrusted) model reaches CareLoop tools.
 * Code-enforced, independent of anything the model or stored data says:
 *  - allowlist (decide_approval is human-only), max calls per turn
 *  - household_id and idempotency_key are application-controlled (model values discarded)
 *  - actor comes from the MCP session header set when the adapter connects
 *  - "own words" fields must appear in the user's utterance
 *  - every tool result is returned to the model as a JSON envelope marked untrusted_data
 */
import type { Client } from '@modelcontextprotocol/client';

import { connect } from '../client.js';
import {
    AGENT_TOOL_ALLOWLIST,
    APP_CONTROLLED_ARGS,
    deriveIdempotencyKey,
    HUMAN_ONLY_TOOLS,
    isVerbatimFrom,
    MAX_TOOL_CALLS_PER_TURN,
    MODEL_TOOL_DESCRIPTIONS,
    modelFacingSchema,
    type AgentTool,
    VERBATIM_ARGS,
    WRITE_TOOLS
} from './policy.js';
import { traceHeader, type ToolCallTrace, type TraceStep } from './trace.js';

export interface TurnContext {
    /** Application-generated (newTurnId); reused when the same user turn is retried. */
    turnId: string;
    userUtterance: string;
}

export interface ModelToolCall {
    name: string;
    arguments?: unknown;
}

/** What the model receives back for each call. `content` is always a JSON envelope string. */
export interface ModelToolMessage {
    role: 'tool';
    tool: string;
    content: string;
}

export interface Planner {
    readonly name: string;
    next(input: { utterance: string; messages: readonly ModelToolMessage[] }): ModelToolCall | { done: true };
}

export interface ModelTool {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}

type Json = Record<string, unknown>;

export class AgentAdapter {
    private constructor(
        private readonly client: Client,
        readonly actorMemberId: string,
        readonly householdId: string
    ) {}

    /** The application (not the model) decides who is speaking and which household this is. */
    static async open(url: string, session: { actorMemberId: string; householdId: string }): Promise<AgentAdapter> {
        const { client } = await connect(url, { actor: session.actorMemberId });
        return new AgentAdapter(client, session.actorMemberId, session.householdId);
    }

    close(): Promise<void> {
        return this.client.close();
    }

    /** Tool list for the model: allowlisted tools only, application-controlled arguments removed. */
    async listModelTools(): Promise<ModelTool[]> {
        const { tools } = await this.client.listTools();
        return tools
            .filter(t => (AGENT_TOOL_ALLOWLIST as readonly string[]).includes(t.name))
            .map(t => ({ name: t.name, description: MODEL_TOOL_DESCRIPTIONS[t.name as AgentTool], input_schema: modelFacingSchema(t.inputSchema as Json) }));
    }

    async runTurn(turn: TurnContext, planner: Planner): Promise<{ trace: ToolCallTrace; messages: ModelToolMessage[] }> {
        const steps: TraceStep[] = [];
        const messages: ModelToolMessage[] = [];
        let stop: ToolCallTrace['stop_reason'] = 'max_steps';
        try {
            while (steps.length < MAX_TOOL_CALLS_PER_TURN) {
                const next = planner.next({ utterance: turn.userUtterance, messages });
                if ('done' in next) {
                    stop = awaitsHuman(steps) ? 'awaiting_approval' : 'completed';
                    break;
                }
                const { step, message } = await this.execute(turn, next, steps.length + 1);
                steps.push(step);
                messages.push(message);
            }
        } catch {
            stop = 'error';
        }
        return { trace: { ...traceHeader(turn.turnId, this.actorMemberId, this.householdId, turn.userUtterance, planner.name), steps, stop_reason: stop }, messages };
    }

    /** Applies policy to one model tool call, executes it if allowed, and records the step. */
    async execute(turn: TurnContext, call: ModelToolCall, seq: number): Promise<{ step: TraceStep; message: ModelToolMessage }> {
        const modelArgs: Json = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? { ...(call.arguments as Json) } : {};
        const base = { seq, tool: call.name, model_args: modelArgs };
        const deny = (reason: string) => ({
            step: { ...base, effective_args: null, idempotency_key: null, decision: 'policy_denied' as const, policy_reason: reason, discarded_args: [], outcome: 'not_called' as const, error_code: null },
            message: envelope(call.name, { error: { code: 'POLICY_DENIED', reason } }, 'policy')
        });

        if ((HUMAN_ONLY_TOOLS as readonly string[]).includes(call.name)) return deny('HUMAN_ONLY_TOOL');
        if (!(AGENT_TOOL_ALLOWLIST as readonly string[]).includes(call.name)) return deny('TOOL_NOT_ALLOWED');

        const discarded = APP_CONTROLLED_ARGS.filter(k => k in modelArgs);
        const effective: Json = { ...modelArgs, household_id: this.householdId };
        delete effective.idempotency_key;
        delete effective.simulated_actor_id;

        // No field in this system's schemas treats "" as a meaningful value (ids and free-text
        // fields both require at least one character), so an empty-string placeholder a model
        // sends for an optional field is never real content — normalize it to "omitted" rather
        // than failing the call with a confusing schema or verbatim error.
        for (const field of Object.keys(effective)) if (effective[field] === '') delete effective[field];

        for (const field of VERBATIM_ARGS[call.name] ?? []) {
            const value = effective[field];
            if (value !== undefined && (typeof value !== 'string' || !isVerbatimFrom(turn.userUtterance, value))) return deny(`VERBATIM_REQUIRED:${field}`);
        }

        let key: string | null = null;
        if (WRITE_TOOLS.has(call.name)) {
            key = deriveIdempotencyKey(turn.turnId, call.name, effective);
            effective.idempotency_key = key;
        }

        const res = await this.client.callTool({ name: call.name, arguments: effective });
        const data = (res.structuredContent ?? safeJson((res.content as Array<{ text?: string }>)?.[0]?.text)) as Json;
        const error = res.isError ? ((data?.error as { code?: string }) ?? { code: 'UNKNOWN' }) : null;
        const outcome = error ? 'tool_error' : data?.replayed ? 'replayed' : data?.deduplicated ? 'deduplicated' : 'ok';
        return {
            step: { ...base, effective_args: effective, idempotency_key: key, decision: 'executed', policy_reason: null, discarded_args: discarded, outcome, error_code: error?.code ?? null },
            message: envelope(call.name, error ? { error } : data, 'untrusted_data')
        };
    }
}

/** A turn that created a draft or a handoff proposal ends waiting for a human decision. */
export const awaitsHuman = (steps: readonly TraceStep[]): boolean =>
    steps.some(s => ['draft_caregiver_notification', 'propose_handoff'].includes(s.tool) && s.decision === 'executed' && s.outcome !== 'tool_error');

/** Tool output is serialized as data inside a fixed envelope; it is never spliced into instructions. */
export function envelope(tool: string, payload: unknown, trust: 'untrusted_data' | 'policy'): ModelToolMessage {
    return { role: 'tool', tool, content: JSON.stringify({ trust, source: 'careloop', tool, payload }) };
}

export function readEnvelope(message: ModelToolMessage): { trust: string; tool: string; payload: Json } {
    return JSON.parse(message.content) as { trust: string; tool: string; payload: Json };
}

function safeJson(text: string | undefined): unknown {
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        return { error: { code: 'NON_JSON_TOOL_RESULT', message: text?.slice(0, 200) } };
    }
}
