import type { DatabaseSync } from 'node:sqlite';

import type * as z from 'zod/v4';

import { authorize, type Operation } from './authz.js';
import { sha256, stableStringify } from './canonical.js';
import { DomainError } from './errors.js';
import { applyDecision, applyPropose, applyResponse, handoffViews, HANDOFF_NOTICE } from './handoffs.js';
import * as inputs from './inputs.js';
import { Queries } from './queries.js';
import { dutyContact, statusView } from './status.js';
import { EMERGENCY_NOTICE, localDate, localTime, renderNotificationDraft, SAFETY_NOTICE } from './safety.js';
import type { Actor, Member } from './types.js';

const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const SIMILAR_EVENT_WINDOW_MIN = 10;

export interface ServiceOptions {
    now?: () => Date;
    /** Test hook: called inside a write transaction right before commit. Throwing simulates a crash. */
    faultInjector?: (point: string) => void;
}

type Mutation = Extract<
    Operation,
    'record_care_event' | 'prepare_appointment_request' | 'draft_caregiver_notification' | 'decide_approval' | 'propose_handoff' | 'decide_handoff' | 'respond_to_handoff'
>;

/** Human-only operations that may be performed as a demo "simulated actor" (and only then; see resolveSessionActor). */
const SIMULATABLE_OPS: ReadonlySet<Operation> = new Set(['decide_handoff', 'respond_to_handoff']);

export class CareService {
    readonly q: Queries;
    private readonly now: () => Date;
    private readonly fault: (point: string) => void;

    constructor(
        private readonly db: DatabaseSync,
        options: ServiceOptions = {}
    ) {
        this.q = new Queries(db);
        this.now = options.now ?? (() => new Date());
        this.fault = options.faultInjector ?? (() => {});
    }

    resolveActor(memberId: string | undefined): Actor {
        if (!memberId) throw new DomainError('UNAUTHENTICATED_SESSION', 'No synthetic actor is bound to this session (send X-CareLoop-Actor)');
        const m = this.q.member(memberId);
        if (!m) throw new DomainError('UNKNOWN_ACTOR', `Unknown actor ${memberId}`);
        return { memberId: m.id, householdId: m.householdId, role: m.role, displayName: m.displayName };
    }

    /**
     * resolveActor plus an audit row when the session has no actor or an unknown one.
     * The household column is filled only with an existing household id, never with raw input.
     * `allowSimulation` is a server-side switch (never a tool argument): only then may a human-decision
     * call carry simulated_actor_id, and only for a member of the session actor's own household.
     */
    resolveSessionActor(memberId: string | undefined, op: Operation, rawArgs: unknown, allowSimulation = false): Actor {
        let session: Actor;
        try {
            session = this.resolveActor(memberId);
        } catch (err) {
            const claimed = (rawArgs as { household_id?: unknown } | null)?.household_id;
            const householdId = typeof claimed === 'string' && this.q.household(claimed) ? claimed : null;
            this.audit(null, householdId, op, null, 'denied', { code: (err as DomainError).code });
            throw err;
        }
        const requested = (rawArgs as { simulated_actor_id?: unknown } | null)?.simulated_actor_id;
        if (requested === undefined || !SIMULATABLE_OPS.has(op)) return session;
        return this.simulateActor(session, requested, op, allowSimulation);
    }

    private simulateActor(session: Actor, requested: unknown, op: Operation, allowSimulation: boolean): Actor {
        const deny = (reason: string): never => {
            this.audit(session, session.householdId, op, null, 'denied', { reason, requested_simulated_actor: typeof requested === 'string' ? requested.slice(0, 64) : null });
            throw new DomainError('FORBIDDEN', 'Simulated actor not allowed', { reason });
        };
        if (!allowSimulation) return deny('simulation_disabled');
        // One reason for "unknown" and "other household" so existence never leaks across households.
        const target = typeof requested === 'string' ? this.q.memberInHousehold(session.householdId, requested) : undefined;
        if (!target) return deny('simulated_actor_not_in_household');
        return { memberId: target.id, householdId: target.householdId, role: target.role, displayName: target.displayName, simulatedBy: session.memberId };
    }

    // ---------- reads ----------

    getHouseholdStatus(actor: Actor, raw: unknown) {
        const input = this.parse(inputs.householdOnlyInput, raw, actor, 'get_household_status');
        this.guard(actor, input.household_id, 'get_household_status');
        return statusView(this.q, this.now(), input.household_id);
    }

