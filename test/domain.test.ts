/** Domain-layer tests: CareService called directly (no MCP), deterministic clock, seeded synthetic data. */
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { DomainError } from '../src/domain/errors.js';
import { migrate, openDatabase, SCHEMA_VERSION } from '../src/domain/migrations.js';
import { NO_REPORT_PHRASE, renderNotificationDraft } from '../src/domain/safety.js';
import { SEED, seedDemoData } from '../src/domain/seed.js';
import { CareService, type ServiceOptions } from '../src/domain/service.js';
import { FIXED_NOW, tempDbPath } from './helpers.js';

function setup(options: ServiceOptions = {}, path = ':memory:') {
    const db = openDatabase(path);
    seedDemoData(db);
    const svc = new CareService(db, { now: () => FIXED_NOW, ...options });
    const as = (memberId: string) => svc.resolveActor(memberId);
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { db, svc, as, count };
}

function codeOf(fn: () => unknown): string {
    try {
        fn();
    } catch (err) {
        if (err instanceof DomainError) return err.code;
        throw err;
    }
    return 'NO_ERROR';
}

const event = (key: string, extra: object = {}) => ({ household_id: 'hh_rao', idempotency_key: key, kind: 'meal', note: 'synthetic: ate rice', ...extra });
const appointment = (key: string, extra: object = {}) => ({
    household_id: 'hh_rao',
    idempotency_key: key,
    reason_as_reported: 'Knee hurts when climbing stairs',
    preferred_window: 'this_week',
    ...extra
});

function pendingApproval(s: ReturnType<typeof setup>, prefix = 'p') {
    const ravi = s.as('mem_ravi');
    const apt = s.svc.prepareAppointmentRequest(ravi, appointment(`${prefix}-apt-0001`));
    const drafted = s.svc.draftCaregiverNotification(ravi, { household_id: 'hh_rao', idempotency_key: `${prefix}-draft-001`, appointment_request_id: apt.appointment_request.id });
    return { apt, drafted };
}

describe('migrations and seed', () => {
    it('creates the schema at the latest version and reopening is a no-op', () => {
        const path = tempDbPath();
        openDatabase(path).close();
        const db = openDatabase(path);
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
        expect(migrate(db)).toBe(SCHEMA_VERSION);
        db.close();
    });

    it('upgrades a PoC-0 database in place and leaves its legacy table untouched', () => {
        const path = tempDbPath();
        const legacy = new DatabaseSync(path);
        legacy.exec("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL); INSERT INTO events (kind, note, created_at) VALUES ('note', 'poc0 row', 'x');");
        legacy.close();

        const db = openDatabase(path);
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
        expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(1);
        db.close();
    });

    it('seeding is deterministic and idempotent', () => {
        const s = setup();
        seedDemoData(s.db);
        expect(s.count('households')).toBe(SEED.households.length);
        expect(s.count('members')).toBe(SEED.members.length);
        expect(s.count('duty_assignments')).toBe(SEED.duty.length);
    });

    it('stores no dose or strength for medication schedules (by design)', () => {
        const s = setup();
        const columns = (s.db.prepare('PRAGMA table_info(medication_schedules)').all() as Array<{ name: string }>).map(c => c.name);
        expect(columns.some(c => /dose|dosage|strength|mg/i.test(c))).toBe(false);
    });
});

