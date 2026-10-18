/**
 * Deterministic orchestration of the core workflow over real MCP tool calls.
 * This is the slot a future LLM planner fills: same tools, same order, same idempotency
 * keys, but here the plan is fixed code so behaviour is reproducible and testable.
 *
 * Parent says: "I took my morning medicines. Can you help me get a doctor's appointment for my knee?"
 * Plan: record event -> prepare appointment request -> find duty contact -> draft notification
 *       -> confirm a pending approval exists -> STOP (a human must approve).
 */
import type { Client } from '@modelcontextprotocol/client';

export interface ScenarioInput {
    householdId: string;
    /** Stable id for this conversation turn; idempotency keys derive from it, so re-running is safe. */
    runId: string;
    medicationScheduleId: string;
    medicationNote: string;
    appointmentReason: string;
    preferredWindow: 'asap_non_urgent' | 'this_week' | 'next_week';
    providerLabel?: string;
}

export interface ScenarioStep {
    step: number;
    tool: string;
    arguments: Record<string, unknown>;
    isError: boolean;
    result: Record<string, unknown>;
}

export interface ScenarioOutcome {
    status: 'awaiting_approval';
    steps: ScenarioStep[];
    eventId: string;
    appointmentRequestId: string;
    draftId: string;
    approvalId: string;
    dutyContact: string;
    replayed: boolean[];
}

export class ScenarioError extends Error {
    constructor(
        message: string,
        readonly steps: ScenarioStep[]
    ) {
        super(message);
        this.name = 'ScenarioError';
    }
}

export const DEMO_SCENARIO: ScenarioInput = {
    householdId: 'hh_rao',
    runId: 'demo-turn-0001',
    medicationScheduleId: 'med_ravi_morning',
    medicationNote: 'I took my morning medicines.',
    appointmentReason: 'My knee has been hurting for a few days and I would like to see the doctor.',
    preferredWindow: 'this_week',
    providerLabel: 'Family physician (synthetic)'
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function runMedicationAppointmentScenario(client: Client, input: ScenarioInput): Promise<ScenarioOutcome> {
    const steps: ScenarioStep[] = [];
    const call = async (tool: string, args: Record<string, unknown>): Promise<Json> => {
        const res = await client.callTool({ name: tool, arguments: args });
        const result = (res.structuredContent ?? JSON.parse((res.content as Array<{ text: string }>)[0]!.text)) as Json;
        steps.push({ step: steps.length + 1, tool, arguments: args, isError: res.isError === true, result });
        if (res.isError) throw new ScenarioError(`${tool} failed: ${JSON.stringify(result.error)}`, steps);
        return result;
    };
    const hh = input.householdId;
    const key = (part: string) => `${input.runId}:${part}`;

    const recorded = await call('record_care_event', {
        household_id: hh,
        idempotency_key: key('medication-report'),
        kind: 'medication',
        medication_schedule_id: input.medicationScheduleId,
        note: input.medicationNote
    });
    const eventId = recorded.event.id as string;

    const prepared = await call('prepare_appointment_request', {
        household_id: hh,
        idempotency_key: key('appointment-request'),
        reason_as_reported: input.appointmentReason,
        preferred_window: input.preferredWindow,
        ...(input.providerLabel ? { provider_label: input.providerLabel } : {}),
        related_event_id: eventId
    });
    const appointmentRequestId = prepared.appointment_request.id as string;

    const duty = await call('get_duty_contact', { household_id: hh });

    const drafted = await call('draft_caregiver_notification', {
        household_id: hh,
        idempotency_key: key('notify-duty-contact'),
        appointment_request_id: appointmentRequestId,
        related_event_id: eventId,
        recipient_member_id: duty.contact.member_id
    });

    const status = await call('get_household_status', { household_id: hh });
    const approvalId = drafted.approval.id as string;
    if (!(status.pending_approvals as Json[]).some(a => a.approval_id === approvalId)) {
        throw new ScenarioError(`approval ${approvalId} is not pending`, steps);
    }

    return {
        status: 'awaiting_approval',
        steps,
        eventId,
        appointmentRequestId,
        draftId: drafted.draft.id,
        approvalId,
        dutyContact: duty.contact.name,
        replayed: [recorded.replayed, prepared.replayed, drafted.replayed]
    };
}