    showDashboard(actor: Actor, raw: unknown) {
        const input = this.parse(inputs.dashboardInput, raw, actor, 'show_care_dashboard');
        const householdId = input.household_id ?? actor.householdId;
        this.guard(actor, householdId, 'show_care_dashboard');
        const status = statusView(this.q, this.now(), householdId);
        const counts = this.q.eventCounts(householdId);
        return {
            ...status,
            household: status.household.name,
            householdId,
            generatedAt: status.generated_at,
            total: Object.values(counts).reduce((a, b) => a + b, 0),
            counts,
            events: status.recent_events.map(e => ({ id: e.id, kind: e.kind, note: e.note, createdAt: e.occurred_at })),
            handoffs: handoffViews(this.q, householdId)
        };
    }

    getHandoffs(actor: Actor, raw: unknown) {
        const input = this.parse(inputs.getHandoffsInput, raw, actor, 'get_handoffs');
        this.guard(actor, input.household_id, 'get_handoffs');
        return { handoffs: handoffViews(this.q, input.household_id, input.status), notice: HANDOFF_NOTICE };
    }

    getDutyContact(actor: Actor, raw: unknown) {
        const input = this.parse(inputs.dutyContactInput, raw, actor, 'get_duty_contact');
        this.guard(actor, input.household_id, 'get_duty_contact');
        return dutyContact(this.q, this.now(), input.household_id, input.date);
    }

    // ---------- writes ----------

    recordCareEvent(actor: Actor, raw: unknown) {
        const input = this.parse(inputs.recordCareEventInput, raw, actor, 'record_care_event');
        return this.mutate(actor, 'record_care_event', input, id => {
            const hh = input.household_id;
            const subject = this.subjectOrDefault(hh, input.subject_member_id);
            if (input.medication_schedule_id) {
                if (input.kind !== 'medication') throw new DomainError('INVALID_INPUT', 'medication_schedule_id is only valid for kind=medication');
                const schedule = this.q.medicationSchedule(hh, input.medication_schedule_id);
                if (!schedule || schedule.memberId !== subject.id) throw new DomainError('NOT_FOUND', `Medication schedule ${input.medication_schedule_id} not found for ${subject.displayName}`);
            }
            const now = this.now().toISOString();
            const occurredAt = input.occurred_at ? new Date(input.occurred_at).toISOString() : now;
            if (Date.parse(occurredAt) > this.now().getTime() + MAX_FUTURE_SKEW_MS) throw new DomainError('INVALID_INPUT', 'occurred_at is in the future');

            // Advisory only: a similar report shortly before/after is flagged, never merged, so a genuine
            // second report is always stored. Exact retries are handled by turn-derived idempotency keys.
            const similar = this.db
                .prepare(
                    'SELECT id FROM care_events WHERE household_id = ? AND subject_member_id = ? AND kind = ? AND note = ? AND medication_schedule_id IS ? AND ABS(julianday(occurred_at) - julianday(?)) * 1440 <= ? ORDER BY occurred_at LIMIT 1'
                )
                .get(hh, subject.id, input.kind, input.note, input.medication_schedule_id ?? null, occurredAt, SIMILAR_EVENT_WINDOW_MIN) as { id: string } | undefined;
            this.db
                .prepare(
                    'INSERT INTO care_events (id, household_id, subject_member_id, reported_by_member_id, kind, note, medication_schedule_id, occurred_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
                )
                .run(id('evt'), hh, subject.id, actor.memberId, input.kind, input.note, input.medication_schedule_id ?? null, occurredAt, now);
            return { event: this.q.event(hh, id('evt'))!, deduplicated: false, possible_duplicate_of: similar?.id ?? null, safety_notice: SAFETY_NOTICE };
        });
    }

    prepareAppointmentRequest(actor: Actor, raw: unknown) {
        const input = this.parse(inputs.prepareAppointmentRequestInput, raw, actor, 'prepare_appointment_request');
        return this.mutate(actor, 'prepare_appointment_request', input, id => {
            const hh = input.household_id;
            const subject = this.subjectOrDefault(hh, input.subject_member_id);
            if (input.related_event_id && !this.q.event(hh, input.related_event_id)) throw new DomainError('NOT_FOUND', `Event ${input.related_event_id} not found`);

            // Natural-key dedupe: a retry with a fresh key must not create a second open request.
            const reason = input.reason_as_reported.toLowerCase();
            const existing = this.q.openAppointments(hh).find(a => a.subjectMemberId === subject.id && a.reasonAsReported.toLowerCase() === reason);
            if (existing) return { appointment_request: existing, deduplicated: true, nothing_booked: true, emergency_notice: EMERGENCY_NOTICE };

            const now = this.now().toISOString();
            this.db
                .prepare(
                    "INSERT INTO appointment_requests (id, household_id, subject_member_id, requested_by_member_id, reason_as_reported, preferred_window, provider_label, related_event_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)"
                )
                .run(id('apt'), hh, subject.id, actor.memberId, input.reason_as_reported, input.preferred_window, input.provider_label ?? null, input.related_event_id ?? null, now, now);
            return { appointment_request: this.q.appointment(hh, id('apt'))!, deduplicated: false, nothing_booked: true, emergency_notice: EMERGENCY_NOTICE };
        });
    }