describe('happy path (service level)', () => {
    it('event -> appointment request -> duty contact -> draft -> approve -> one simulated send', () => {
        const s = setup();
        const ravi = s.as('mem_ravi');
        const evt = s.svc.recordCareEvent(ravi, event('h-evt-00001', { kind: 'medication', medication_schedule_id: 'med_ravi_morning', note: 'Took morning medicines' }));
        const apt = s.svc.prepareAppointmentRequest(ravi, appointment('h-apt-00001', { related_event_id: evt.event.id }));
        const duty = s.svc.getDutyContact(ravi, { household_id: 'hh_rao' });
        const drafted = s.svc.draftCaregiverNotification(ravi, { household_id: 'hh_rao', idempotency_key: 'h-draft-0001', appointment_request_id: apt.appointment_request.id });

        expect(duty.contact.member_id).toBe('mem_priya');
        expect(drafted.draft.recipientMemberId).toBe('mem_priya');
        expect(drafted.draft.status).toBe('pending_approval');
        expect(drafted.approval.status).toBe('pending');
        expect(s.count('simulated_outbox')).toBe(0);

        const decided = s.svc.decideApproval(s.as('mem_priya'), { household_id: 'hh_rao', idempotency_key: 'h-approve-01', approval_id: drafted.approval.id, decision: 'approve' });
        expect(decided.approval.status).toBe('approved');
        expect(decided.outbox?.delivery).toBe('simulated_not_sent');
        expect(decided.real_message_sent).toBe(false);
        expect(s.count('simulated_outbox')).toBe(1);
        expect(s.svc.q.appointment('hh_rao', apt.appointment_request.id)?.status).toBe('handed_off');
    });

    // Phase 3E regression for F-30 (Phase 3D Scenario A): a local model sent subject_member_id:
    // "Ravi" (a display name, not an id) instead of calling get_household_status first. The
    // server now resolves an exact display name within the household rather than rejecting it,
    // without ever trusting an unmatched or cross-household reference.
    it.each(['Ravi', 'ravi', 'RAVI'])('subject_member_id accepts the care recipient\'s exact display name (%s), case-insensitively', name => {
        const s = setup();
        const ravi = s.as('mem_ravi');
        const evt = s.svc.recordCareEvent(ravi, event('h-evt-name-01', { kind: 'medication', note: 'Took morning medicines', subject_member_id: name }));
        expect(evt.event.subjectMemberId).toBe('mem_ravi');
    });

    it('subject_member_id rejects a name that matches no one in the household', () => {
        const s = setup();
        const ravi = s.as('mem_ravi');
        expect(codeOf(() => s.svc.recordCareEvent(ravi, event('h-evt-name-02', { subject_member_id: 'NotAPerson' })))).toBe('NOT_FOUND');
    });

    it('subject_member_id by display name does not resolve across households', () => {
        const s = setup();
        const ravi = s.as('mem_ravi');
        // "Lin" is a real display name, but in hh_chen, not hh_rao.
        expect(codeOf(() => s.svc.recordCareEvent(ravi, event('h-evt-name-03', { subject_member_id: 'Lin' })))).toBe('NOT_FOUND');
    });

    it('the care recipient may approve their own request', () => {
        const s = setup();
        const { drafted } = pendingApproval(s);
        const decided = s.svc.decideApproval(s.as('mem_ravi'), { household_id: 'hh_rao', idempotency_key: 'self-approve-1', approval_id: drafted.approval.id, decision: 'approve' });
        expect(decided.approval.decidedByMemberId).toBe('mem_ravi');
    });
});

