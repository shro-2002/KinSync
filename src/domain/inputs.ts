/**
 * Tool input contracts, shared by the MCP layer (inputSchema) and the domain service
 * (which re-validates, so the domain is safe even when called outside MCP).
 */
import * as z from 'zod/v4';

import { HANDOFF_STATUSES } from './handoff-state.js';
import { APPOINTMENT_WINDOWS, APPROVAL_DECISIONS, EVENT_KINDS } from './types.js';

const id = z.string().trim().min(1).max(64).regex(/^[a-z0-9_]+$/, 'lowercase id');
// Looser than `id`: accepts either a real member_id or a member's exact display name (e.g. a
// model that never called get_household_status first and quoted a name instead of an id).
// Resolved server-side against the actual household roster in CareService.subjectOrDefault;
// an unmatched reference is still a NOT_FOUND, so nothing is ever trusted or fabricated.
const memberRef = z.string().trim().min(1).max(64);
const idempotencyKey = z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/, 'letters, digits and . _ : - only')
    .describe('client-chosen key; reuse the same key when retrying the same action');
const freeText = (max: number) => z.string().trim().min(1).max(max);

export const householdIdField = id.describe('household the action applies to');

export const recordCareEventInput = z.object({
    household_id: householdIdField,
    idempotency_key: idempotencyKey,
    kind: z.enum(EVENT_KINDS).describe('what the person is reporting'),
    note: freeText(500).describe("the person's own words; stored verbatim, never interpreted"),
    subject_member_id: memberRef.optional().describe('who the event is about (member_id or exact display name); defaults to the household care recipient'),
    medication_schedule_id: id.optional().describe('for kind=medication: which user-entered schedule entry this report refers to'),
    occurred_at: z.iso.datetime({ offset: true }).optional().describe('when it happened; defaults to now')
});

export const householdOnlyInput = z.object({ household_id: householdIdField });

export const dashboardInput = z.object({ household_id: householdIdField.optional().describe("defaults to the actor's household") });

export const dutyContactInput = z.object({
    household_id: householdIdField,
    date: z.iso.date().optional().describe('YYYY-MM-DD in the household time zone; defaults to today')
});

export const prepareAppointmentRequestInput = z.object({
    household_id: householdIdField,
    idempotency_key: idempotencyKey,
    reason_as_reported: freeText(300).describe("the person's own words for why they want an appointment; not a diagnosis"),
    preferred_window: z.enum(APPOINTMENT_WINDOWS),
    provider_label: freeText(80).optional().describe('e.g. "family physician"; free text, nothing is booked'),
    related_event_id: id.optional(),
    subject_member_id: memberRef.optional().describe('who the appointment is for (member_id or exact display name); defaults to the household care recipient')
});

export const draftNotificationInput = z.object({
    household_id: householdIdField,
    idempotency_key: idempotencyKey,
    appointment_request_id: id.optional(),
    related_event_id: id.optional(),
    recipient_member_id: id.optional().describe("defaults to today's duty contact"),
    extra_note: freeText(200).optional().describe("optional words from the actor, quoted and attributed in the draft")
});

export const decideApprovalInput = z.object({
    household_id: householdIdField,
    idempotency_key: idempotencyKey,
    approval_id: id,
    decision: z.enum(APPROVAL_DECISIONS),
    reason: freeText(200).optional()
});

export const HANDOFF_DECISIONS = ['approve', 'reject'] as const;
export const HANDOFF_RESPONSES = ['accept', 'decline'] as const;

export const proposeHandoffInput = z.object({
    household_id: householdIdField,
    idempotency_key: idempotencyKey,
    task_description: freeText(300).describe("the person's own words about the care task they need help with; stored verbatim, never interpreted"),
    proposed_recipient: memberRef
        .optional()
        .describe('household member who would take over (member_id or exact display name); must be a coordinator or caregiver other than the current duty contact. Omit only if exactly one such member exists')
});

export const getHandoffsInput = z.object({ household_id: householdIdField, status: z.enum(HANDOFF_STATUSES).optional() });

export const decideHandoffInput = z.object({
    household_id: householdIdField,
    idempotency_key: idempotencyKey,
    handoff_id: id,
    decision: z.enum(HANDOFF_DECISIONS),
    reason: freeText(200).optional()
});

export const respondToHandoffInput = z.object({
    household_id: householdIdField,
    idempotency_key: idempotencyKey,
    handoff_id: id,
    response: z.enum(HANDOFF_RESPONSES),
    reason: freeText(200).optional()
});

// Demo-only identity switch for the two human-decision tools. The domain schemas above ignore it; the session layer
// (CareService.resolveSessionActor) honors it only on a simulation-enabled server, in the session actor's household.
const simulatedActor = { simulated_actor_id: id.optional().describe('DEMO ONLY: member to act as; ignored unless the server runs in simulated-actor mode') };
export const decideHandoffToolInput = decideHandoffInput.extend(simulatedActor);
export const respondToHandoffToolInput = respondToHandoffInput.extend(simulatedActor);

export type ProposeHandoffInput = z.infer<typeof proposeHandoffInput>;
export type GetHandoffsInput = z.infer<typeof getHandoffsInput>;
export type DecideHandoffInput = z.infer<typeof decideHandoffInput>;
export type RespondToHandoffInput = z.infer<typeof respondToHandoffInput>;
export type RecordCareEventInput = z.infer<typeof recordCareEventInput>;
export type DutyContactInput = z.infer<typeof dutyContactInput>;
export type PrepareAppointmentRequestInput = z.infer<typeof prepareAppointmentRequestInput>;
export type DraftNotificationInput = z.infer<typeof draftNotificationInput>;
export type DecideApprovalInput = z.infer<typeof decideApprovalInput>;
export type DashboardInput = z.infer<typeof dashboardInput>;