    draftCaregiverNotification(actor: Actor, raw: unknown) {
        const input = this.parse(inputs.draftNotificationInput, raw, actor, 'draft_caregiver_notification');
        return this.mutate(actor, 'draft_caregiver_notification', input, id => {
            const hh = input.household_id;
            if (!input.appointment_request_id && !input.related_event_id) {
                throw new DomainError('INVALID_INPUT', 'Provide appointment_request_id and/or related_event_id');
            }
            const appointment = input.appointment_request_id ? this.q.appointment(hh, input.appointment_request_id) : undefined;
            if (input.appointment_request_id && !appointment) throw new DomainError('NOT_FOUND', `Appointment request ${input.appointment_request_id} not found`);
            const eventId = input.related_event_id ?? appointment?.relatedEventId ?? undefined;
            const event = eventId ? this.q.event(hh, eventId) : undefined;
            if (eventId && !event) throw new DomainError('NOT_FOUND', `Event ${eventId} not found`);

            const recipient = input.recipient_member_id
                ? this.q.memberInHousehold(hh, input.recipient_member_id)
                : this.q.member(dutyContact(this.q, this.now(), hh).contact.member_id);
            if (!recipient) throw new DomainError('NOT_FOUND', `Recipient ${input.recipient_member_id} not found`);

            // Natural-key dedupe: one live draft per recipient per appointment request (or per event when there is no request).
            const live = (
                appointment
                    ? this.db
                          .prepare("SELECT id FROM notification_drafts WHERE household_id = ? AND recipient_member_id = ? AND appointment_request_id = ? AND status != 'rejected'")
                          .get(hh, recipient.id, appointment.id)
                    : this.db
                          .prepare(
                              "SELECT id FROM notification_drafts WHERE household_id = ? AND recipient_member_id = ? AND appointment_request_id IS NULL AND related_event_id = ? AND status != 'rejected'"
                          )
                          .get(hh, recipient.id, event!.id)
            ) as { id: string } | undefined;
            if (live) {
                return { draft: this.q.draft(hh, live.id)!, approval: this.q.approvalForTarget(hh, live.id)!, deduplicated: true, sent: false };
            }

            const tz = this.q.household(hh)!.timezone;
            const name = (memberId: string) => this.q.member(memberId)!.displayName;
            const body = renderNotificationDraft({
                recipientName: recipient.displayName,
                actorName: actor.displayName,
                appointment: appointment && {
                    providerLabel: appointment.providerLabel,
                    window: appointment.preferredWindow,
                    reasonAsReported: appointment.reasonAsReported,
                    subjectName: name(appointment.subjectMemberId)
                },
                event: event && {
                    kind: event.kind,
                    note: event.note,
                    reporterName: name(event.reportedByMemberId),
                    occurredAtLocal: `${localDate(new Date(event.occurredAt), tz)} ${localTime(new Date(event.occurredAt), tz)}`
                },
                extraNote: input.extra_note
            });
            const now = this.now().toISOString();
            this.db
                .prepare(
                    "INSERT INTO notification_drafts (id, household_id, recipient_member_id, drafted_by_member_id, appointment_request_id, related_event_id, channel, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'simulated', ?, 'pending_approval', ?, ?)"
                )
                .run(id('ntf'), hh, recipient.id, actor.memberId, appointment?.id ?? null, event?.id ?? null, body, now, now);
            this.db
                .prepare(
                    "INSERT INTO approvals (id, household_id, action_type, target_id, requested_by_member_id, status, created_at) VALUES (?, ?, 'send_notification', ?, ?, 'pending', ?)"
                )
                .run(id('apv'), hh, id('ntf'), actor.memberId, now);
            return { draft: this.q.draft(hh, id('ntf'))!, approval: this.q.approval(hh, id('apv'))!, deduplicated: false, sent: false };
        });
    }