describe('idempotency and duplicate calls', () => {
    it('same key + same input replays the stored result for every mutation', () => {
        const s = setup();
        const ravi = s.as('mem_ravi');
        const e1 = s.svc.recordCareEvent(ravi, event('dup-evt-0001'));
        const e2 = s.svc.recordCareEvent(ravi, event('dup-evt-0001'));
        const { apt, drafted } = pendingApproval(s, 'dup');
        const apt2 = s.svc.prepareAppointmentRequest(ravi, appointment('dup-apt-0001'));
        const d2 = s.svc.draftCaregiverNotification(ravi, { household_id: 'hh_rao', idempotency_key: 'dup-draft-001', appointment_request_id: apt.appointment_request.id });
        const approve = { household_id: 'hh_rao', idempotency_key: 'dup-approve-1', approval_id: drafted.approval.id, decision: 'approve' };
        const a1 = s.svc.decideApproval(s.as('mem_priya'), approve);
        const a2 = s.svc.decideApproval(s.as('mem_priya'), approve);

        expect([e1.replayed, e2.replayed, apt2.replayed, d2.replayed, a1.replayed, a2.replayed]).toEqual([false, true, true, true, false, true]);
        expect(e2.event.id).toBe(e1.event.id);
        expect(d2.approval.id).toBe(drafted.approval.id);
        expect([s.count('care_events'), s.count('appointment_requests'), s.count('notification_drafts'), s.count('simulated_outbox')]).toEqual([1, 1, 1, 1]);
    });

    it('same key + different input is a conflict and writes nothing', () => {
        const s = setup();
        const ravi = s.as('mem_ravi');
        s.svc.recordCareEvent(ravi, event('conflict-0001'));
        expect(codeOf(() => s.svc.recordCareEvent(ravi, event('conflict-0001', { note: 'something else' })))).toBe('IDEMPOTENCY_CONFLICT');
        expect(s.count('care_events')).toBe(1);
    });

    it('fresh-key retries: appointment and draft are deduplicated; a similar event is stored and flagged, never merged', () => {
        const s = setup();
        const ravi = s.as('mem_ravi');
        const { apt, drafted } = pendingApproval(s, 'nat');
        const apt2 = s.svc.prepareAppointmentRequest(ravi, appointment('nat-apt-0002', { reason_as_reported: 'KNEE HURTS WHEN CLIMBING STAIRS' }));
        const d2 = s.svc.draftCaregiverNotification(ravi, { household_id: 'hh_rao', idempotency_key: 'nat-draft-002', appointment_request_id: apt.appointment_request.id });
        const e1 = s.svc.recordCareEvent(ravi, event('nat-evt-0001'));
        const e2 = s.svc.recordCareEvent(ravi, event('nat-evt-0002'));

        expect(apt2.deduplicated && apt2.appointment_request.id === apt.appointment_request.id).toBe(true);
        expect(d2.deduplicated && d2.approval.id === drafted.approval.id).toBe(true);
        expect(e2.deduplicated).toBe(false);
        expect(e2.event.id).not.toBe(e1.event.id);
        expect(e2.possible_duplicate_of).toBe(e1.event.id);
        expect([s.count('appointment_requests'), s.count('notification_drafts'), s.count('approvals'), s.count('care_events')]).toEqual([1, 1, 1, 2]);
    });

    it('identical events far apart in time are separate reports', () => {
        const s = setup();
        const ravi = s.as('mem_ravi');
        s.svc.recordCareEvent(ravi, event('far-evt-0001', { occurred_at: '2026-10-12T01:00:00Z' }));
        const later = s.svc.recordCareEvent(ravi, event('far-evt-0002', { occurred_at: '2026-10-12T03:00:00Z' }));
        expect(later.deduplicated).toBe(false);
        expect(later.possible_duplicate_of).toBeNull();
        expect(s.count('care_events')).toBe(2);
    });

    it('a second approval with a new key is refused and never sends twice', () => {
        const s = setup();
        const { drafted } = pendingApproval(s);
        const priya = s.as('mem_priya');
        s.svc.decideApproval(priya, { household_id: 'hh_rao', idempotency_key: 'twice-0001', approval_id: drafted.approval.id, decision: 'approve' });
        expect(codeOf(() => s.svc.decideApproval(priya, { household_id: 'hh_rao', idempotency_key: 'twice-0002', approval_id: drafted.approval.id, decision: 'approve' }))).toBe('ALREADY_DECIDED');
        expect(codeOf(() => s.svc.decideApproval(priya, { household_id: 'hh_rao', idempotency_key: 'twice-0003', approval_id: drafted.approval.id, decision: 'reject' }))).toBe('ALREADY_DECIDED');
        expect(s.count('simulated_outbox')).toBe(1);
    });
});

describe('invalid inputs', () => {
    const cases: Array<[string, object]> = [
        ['unknown kind', event('bad-in-0001', { kind: 'prescription' })],
        ['empty note', event('bad-in-0002', { note: '   ' })],
        ['note too long', event('bad-in-0003', { note: 'x'.repeat(501) })],
        ['short idempotency key', event('short')],
        ['idempotency key with spaces', event('has spaces in key')],
        ['bad occurred_at', event('bad-in-0004', { occurred_at: 'yesterday' })],
        ['future occurred_at', event('bad-in-0005', { occurred_at: '2026-10-13T00:00:00Z' })],
        ['schedule id on a non-medication event', event('bad-in-0006', { medication_schedule_id: 'med_ravi_morning' })]
    ];
    it.each(cases)('record_care_event rejects %s', (_label, input) => {
        const s = setup();
        expect(codeOf(() => s.svc.recordCareEvent(s.as('mem_ravi'), input))).toBe('INVALID_INPUT');
        expect(s.count('care_events')).toBe(0);
        expect(s.count('idempotency_keys')).toBe(0);
    });

    it('appointment request rejects an unknown window and an over-long reason', () => {
        const s = setup();
        const ravi = s.as('mem_ravi');
        expect(codeOf(() => s.svc.prepareAppointmentRequest(ravi, appointment('bad-apt-0001', { preferred_window: 'tomorrow' })))).toBe('INVALID_INPUT');
        expect(codeOf(() => s.svc.prepareAppointmentRequest(ravi, appointment('bad-apt-0002', { reason_as_reported: 'x'.repeat(301) })))).toBe('INVALID_INPUT');
    });

    it('draft requires something to talk about', () => {
        const s = setup();
        expect(codeOf(() => s.svc.draftCaregiverNotification(s.as('mem_ravi'), { household_id: 'hh_rao', idempotency_key: 'bad-draft-01' }))).toBe('INVALID_INPUT');
        expect(s.count('notification_drafts')).toBe(0);
    });

    it('invalid input is audited', () => {
        const s = setup();
        codeOf(() => s.svc.recordCareEvent(s.as('mem_ravi'), event('bad-in-0007', { kind: 'nope' })));
        expect(s.svc.auditTrail('hh_rao').some(a => a.outcome === 'invalid' && a.action === 'record_care_event')).toBe(true);
    });
});

