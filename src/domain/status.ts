/** Household read model: status view and duty-contact resolution (pure reads, no authorization here). */
import { DomainError } from './errors.js';
import type { Queries } from './queries.js';
import { localDate, localTime, localWeekday, NO_REPORT_PHRASE, SAFETY_NOTICE, weekdayOfDate } from './safety.js';

const RECENT_EVENTS_LIMIT = 20;
const MS_PER_DAY = 86_400_000;

export function statusView(q: Queries, now: Date, householdId: string) {
    const household = q.household(householdId)!;
    const today = localDate(now, household.timezone);
    const members = q.members(householdId);
    const nameOf = (id: string) => members.find(m => m.id === id)?.displayName ?? id;
    const reportsToday = q
        .medicationReportsSince(householdId, new Date(now.getTime() - 2 * MS_PER_DAY).toISOString())
        .filter(e => localDate(new Date(e.occurredAt), household.timezone) === today);

    return {
        household: { id: household.id, name: household.name, timezone: household.timezone },
        generated_at: now.toISOString(),
        local_date: today,
        members: members.map(m => ({ member_id: m.id, name: m.displayName, relationship: m.relationship, role: m.role })),
        duty_contact: dutyContact(q, now, householdId).contact,
        medication_reference: q.medicationSchedules(householdId).map(s => {
            const reports = reportsToday.filter(e => e.medicationScheduleId === s.id);
            return {
                schedule_id: s.id,
                for: nameOf(s.memberId),
                label: s.label,
                times_of_day: s.timesOfDay,
                reports_today: reports.map(e => ({ at_local: localTime(new Date(e.occurredAt), household.timezone), reported_by: nameOf(e.reportedByMemberId), note: e.note })),
                // Absence of a record is reported as exactly that, never as a missed dose.
                status_text: reports.length ? `Report recorded today (${reports.length})` : NO_REPORT_PHRASE
            };
        }),
        recent_events: q.recentEvents(householdId, RECENT_EVENTS_LIMIT).map(e => ({
            id: e.id,
            kind: e.kind,
            note: e.note,
            about: nameOf(e.subjectMemberId),
            reported_by: nameOf(e.reportedByMemberId),
            occurred_at: e.occurredAt
        })),
        open_appointment_requests: q.openAppointments(householdId).map(a => ({ id: a.id, reason_as_reported: a.reasonAsReported, preferred_window: a.preferredWindow, status: a.status })),
        pending_approvals: q.pendingApprovals(householdId).map(a => ({
            approval_id: a.id,
            action: a.actionType,
            draft_id: a.targetId,
            requested_by: nameOf(a.requestedByMemberId),
            draft_preview: q.draft(householdId, a.targetId)?.body ?? ''
        })),
        simulated_notifications_sent: q.outboxCount(householdId),
        safety_notice: SAFETY_NOTICE
    };
}

export function dutyContact(q: Queries, now: Date, householdId: string, date?: string) {
    const tz = q.household(householdId)!.timezone;
    const day = date ?? localDate(now, tz);
    const weekday = date ? weekdayOfDate(date) : localWeekday(now, tz);
    let memberId = q.dutyMemberId(householdId, weekday);
    let basis: 'duty_rota' | 'coordinator_fallback' = 'duty_rota';
    if (!memberId) {
        memberId = q.members(householdId).find(m => m.role === 'coordinator')?.id;
        basis = 'coordinator_fallback';
    }
    if (!memberId) throw new DomainError('NO_DUTY_CONTACT', `No duty contact or coordinator for ${day}`);
    const m = q.member(memberId)!;
    return { date: day, weekday, basis, contact: { member_id: m.id, name: m.displayName, relationship: m.relationship, contact_label: m.contactLabel } };
}

