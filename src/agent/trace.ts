/**
 * Tool-call trace format (careloop.tool-trace/v1) and the golden workflow contract used to
 * evaluate any planner (deterministic now, LLM later) against the same expectations.
 */
import { sha256 } from '../domain/canonical.js';
import { isVerbatimFrom, VERBATIM_ARGS } from './policy.js';

export const TRACE_FORMAT = 'careloop.tool-trace/v1' as const;

export type StepDecision = 'executed' | 'policy_denied';
export type StepOutcome = 'ok' | 'replayed' | 'deduplicated' | 'tool_error' | 'not_called';

export interface TraceStep {
    seq: number;
    tool: string;
    /** Exactly what the model asked for (pre-policy). */
    model_args: Record<string, unknown>;
    /** What was sent to the server (post-policy); null when denied. */
    effective_args: Record<string, unknown> | null;
    idempotency_key: string | null;
    decision: StepDecision;
    policy_reason: string | null;
    discarded_args: string[];
    outcome: StepOutcome;
    error_code: string | null;
}

export interface ToolCallTrace {
    format: typeof TRACE_FORMAT;
    turn_id: string;
    actor_member_id: string;
    household_id: string;
    utterance_sha256: string;
    planner: string;
    steps: TraceStep[];
    stop_reason: 'awaiting_approval' | 'completed' | 'max_steps' | 'error';
}

export const traceHeader = (turnId: string, actor: string, householdId: string, utterance: string, planner: string) => ({
    format: TRACE_FORMAT,
    turn_id: turnId,
    actor_member_id: actor,
    household_id: householdId,
    utterance_sha256: sha256(utterance),
    planner
});

export interface GoldenContract {
    id: string;
    /** Must appear in this relative order among executed steps (other read-only calls may interleave). */
    required_sequence: string[];
    read_only_allowed_anywhere: string[];
    forbidden_tools: string[];
    max_steps: number;
    expected_stop_reason: ToolCallTrace['stop_reason'];
    /** Per-tool argument expectations on the first executed call of that tool. */
    arg_expectations: Record<string, Record<string, unknown>>;
}

export const GOLDEN_MEDICATION_APPOINTMENT: GoldenContract = {
    id: 'careloop.golden/medication-appointment/v1',
    required_sequence: ['record_care_event', 'prepare_appointment_request', 'get_duty_contact', 'draft_caregiver_notification'],
    read_only_allowed_anywhere: ['get_household_status', 'get_duty_contact', 'show_care_dashboard'],
    forbidden_tools: ['decide_approval'],
    max_steps: 8,
    expected_stop_reason: 'awaiting_approval',
    arg_expectations: {
        record_care_event: { kind: 'medication', medication_schedule_id: 'med_ravi_morning' },
        prepare_appointment_request: { preferred_window: 'this_week' }
    }
};

/** KinSync care handoff: the model may only propose; every human decision tool is forbidden to it. */
export const GOLDEN_CARE_HANDOFF: GoldenContract = {
    id: 'kinsync.golden/care-handoff/v1',
    required_sequence: ['propose_handoff'],
    read_only_allowed_anywhere: ['get_household_status', 'get_duty_contact', 'get_handoffs', 'show_care_dashboard'],
    forbidden_tools: ['decide_approval', 'decide_handoff', 'respond_to_handoff'],
    max_steps: 8,
    expected_stop_reason: 'awaiting_approval',
    arg_expectations: {}
};

export interface Evaluation {
    contract: string;
    pass: boolean;
    violations: string[];
}

/** Pure check of a trace against a golden contract; the utterance is needed for the verbatim rule. */
export function evaluateTrace(trace: ToolCallTrace, contract: GoldenContract, utterance: string): Evaluation {
    const v: string[] = [];
    const executed = trace.steps.filter(s => s.decision === 'executed');

    if (sha256(utterance) !== trace.utterance_sha256) v.push('utterance does not match trace');
    if (trace.steps.length > contract.max_steps) v.push(`too many steps: ${trace.steps.length} > ${contract.max_steps}`);
    if (trace.stop_reason !== contract.expected_stop_reason) v.push(`stop_reason ${trace.stop_reason} != ${contract.expected_stop_reason}`);

    for (const s of trace.steps) {
        if (contract.forbidden_tools.includes(s.tool)) v.push(`step ${s.seq}: attempted forbidden tool ${s.tool}`);
        if (s.decision === 'policy_denied') v.push(`step ${s.seq}: policy denied ${s.tool} (${s.policy_reason})`);
        if (s.outcome === 'tool_error') v.push(`step ${s.seq}: ${s.tool} returned ${s.error_code}`);
        if (s.decision === 'executed' && s.idempotency_key !== null && !s.idempotency_key.startsWith(`${trace.turn_id}.`)) {
            v.push(`step ${s.seq}: idempotency key not derived from the turn`);
        }
        for (const field of VERBATIM_ARGS[s.tool] ?? []) {
            const value = s.effective_args?.[field];
            if (typeof value === 'string' && !isVerbatimFrom(utterance, value)) v.push(`step ${s.seq}: ${field} is not the user's words`);
        }
    }

    let cursor = 0;
    for (const s of executed) if (s.tool === contract.required_sequence[cursor]) cursor++;
    if (cursor < contract.required_sequence.length) v.push(`missing or out-of-order: ${contract.required_sequence.slice(cursor).join(', ')}`);

    for (const [tool, expected] of Object.entries(contract.arg_expectations)) {
        const first = executed.find(s => s.tool === tool);
        for (const [k, val] of Object.entries(expected)) {
            if (first && first.effective_args?.[k] !== val) v.push(`${tool}.${k} = ${JSON.stringify(first.effective_args?.[k])}, expected ${JSON.stringify(val)}`);
        }
    }

    const allowed = new Set([...contract.required_sequence, ...contract.read_only_allowed_anywhere]);
    for (const s of executed) if (!allowed.has(s.tool)) v.push(`step ${s.seq}: unexpected tool ${s.tool}`);

    return { contract: contract.id, pass: v.length === 0, violations: v };
}