describe('authorization: household and role', () => {
    it('members of another household are denied every operation', () => {
        const s = setup();
        const wei = s.as('mem_wei');
        expect(codeOf(() => s.svc.recordCareEvent(wei, event('xh-evt-0001')))).toBe('FORBIDDEN');
        expect(codeOf(() => s.svc.getHouseholdStatus(wei, { household_id: 'hh_rao' }))).toBe('FORBIDDEN');
        expect(codeOf(() => s.svc.showDashboard(wei, { household_id: 'hh_rao' }))).toBe('FORBIDDEN');
        expect(codeOf(() => s.svc.getDutyContact(wei, { household_id: 'hh_rao' }))).toBe('FORBIDDEN');
        expect(codeOf(() => s.svc.prepareAppointmentRequest(wei, appointment('xh-apt-0001')))).toBe('FORBIDDEN');
        expect(s.count('care_events') + s.count('appointment_requests')).toBe(0);
        expect(s.svc.auditTrail('hh_rao').filter(a => a.outcome === 'denied')).toHaveLength(5);
    });

    it("another household's ids look like they do not exist (no existence leak)", () => {
        const s = setup();
        const lin = s.as('mem_lin');
        const chenApt = s.svc.prepareAppointmentRequest(lin, { household_id: 'hh_chen', idempotency_key: 'chen-apt-001', reason_as_reported: 'Check-up', preferred_window: 'next_week' });
        const chenDraft = s.svc.draftCaregiverNotification(lin, { household_id: 'hh_chen', idempotency_key: 'chen-draft-01', appointment_request_id: chenApt.appointment_request.id });
        const ravi = s.as('mem_ravi');

        expect(codeOf(() => s.svc.recordCareEvent(ravi, event('leak-0001', { kind: 'medication', medication_schedule_id: 'med_lin_morning' })))).toBe('NOT_FOUND');
        expect(codeOf(() => s.svc.draftCaregiverNotification(ravi, { household_id: 'hh_rao', idempotency_key: 'leak-0002', appointment_request_id: chenApt.appointment_request.id }))).toBe('NOT_FOUND');
        expect(codeOf(() => s.svc.decideApproval(ravi, { household_id: 'hh_rao', idempotency_key: 'leak-0003', approval_id: chenDraft.approval.id, decision: 'approve' }))).toBe('NOT_FOUND');
        expect(codeOf(() => s.svc.draftCaregiverNotification(ravi, { household_id: 'hh_rao', idempotency_key: 'leak-0004', related_event_id: 'evt_x', recipient_member_id: 'mem_wei' }))).toBe('NOT_FOUND');
        expect(s.svc.q.approval('hh_chen', chenDraft.approval.id)?.status).toBe('pending');
    });

    it('viewer can read but not write; caregiver cannot approve', () => {
        const s = setup();
        const meera = s.as('mem_meera');
        expect(s.svc.getHouseholdStatus(meera, { household_id: 'hh_rao' }).household.id).toBe('hh_rao');
        expect(codeOf(() => s.svc.recordCareEvent(meera, event('viewer-0001')))).toBe('FORBIDDEN');
        const { drafted } = pendingApproval(s);
        expect(codeOf(() => s.svc.decideApproval(s.as('mem_arjun'), { household_id: 'hh_rao', idempotency_key: 'arjun-appr-1', approval_id: drafted.approval.id, decision: 'approve' }))).toBe('FORBIDDEN');
        expect(s.count('simulated_outbox')).toBe(0);
    });

    it('sessions without an actor, or with an unknown one, are refused', () => {
        const s = setup();
        expect(codeOf(() => s.svc.resolveActor(undefined))).toBe('UNAUTHENTICATED_SESSION');
        expect(codeOf(() => s.svc.resolveActor('mem_nobody'))).toBe('UNKNOWN_ACTOR');
    });
});