    decideApproval(actor: Actor, raw: unknown) {
        const input = this.parse(inputs.decideApprovalInput, raw, actor, 'decide_approval');
        return this.mutate(actor, 'decide_approval', input, id => {
            const hh = input.household_id;
            const approval = this.q.approval(hh, input.approval_id);
            if (!approval) throw new DomainError('NOT_FOUND', `Approval ${input.approval_id} not found`);
            if (approval.status !== 'pending') {
                throw new DomainError('ALREADY_DECIDED', `Approval ${approval.id} is already ${approval.status}`, { status: approval.status });
            }
            const now = this.now().toISOString();
            const approved = input.decision === 'approve';
            this.db
                .prepare('UPDATE approvals SET status = ?, decided_by_member_id = ?, decision_reason = ?, decided_at = ? WHERE id = ?')
                .run(approved ? 'approved' : 'rejected', actor.memberId, input.reason ?? null, now, approval.id);
            this.db.prepare('UPDATE notification_drafts SET status = ?, updated_at = ? WHERE id = ?').run(approved ? 'approved' : 'rejected', now, approval.targetId);

            let outbox: { id: string; delivery: 'simulated_not_sent' } | null = null;
            if (approved) {
                const draft = this.q.draft(hh, approval.targetId)!;
                // UNIQUE(notification_id) makes a second "send" impossible even if this code is wrong.
                this.db
                    .prepare("INSERT INTO simulated_outbox (id, notification_id, household_id, recipient_member_id, body, delivery, created_at) VALUES (?, ?, ?, ?, ?, 'simulated_not_sent', ?)")
                    .run(id('out'), draft.id, hh, draft.recipientMemberId, draft.body, now);
                if (draft.appointmentRequestId) {
                    this.db.prepare("UPDATE appointment_requests SET status = 'handed_off', updated_at = ? WHERE id = ?").run(now, draft.appointmentRequestId);
                }
                outbox = { id: id('out'), delivery: 'simulated_not_sent' };
            }
            return { approval: this.q.approval(hh, approval.id)!, draft: this.q.draft(hh, approval.targetId)!, outbox, real_message_sent: false };
        });
    }

    proposeHandoff(actor: Actor, raw: unknown) {
        const input = this.parse(inputs.proposeHandoffInput, raw, actor, 'propose_handoff');
        return this.mutate(actor, 'propose_handoff', input, id => applyPropose(this.handoffContext(actor), input, id('hof')));
    }

    /** Human only (care recipient or coordinator, never the proposed recipient). */
    decideHandoff(actor: Actor, raw: unknown) {
        const input = this.parse(inputs.decideHandoffInput, raw, actor, 'decide_handoff');
        return this.mutate(actor, 'decide_handoff', input, () => applyDecision(this.handoffContext(actor), input));
    }

    /** Human only: exactly the proposed recipient. */
    respondToHandoff(actor: Actor, raw: unknown) {
        const input = this.parse(inputs.respondToHandoffInput, raw, actor, 'respond_to_handoff');
        return this.mutate(actor, 'respond_to_handoff', input, () => applyResponse(this.handoffContext(actor), input));
    }

    auditTrail(householdId: string) {
        return this.db.prepare('SELECT at, actor_member_id, action, target_id, outcome, detail FROM audit_events WHERE household_id = ? ORDER BY id').all(householdId) as Array<
            Record<string, string | null>
        >;
    }

    // ---------- internals ----------

    private handoffContext(actor: Actor) {
        return { db: this.db, q: this.q, now: this.now(), actor };
    }

    private subjectOrDefault(householdId: string, subjectRef: string | undefined): Member {
        if (subjectRef) {
            const m = this.resolveMember(householdId, subjectRef);
            if (!m || m.role !== 'care_recipient') throw new DomainError('NOT_FOUND', `Care recipient ${subjectRef} not found`);
            return m;
        }
        const recipients = this.q.careRecipients(householdId);
        if (recipients.length !== 1) throw new DomainError('INVALID_INPUT', 'subject_member_id is required when a household has several care recipients');
        return recipients[0]!;
    }

    /** Resolves an untrusted member reference against the real household roster only: an exact
     *  id, or failing that an exact (case-insensitive) display name. Never fabricated — an
     *  unmatched reference falls through to the caller's own NOT_FOUND/INVALID_INPUT handling. */
    private resolveMember(householdId: string, ref: string): Member | undefined {
        return this.q.memberByRef(householdId, ref);
    }

