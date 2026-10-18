/**
 * Deterministic stand-in for an LLM planner. It talks to AgentAdapter exactly as a model
 * would (tool name + model arguments, reading JSON envelopes back), so its trace is the
 * golden reference for future model evaluation.
 */
import { readEnvelope, type ModelToolCall, type ModelToolMessage, type Planner } from './adapter.js';
import { ZERO_USAGE, type ModelPlanner, type PlannerRequest, type PlannerResponse } from './model.js';
import { summarizeFromTrace } from './output-safety.js';
import type { TraceStep } from './trace.js';

export const GOLDEN_UTTERANCE =
    "I took my morning medicines. Can you help me get a doctor's appointment? My knee has been hurting for a few days.";

const payloadOf = (messages: readonly ModelToolMessage[], tool: string) => {
    const m = messages.find(x => x.tool === tool);
    return m ? (readEnvelope(m).payload as Record<string, any>) : undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export class DeterministicPlanner implements Planner {
    readonly name = 'deterministic/medication-appointment/v1';

    next({ messages }: { utterance: string; messages: readonly ModelToolMessage[] }): ModelToolCall | { done: true } {
        const event = payloadOf(messages, 'record_care_event');
        const request = payloadOf(messages, 'prepare_appointment_request');
        const duty = payloadOf(messages, 'get_duty_contact');
        const draft = payloadOf(messages, 'draft_caregiver_notification');

        if (!event) {
            return { name: 'record_care_event', arguments: { kind: 'medication', medication_schedule_id: 'med_ravi_morning', note: 'I took my morning medicines' } };
        }
        if (!request) {
            return {
                name: 'prepare_appointment_request',
                arguments: { reason_as_reported: 'My knee has been hurting for a few days', preferred_window: 'this_week', related_event_id: event.event?.id }
            };
        }
        if (!duty) return { name: 'get_duty_contact', arguments: {} };
        if (!draft) {
            return {
                name: 'draft_caregiver_notification',
                arguments: { appointment_request_id: request.appointment_request?.id, related_event_id: event.event?.id, recipient_member_id: duty.contact?.member_id }
            };
        }
        return { done: true };
    }
}

/**
 * DeterministicPlanner exposed through the provider-neutral ModelPlanner contract: free,
 * offline, reproducible. Same tool sequence; final reply built only from confirmed results.
 */
export class DeterministicModelPlanner implements ModelPlanner {
    readonly name = 'deterministic/model-planner/v1';
    readonly model = 'deterministic';
    private readonly inner = new DeterministicPlanner();

    async plan(req: PlannerRequest): Promise<PlannerResponse> {
        const toolMessages: ModelToolMessage[] = req.messages.flatMap(m =>
            m.role === 'tool_results' ? m.results.map(r => ({ role: 'tool' as const, tool: r.tool, content: r.content })) : []
        );
        const next = this.inner.next({ utterance: '', messages: toolMessages });
        if ('done' in next) {
            return { text: summarizeFromTrace(stepsFromMessages(toolMessages), toolMessages), toolCalls: [], stop: 'end_turn', usage: ZERO_USAGE, model: this.model };
        }
        return { text: '', toolCalls: [{ id: `det_${toolMessages.length + 1}`, name: next.name, arguments: next.arguments }], stop: 'tool_use', usage: ZERO_USAGE, model: this.model };
    }
}

// Minimal step view for the summary: success = envelope without an error payload.
export function stepsFromMessages(messages: readonly ModelToolMessage[]): TraceStep[] {
    return messages.map((m, i) => {
        const env = readEnvelope(m);
        const ok = env.trust === 'untrusted_data' && !('error' in env.payload);
        return {
            seq: i + 1,
            tool: m.tool,
            model_args: {},
            effective_args: null,
            idempotency_key: null,
            decision: env.trust === 'policy' ? 'policy_denied' : 'executed',
            policy_reason: null,
            discarded_args: [],
            outcome: ok ? 'ok' : 'tool_error',
            error_code: ok ? null : String((env.payload.error as { code?: string })?.code ?? 'UNKNOWN')
        };
    });
}