describe('rejected approvals', () => {
    it('reject: nothing sent, request stays open, decision recorded, a new draft may follow', () => {
        const s = setup();
        const { apt, drafted } = pendingApproval(s);
        const rejected = s.svc.decideApproval(s.as('mem_priya'), {
            household_id: 'hh_rao',
            idempotency_key: 'reject-00001',
            approval_id: drafted.approval.id,
            decision: 'reject',
            reason: 'I will call Dad myself'
        });
        expect(rejected.approval.status).toBe('rejected');
        expect(rejected.approval.decisionReason).toBe('I will call Dad myself');
        expect(rejected.draft.status).toBe('rejected');
        expect(rejected.outbox).toBeNull();
        expect(s.count('simulated_outbox')).toBe(0);
        expect(s.svc.q.appointment('hh_rao', apt.appointment_request.id)?.status).toBe('prepared');

        const redraft = s.svc.draftCaregiverNotification(s.as('mem_ravi'), {
            household_id: 'hh_rao',
            idempotency_key: 'redraft-0001',
            appointment_request_id: apt.appointment_request.id,
            recipient_member_id: 'mem_arjun'
        });
        expect(redraft.deduplicated).toBe(false);
        expect(redraft.approval.status).toBe('pending');
    });
});

describe('failure recovery', () => {
    it('a crash before commit leaves no partial state, and the same key then succeeds once', () => {
        let failNext = true;
        const path = tempDbPath();
        const s = setup({
            faultInjector: point => {
                if (failNext && point === 'before_commit:draft_caregiver_notification') {
                    failNext = false;
                    throw new Error('simulated crash');
                }
            }
        }, path);
        const ravi = s.as('mem_ravi');
        const apt = s.svc.prepareAppointmentRequest(ravi, appointment('fr-apt-00001'));
        const args = { household_id: 'hh_rao', idempotency_key: 'fr-draft-0001', appointment_request_id: apt.appointment_request.id };

        expect(() => s.svc.draftCaregiverNotification(ravi, args)).toThrow('simulated crash');
        expect([s.count('notification_drafts'), s.count('approvals')]).toEqual([0, 0]);
        expect(s.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = 'fr-draft-0001'").get()).toEqual({ n: 0 });
        expect(s.svc.auditTrail('hh_rao').some(a => a.action === 'draft_caregiver_notification' && a.outcome === 'error')).toBe(true);

        const retried = s.svc.draftCaregiverNotification(ravi, args);
        expect(retried.replayed).toBe(false);
        expect([s.count('notification_drafts'), s.count('approvals')]).toEqual([1, 1]);
    });

    it('a crash while approving sends nothing and leaves the approval pending', () => {
        let failNext = true;
        const s = setup({
            faultInjector: point => {
                if (failNext && point === 'before_commit:decide_approval') {
                    failNext = false;
                    throw new Error('simulated crash');
                }
            }
        });
        const { drafted } = pendingApproval(s);
        const args = { household_id: 'hh_rao', idempotency_key: 'fr-approve-01', approval_id: drafted.approval.id, decision: 'approve' };
        expect(() => s.svc.decideApproval(s.as('mem_priya'), args)).toThrow('simulated crash');
        expect(s.count('simulated_outbox')).toBe(0);
        expect(s.svc.q.approval('hh_rao', drafted.approval.id)?.status).toBe('pending');

        expect(s.svc.decideApproval(s.as('mem_priya'), args).approval.status).toBe('approved');
        expect(s.count('simulated_outbox')).toBe(1);
    });
});

describe('medical safety', () => {
    it('a schedule without a report says exactly "no report recorded", never "missed"', () => {
        const s = setup();
        const status = s.svc.getHouseholdStatus(s.as('mem_priya'), { household_id: 'hh_rao' });
        expect(status.medication_reference.map(m => m.status_text)).toEqual([NO_REPORT_PHRASE, NO_REPORT_PHRASE]);
        expect(JSON.stringify(status)).not.toMatch(/miss(ed|ing) (dose|medication)|overdue|skipped/i);
    });

    it('a report counts only on the local day it occurred (household time zone)', () => {
        const s = setup();
        const ravi = s.as('mem_ravi');
        // 2026-10-11T19:00Z = 2026-10-12 00:30 in Asia/Kolkata -> "today" for the fixed clock.
        s.svc.recordCareEvent(ravi, event('tz-evt-00001', { kind: 'medication', medication_schedule_id: 'med_ravi_morning', note: 'took them', occurred_at: '2026-10-11T19:00:00Z' }));
        // 2026-10-11T18:00Z = 2026-10-11 23:30 local -> yesterday.
        s.svc.recordCareEvent(ravi, event('tz-evt-00002', { kind: 'medication', medication_schedule_id: 'med_ravi_evening', note: 'took them', occurred_at: '2026-10-11T18:00:00Z' }));
        const status = s.svc.getHouseholdStatus(ravi, { household_id: 'hh_rao' });
        expect(status.medication_reference.map(m => m.status_text)).toEqual(['Report recorded today (1)', NO_REPORT_PHRASE]);
    });

    it('system-authored draft text carries no advice; the person\'s words are quoted and attributed', () => {
        const body = renderNotificationDraft({
            recipientName: 'Priya',
            actorName: 'Ravi',
            appointment: { providerLabel: null, window: 'asap_non_urgent', reasonAsReported: 'dizzy since morning', subjectName: 'Ravi' },
            event: { kind: 'symptom', note: 'felt dizzy', reporterName: 'Ravi', occurredAtLocal: '2026-10-12 09:00' }
        });
        const systemText = body.replace(/"[^"]*"/g, '""');
        expect(systemText).not.toMatch(/\b(mg|dose|dosage|diagnos\w*|you should take|increase|decrease|stop taking|prescri\w*)\b/i);
        expect(body).toContain('"dizzy since morning"');
        expect(body).toContain('not medical advice');
        expect(body).toContain('simulated, not sent');
    });

    it('notes are stored verbatim, including a person\'s own mention of a dose', () => {
        const s = setup();
        const note = 'I took 2 of the white tablets';
        const res = s.svc.recordCareEvent(s.as('mem_ravi'), event('verbatim-0001', { kind: 'medication', note }));
        expect(res.event.note).toBe(note);
    });

    it('appointment preparation never books anything and points emergencies elsewhere', () => {
        const s = setup();
        const res = s.svc.prepareAppointmentRequest(s.as('mem_ravi'), appointment('safe-apt-0001'));
        expect(res.nothing_booked).toBe(true);
        expect(res.emergency_notice).toMatch(/emergency services/);
    });
});

describe('duty contact', () => {
    it('follows the rota by weekday and respects the household time zone', () => {
        const s = setup();
        const ravi = s.as('mem_ravi');
        expect(s.svc.getDutyContact(ravi, { household_id: 'hh_rao', date: '2026-10-15' }).contact.name).toBe('Arjun'); // Thursday
        expect(s.svc.getDutyContact(ravi, { household_id: 'hh_rao', date: '2026-10-13' }).contact.name).toBe('Priya'); // Tuesday

        // 2026-10-11T20:00Z is Sunday in UTC but Monday 01:30 in Asia/Kolkata -> Priya, not Sunday's Arjun.
        const night = setup({ now: () => new Date('2026-10-11T20:00:00Z') });
        const status = night.svc.getDutyContact(night.as('mem_ravi'), { household_id: 'hh_rao' });
        expect([status.weekday, status.contact.name]).toEqual([1, 'Priya']);
    });

    it('falls back to the coordinator when the rota has a gap', () => {
        const s = setup();
        s.db.prepare("DELETE FROM duty_assignments WHERE household_id = 'hh_rao' AND weekday = 4").run();
        const res = s.svc.getDutyContact(s.as('mem_ravi'), { household_id: 'hh_rao', date: '2026-10-15' });
        expect([res.basis, res.contact.name]).toEqual(['coordinator_fallback', 'Priya']);
    });
});