    private parse<S extends z.ZodType>(schema: S, raw: unknown, actor: Actor, op: Operation): z.infer<S> {
        const result = schema.safeParse(raw);
        if (result.success) return result.data;
        const issues = result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }));
        this.audit(actor, (raw as { household_id?: string })?.household_id ?? null, op, null, 'invalid', { issues });
        throw new DomainError('INVALID_INPUT', 'Input failed validation', { issues });
    }

    private guard(actor: Actor, householdId: string, op: Operation): void {
        try {
            authorize(actor, householdId, op);
        } catch (err) {
            this.audit(actor, householdId, op, null, 'denied', { reason: (err as DomainError).details?.reason });
            throw err;
        }
    }

    /**
     * Runs a state change atomically with its idempotency record and audit entry.
     * Same key + same input => stored response (replayed). Same key + different input => conflict.
     * Any failure rolls back everything, so a retry with the same key starts clean.
     */
    private mutate<I extends { household_id: string; idempotency_key: string }, R extends object>(
        actor: Actor,
        op: Mutation,
        input: I,
        apply: (id: (prefix: string) => string) => R
    ): R & { replayed: boolean } {
        this.guard(actor, input.household_id, op);
        const { idempotency_key: key, ...request } = input;
        const requestHash = sha256(stableStringify(request));
        const id = (prefix: string) => `${prefix}_${sha256(`${actor.memberId}|${op}|${key}`).slice(0, 12)}`;

        this.db.exec('BEGIN IMMEDIATE');
        try {
            const prior = this.db
                .prepare('SELECT request_hash, response_json FROM idempotency_keys WHERE actor_member_id = ? AND tool = ? AND key = ?')
                .get(actor.memberId, op, key) as { request_hash: string; response_json: string } | undefined;
            if (prior) {
                if (prior.request_hash !== requestHash) {
                    throw new DomainError('IDEMPOTENCY_CONFLICT', `idempotency_key ${key} was already used for a different ${op} request`);
                }
                this.audit(actor, input.household_id, op, null, 'replayed', { key, ...simulationDetail(actor) });
                this.db.exec('COMMIT');
                return { ...(JSON.parse(prior.response_json) as R), replayed: true };
            }

            const result = apply(id);
            const deduplicated = (result as { deduplicated?: boolean }).deduplicated === true;
            this.db
                .prepare('INSERT INTO idempotency_keys (actor_member_id, tool, key, household_id, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(actor.memberId, op, key, input.household_id, requestHash, JSON.stringify(result), this.now().toISOString());
            this.audit(actor, input.household_id, op, targetOf(op, result), deduplicated ? 'deduplicated' : 'ok', { key, ...simulationDetail(actor) });
            this.fault(`before_commit:${op}`);
            this.db.exec('COMMIT');
            return { ...result, replayed: false };
        } catch (err) {
            this.db.exec('ROLLBACK');
            const code = err instanceof DomainError ? err.code : 'INTERNAL';
            const outcome = failureOutcome(code);
            this.audit(actor, input.household_id, op, null, outcome, { key, code, ...simulationDetail(actor) });
            throw err;
        }
    }

    private audit(actor: Actor | null, householdId: string | null, action: string, targetId: string | null, outcome: string, detail?: unknown): void {
        this.db
            .prepare('INSERT INTO audit_events (at, actor_member_id, household_id, action, target_id, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(this.now().toISOString(), actor?.memberId ?? null, householdId, action, targetId, outcome, detail === undefined ? null : JSON.stringify(detail));
    }
}

function targetOf(op: Mutation, result: object): string | null {
    const r = result as Record<string, { id?: string } | undefined>;
    if (op === 'decide_approval') return r.approval?.id ?? null;
    return r.event?.id ?? r.appointment_request?.id ?? r.draft?.id ?? r.handoff?.id ?? null;
}

function failureOutcome(code: string): 'conflict' | 'invalid' | 'denied' | 'error' {
    if (code === 'IDEMPOTENCY_CONFLICT' || code === 'ALREADY_DECIDED' || code === 'INVALID_TRANSITION') return 'conflict';
    if (code === 'INVALID_INPUT') return 'invalid';
    return code === 'FORBIDDEN' ? 'denied' : 'error';
}

/** Audit detail that makes a demo "simulated actor" action unmistakable in the trail. */
const simulationDetail = (actor: Actor) => (actor.simulatedBy ? { simulated: true, simulated_by: actor.simulatedBy } : {});
