/** Household-scoped read queries. Every lookup takes household_id so ids from other households resolve to "not found". */
import type { DatabaseSync } from 'node:sqlite';

import type { HandoffStatus } from './handoff-state.js';
import type { Approval, AppointmentRequest, CareEvent, Handoff, HandoffTransition, Member, NotificationDraft } from './types.js';

type Row = Record<string, unknown>;

const toMember = (r: Row): Member => ({
    id: r.id as string,
    householdId: r.household_id as string,
    displayName: r.display_name as string,
    relationship: r.relationship as string,
    role: r.role as Member['role'],
    contactLabel: r.contact_label as string
});

const toEvent = (r: Row): CareEvent => ({
    id: r.id as string,
    householdId: r.household_id as string,
    subjectMemberId: r.subject_member_id as string,
    reportedByMemberId: r.reported_by_member_id as string,
    kind: r.kind as CareEvent['kind'],
    note: r.note as string,
    medicationScheduleId: (r.medication_schedule_id as string | null) ?? null,
    occurredAt: r.occurred_at as string,
    recordedAt: r.recorded_at as string
});

const toAppointment = (r: Row): AppointmentRequest => ({
    id: r.id as string,
    householdId: r.household_id as string,
    subjectMemberId: r.subject_member_id as string,
    requestedByMemberId: r.requested_by_member_id as string,
    reasonAsReported: r.reason_as_reported as string,
    preferredWindow: r.preferred_window as AppointmentRequest['preferredWindow'],
    providerLabel: (r.provider_label as string | null) ?? null,
    relatedEventId: (r.related_event_id as string | null) ?? null,
    status: r.status as AppointmentRequest['status'],
    createdAt: r.created_at as string
});

const toDraft = (r: Row): NotificationDraft => ({
    id: r.id as string,
    householdId: r.household_id as string,
    recipientMemberId: r.recipient_member_id as string,
    draftedByMemberId: r.drafted_by_member_id as string,
    appointmentRequestId: (r.appointment_request_id as string | null) ?? null,
    relatedEventId: (r.related_event_id as string | null) ?? null,
    channel: 'simulated',
    body: r.body as string,
    status: r.status as NotificationDraft['status'],
    createdAt: r.created_at as string
});

const toApproval = (r: Row): Approval => ({
    id: r.id as string,
    householdId: r.household_id as string,
    actionType: 'send_notification',
    targetId: r.target_id as string,
    requestedByMemberId: r.requested_by_member_id as string,
    status: r.status as Approval['status'],
    decidedByMemberId: (r.decided_by_member_id as string | null) ?? null,
    decisionReason: (r.decision_reason as string | null) ?? null,
    createdAt: r.created_at as string,
    decidedAt: (r.decided_at as string | null) ?? null
});

const toHandoff = (r: Row): Handoff => ({
    id: r.id as string,
    householdId: r.household_id as string,
    requestedByMemberId: r.requested_by_member_id as string,
    fromMemberId: r.from_member_id as string,
    toMemberId: r.to_member_id as string,
    taskAsReported: r.task_as_reported as string,
    recipientBasis: r.recipient_basis as Handoff['recipientBasis'],
    status: r.status as HandoffStatus,
    version: r.version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string
});

