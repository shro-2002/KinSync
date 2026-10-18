/**
 * Medical-safety boundary. Everything CareLoop says on its own comes from these fixed
 * templates: it repeats what people reported (quoted and attributed) and never diagnoses,
 * recommends medication or doses, or infers that a dose was missed.
 */
import type { AppointmentWindow } from './types.js';

export const SAFETY_NOTICE =
    'CareLoop coordinates family logistics only. It does not give medical advice, diagnoses, or medication guidance. Synthetic demo data.';
export const EMERGENCY_NOTICE = 'If this might be an emergency, contact local emergency services now; CareLoop does not triage.';
// Missing records are not evidence of a missed dose; this exact phrase is used instead.
export const NO_REPORT_PHRASE = 'No report recorded yet today';

const WINDOW_LABELS: Record<AppointmentWindow, string> = {
    asap_non_urgent: 'as soon as convenient (not urgent)',
    this_week: 'this week',
    next_week: 'next week'
};

export const windowLabel = (w: AppointmentWindow) => WINDOW_LABELS[w];

// Quoted and attributed on one line: whitespace (incl. newlines) collapsed so stored text cannot fake
// extra template lines such as "[SYSTEM] ..."; trailing punctuation is supplied by the template.
const quote = (text: string) => `"${text.replaceAll('"', "'").replace(/\s+/g, ' ').trim().replace(/[.!?\s]+$/, '')}"`;

export interface NotificationTemplateInput {
    recipientName: string;
    actorName: string;
    appointment?: { providerLabel: string | null; window: AppointmentWindow; reasonAsReported: string; subjectName: string };
    event?: { kind: string; note: string; reporterName: string; occurredAtLocal: string };
    extraNote?: string;
}

export function renderNotificationDraft(t: NotificationTemplateInput): string {
    const lines = [`[CareLoop draft - simulated, not sent] Hi ${t.recipientName}, ${t.actorName} asked for help through CareLoop.`];
    if (t.appointment) {
        const who = t.appointment.providerLabel ?? 'a doctor';
        lines.push(
            `Appointment help requested for ${t.appointment.subjectName} with ${who}, ${windowLabel(t.appointment.window)}. ` +
                `Reason in their own words: ${quote(t.appointment.reasonAsReported)}.`
        );
    }
    if (t.event) {
        lines.push(`Latest ${t.event.kind} report (${t.event.occurredAtLocal}, from ${t.event.reporterName}): ${quote(t.event.note)}.`);
    }
    if (t.extraNote) lines.push(`${t.actorName} added: ${quote(t.extraNote)}.`);
    lines.push('Please check in with the family. This is a coordination message, not medical advice.');
    return lines.join('\n');
}

/** YYYY-MM-DD for an instant in a time zone. */
export function localDate(at: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** HH:MM (24h) for an instant in a time zone. */
export function localTime(at: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 0 = Sunday ... 6 = Saturday for an instant in a time zone. */
export function localWeekday(at: Date, timeZone: string): number {
    return WEEKDAYS.indexOf(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at));
}

/** Weekday of a calendar date (YYYY-MM-DD); independent of time zone. */
export function weekdayOfDate(date: string): number {
    return new Date(`${date}T12:00:00Z`).getUTCDay();
}