const toTransition = (r: Row): HandoffTransition => ({
    id: r.id as number,
    handoffId: r.handoff_id as string,
    event: r.event as HandoffTransition['event'],
    fromStatus: (r.from_status as HandoffStatus | null) ?? null,
    toStatus: r.to_status as HandoffStatus,
    actorMemberId: r.actor_member_id as string,
    actorMode: r.actor_mode as HandoffTransition['actorMode'],
    simulatedByMemberId: (r.simulated_by_member_id as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    at: r.at as string
});

export interface MedicationSchedule {
    id: string;
    memberId: string;
    label: string;
    timesOfDay: string[];
    enteredByMemberId: string;
}

export class Queries {
    constructor(private readonly db: DatabaseSync) {}

    household(id: string): { id: string; name: string; timezone: string } | undefined {
        return this.db.prepare('SELECT id, name, timezone FROM households WHERE id = ?').get(id) as never;
    }

    member(id: string): Member | undefined {
        const r = this.db.prepare('SELECT * FROM members WHERE id = ?').get(id) as Row | undefined;
        return r && toMember(r);
    }

    memberInHousehold(householdId: string, id: string): Member | undefined {
        const r = this.db.prepare('SELECT * FROM members WHERE household_id = ? AND id = ?').get(householdId, id) as Row | undefined;
        return r && toMember(r);
    }

    members(householdId: string): Member[] {
        return (this.db.prepare('SELECT * FROM members WHERE household_id = ? ORDER BY created_at, id').all(householdId) as Row[]).map(toMember);
    }

    careRecipients(householdId: string): Member[] {
        return this.members(householdId).filter(m => m.role === 'care_recipient');
    }

    medicationSchedule(householdId: string, id: string): MedicationSchedule | undefined {
        return this.medicationSchedules(householdId).find(s => s.id === id);
    }

    medicationSchedules(householdId: string): MedicationSchedule[] {
        const rows = this.db
            .prepare('SELECT id, member_id, label, times_of_day, entered_by_member_id FROM medication_schedules WHERE household_id = ? ORDER BY times_of_day, id')
            .all(householdId) as Row[];
        return rows.map(r => ({
            id: r.id as string,
            memberId: r.member_id as string,
            label: r.label as string,
            timesOfDay: JSON.parse(r.times_of_day as string) as string[],
            enteredByMemberId: r.entered_by_member_id as string
        }));
    }

    event(householdId: string, id: string): CareEvent | undefined {
        const r = this.db.prepare('SELECT * FROM care_events WHERE household_id = ? AND id = ?').get(householdId, id) as Row | undefined;
        return r && toEvent(r);
    }

    recentEvents(householdId: string, limit: number): CareEvent[] {
        const sql = 'SELECT * FROM care_events WHERE household_id = ? ORDER BY occurred_at DESC, recorded_at DESC, id LIMIT ?';
        return (this.db.prepare(sql).all(householdId, limit) as Row[]).map(toEvent);
    }

    eventCounts(householdId: string): Record<string, number> {
        const rows = this.db.prepare('SELECT kind, COUNT(*) AS n FROM care_events WHERE household_id = ? GROUP BY kind ORDER BY kind').all(householdId) as Row[];
        return Object.fromEntries(rows.map(r => [r.kind as string, r.n as number]));
    }

    medicationReportsSince(householdId: string, sinceIso: string): CareEvent[] {
        const sql = "SELECT * FROM care_events WHERE household_id = ? AND kind = 'medication' AND occurred_at >= ? ORDER BY occurred_at";
        return (this.db.prepare(sql).all(householdId, sinceIso) as Row[]).map(toEvent);
    }

    dutyMemberId(householdId: string, weekday: number): string | undefined {
        const r = this.db.prepare('SELECT member_id FROM duty_assignments WHERE household_id = ? AND weekday = ?').get(householdId, weekday) as Row | undefined;
        return r?.member_id as string | undefined;
    }

    appointment(householdId: string, id: string): AppointmentRequest | undefined {
        const r = this.db.prepare('SELECT * FROM appointment_requests WHERE household_id = ? AND id = ?').get(householdId, id) as Row | undefined;
        return r && toAppointment(r);
    }

    openAppointments(householdId: string): AppointmentRequest[] {
        const sql = "SELECT * FROM appointment_requests WHERE household_id = ? AND status = 'prepared' ORDER BY created_at, id";
        return (this.db.prepare(sql).all(householdId) as Row[]).map(toAppointment);
    }

    draft(householdId: string, id: string): NotificationDraft | undefined {
        const r = this.db.prepare('SELECT * FROM notification_drafts WHERE household_id = ? AND id = ?').get(householdId, id) as Row | undefined;
        return r && toDraft(r);
    }

    approval(householdId: string, id: string): Approval | undefined {
        const r = this.db.prepare('SELECT * FROM approvals WHERE household_id = ? AND id = ?').get(householdId, id) as Row | undefined;
        return r && toApproval(r);
    }

    approvalForTarget(householdId: string, targetId: string): Approval | undefined {
        const r = this.db.prepare('SELECT * FROM approvals WHERE household_id = ? AND target_id = ?').get(householdId, targetId) as Row | undefined;
        return r && toApproval(r);
    }

    pendingApprovals(householdId: string): Approval[] {
        const sql = "SELECT * FROM approvals WHERE household_id = ? AND status = 'pending' ORDER BY created_at, id";
        return (this.db.prepare(sql).all(householdId) as Row[]).map(toApproval);
    }

    /** An exact member id, or failing that an exact (case-insensitive) display name, within the household only. */
    memberByRef(householdId: string, ref: string): Member | undefined {
        return this.memberInHousehold(householdId, ref) ?? this.members(householdId).find(m => m.displayName.toLowerCase() === ref.toLowerCase());
    }

    handoff(householdId: string, id: string): Handoff | undefined {
        const r = this.db.prepare('SELECT * FROM handoffs WHERE household_id = ? AND id = ?').get(householdId, id) as Row | undefined;
        return r && toHandoff(r);
    }

    handoffs(householdId: string, status?: HandoffStatus): Handoff[] {
        const sql = `SELECT * FROM handoffs WHERE household_id = ?${status ? ' AND status = ?' : ''} ORDER BY created_at DESC, id`;
        const args = status ? [householdId, status] : [householdId];
        return (this.db.prepare(sql).all(...args) as Row[]).map(toHandoff);
    }

    openHandoffMatching(householdId: string, toMemberId: string, task: string): Handoff | undefined {
        const sql = "SELECT * FROM handoffs WHERE household_id = ? AND to_member_id = ? AND lower(task_as_reported) = ? AND status IN ('PENDING_APPROVAL', 'PENDING_ACCEPTANCE')";
        const r = this.db.prepare(sql).get(householdId, toMemberId, task.toLowerCase()) as Row | undefined;
        return r && toHandoff(r);
    }

    handoffTransitions(householdId: string, handoffId: string): HandoffTransition[] {
        const sql = 'SELECT * FROM handoff_transitions WHERE household_id = ? AND handoff_id = ? ORDER BY id';
        return (this.db.prepare(sql).all(householdId, handoffId) as Row[]).map(toTransition);
    }

    outboxCount(householdId: string): number {
        return (this.db.prepare('SELECT COUNT(*) AS n FROM simulated_outbox WHERE household_id = ?').get(householdId) as Row).n as number;
    }
}
