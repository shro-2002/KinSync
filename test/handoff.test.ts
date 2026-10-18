/** KinSync care handoff: CareService called directly (no MCP), fixed clock, synthetic data. */
import { describe, expect, it, vi } from 'vitest';

import { DomainError } from '../src/domain/errors.js';
import { HANDOFF_EVENTS, HANDOFF_STATUSES, nextStatus, type HandoffEvent, type HandoffStatus } from '../src/domain/handoff-state.js';
import { openDatabase } from '../src/domain/migrations.js';
import { seedDemoData } from '../src/domain/seed.js';
import { CareService } from '../src/domain/service.js';
import { FIXED_NOW, tempDbPath } from './helpers.js';

const THURSDAY = new Date('2026-10-15T04:00:00.000Z'); // rota: Arjun
const TASK = 'I need help getting to my clinic visit on Thursday';

function setup(now: Date = FIXED_NOW, path = ':memory:') {
    const db = openDatabase(path);
    seedDemoData(db);
    const svc = new CareService(db, { now: () => now });
    const as = (memberId: string) => svc.resolveActor(memberId);
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { db, svc, as, count };
}
type Setup = ReturnType<typeof setup>;

function errorOf(fn: () => unknown): DomainError {
    try {
        fn();
    } catch (err) {
        if (err instanceof DomainError) return err;
        throw err;
    }
    throw new Error('expected a DomainError');
}

let n = 0;
const key = (label: string) => `${label}-${String(++n).padStart(5, '0')}`;
const propose = (s: Setup, who = 'mem_ravi', extra: object = {}) =>
    s.svc.proposeHandoff(s.as(who), { household_id: 'hh_rao', idempotency_key: key('propose'), task_description: TASK, proposed_recipient: 'mem_arjun', ...extra });
const decide = (s: Setup, who: string, handoffId: string, decision: 'approve' | 'reject', extra: object = {}) =>
    s.svc.decideHandoff(s.as(who), { household_id: 'hh_rao', idempotency_key: key('decide'), handoff_id: handoffId, decision, ...extra });
const respond = (s: Setup, who: string, handoffId: string, response: 'accept' | 'decline', extra: object = {}) =>
    s.svc.respondToHandoff(s.as(who), { household_id: 'hh_rao', idempotency_key: key('respond'), handoff_id: handoffId, response, ...extra });
const statusOf = (s: Setup, id: string) => s.svc.getHandoffs(s.as('mem_priya'), { household_id: 'hh_rao' }).handoffs.find(h => h.id === id)!.status;

describe('handoff state machine', () => {
    const ALLOWED: Array<[HandoffStatus, HandoffEvent, HandoffStatus]> = [
        ['PENDING_APPROVAL', 'approve', 'PENDING_ACCEPTANCE'],
        ['PENDING_APPROVAL', 'reject', 'REJECTED'],
        ['PENDING_ACCEPTANCE', 'accept', 'COMPLETED'],
        ['PENDING_ACCEPTANCE', 'decline', 'DECLINED']
    ];

    it.each(ALLOWED)('%s --%s--> %s', (from, event, to) => {
        expect(nextStatus(from, event)).toBe(to);
    });

    it('refuses every other status/event pair, including anything out of a terminal state', () => {
        const allowed = new Set(ALLOWED.map(([f, e]) => `${f}:${e}`));
        for (const from of HANDOFF_STATUSES) {
            for (const event of HANDOFF_EVENTS) {
                if (allowed.has(`${from}:${event}`)) continue;
                expect(errorOf(() => nextStatus(from, event)).code).toBe('INVALID_TRANSITION');
            }
        }
    });
});

describe('lifecycle', () => {
    it('proposes, is approved by a human, then accepted by the recipient: COMPLETED with a full history', () => {
        const s = setup();
        const proposed = propose(s);
        expect(proposed.handoff).toMatchObject({ status: 'PENDING_APPROVAL', task_description: TASK, recipient_basis: 'named' });
        expect(proposed.handoff.current_owner.name).toBe('Priya');
        expect(proposed.handoff.proposed_recipient.name).toBe('Arjun');
        expect(proposed.handoff.requested_by.name).toBe('Ravi');
        expect(proposed.handoff.eligible).toEqual({ approve_or_reject: ['mem_priya', 'mem_ravi'], accept_or_decline: [] });

        const id = proposed.handoff.id;
        const approved = decide(s, 'mem_priya', id, 'approve', { reason: 'Priya has a work trip' });
        expect(approved.handoff.status).toBe('PENDING_ACCEPTANCE');
        expect(approved.handoff.eligible).toEqual({ approve_or_reject: [], accept_or_decline: ['mem_arjun'] });
        expect(approved.handoff.status_text).toContain('not responsible until they accept');

        const done = respond(s, 'mem_arjun', id, 'accept');
        expect(done.handoff.status).toBe('COMPLETED');
        expect(done.handoff.status_text).toContain('does not confirm any care was provided');
        expect(done.handoff.history.map(h => [h.event, h.from, h.to, h.by.name])).toEqual([
            ['propose', null, 'PENDING_APPROVAL', 'Ravi'],
            ['approve', 'PENDING_APPROVAL', 'PENDING_ACCEPTANCE', 'Priya'],
            ['accept', 'PENDING_ACCEPTANCE', 'COMPLETED', 'Arjun']
        ]);
        expect(done.handoff.history.every(h => h.at === FIXED_NOW.toISOString() && h.actor_mode === 'session')).toBe(true);
        expect(s.count('simulated_outbox')).toBe(0); // nothing sent, nothing booked
        expect(s.count('notification_drafts')).toBe(0);
    });

    it('a rejected proposal is closed for good: nobody can accept it afterwards', () => {
        const s = setup();
        const id = propose(s).handoff.id;
        expect(decide(s, 'mem_ravi', id, 'reject', { reason: 'Priya can still do it' }).handoff.status).toBe('REJECTED');
        expect(errorOf(() => respond(s, 'mem_arjun', id, 'accept')).code).toBe('INVALID_TRANSITION');
        expect(errorOf(() => decide(s, 'mem_priya', id, 'approve')).code).toBe('INVALID_TRANSITION');
        expect(statusOf(s, id)).toBe('REJECTED');
    });

    it('a recipient who declines leaves responsibility unchanged', () => {
        const s = setup();
        const id = propose(s).handoff.id;
        decide(s, 'mem_priya', id, 'approve');
        const declined = respond(s, 'mem_arjun', id, 'decline', { reason: 'Away that day' });
        expect(declined.handoff.status).toBe('DECLINED');
        expect(declined.handoff.status_text).toContain('Responsibility is unchanged');
        expect(errorOf(() => respond(s, 'mem_arjun', id, 'accept')).code).toBe('INVALID_TRANSITION');
    });

    it('accepting before approval is refused: acceptance cannot skip the human decision', () => {
        const s = setup();
        const id = propose(s).handoff.id;
        const err = errorOf(() => respond(s, 'mem_arjun', id, 'accept'));
        expect(err).toMatchObject({ code: 'INVALID_TRANSITION', details: { from: 'PENDING_APPROVAL', event: 'accept' } });
        expect(statusOf(s, id)).toBe('PENDING_APPROVAL');
    });
});

describe('recipient must be an authorized household member', () => {
    it.each([
        ['free text that is nobody', 'Grandma', 'NOT_FOUND'],
        ['a member of another household', 'Wei', 'NOT_FOUND'],
        ['a viewer (cannot take duties)', 'Meera', 'INVALID_INPUT'],
        ['the care recipient', 'Ravi', 'INVALID_INPUT'],
        ['the current duty contact', 'Priya', 'INVALID_INPUT']
    ])('refuses %s', (_label, recipient, code) => {
        const s = setup();
        expect(errorOf(() => propose(s, 'mem_ravi', { proposed_recipient: recipient })).code).toBe(code);
        expect(s.count('handoffs')).toBe(0);
    });

    it('refuses a handoff to the person asking for help', () => {
        const s = setup();
        expect(errorOf(() => propose(s, 'mem_arjun')).details).toMatchObject({ reason: 'recipient_is_requester' });
    });

    it('accepts a display name and resolves it against the roster', () => {
        const s = setup();
        expect(propose(s, 'mem_ravi', { proposed_recipient: 'arjun' }).handoff.proposed_recipient.member_id).toBe('mem_arjun');
    });

    it('with no recipient named, uses the only eligible member and says so; otherwise asks', () => {
        const monday = setup();
        expect(propose(monday, 'mem_ravi', { proposed_recipient: undefined }).handoff).toMatchObject({ recipient_basis: 'only_eligible_member', proposed_recipient: { name: 'Arjun' } });

        const thursday = setup(THURSDAY);
        const t = propose(thursday, 'mem_ravi', { proposed_recipient: undefined }).handoff;
        expect(t).toMatchObject({ current_owner: { name: 'Arjun' }, proposed_recipient: { name: 'Priya' } });

        const crowded = setup();
        crowded.db.prepare("INSERT INTO members (id, household_id, display_name, relationship, role, contact_label, created_at) VALUES ('mem_dev', 'hh_rao', 'Dev', 'cousin', 'caregiver', 'Dev phone (simulated)', '2026-10-01T00:00:00.000Z')").run();
        const err = errorOf(() => propose(crowded, 'mem_ravi', { proposed_recipient: undefined }));
        expect(err).toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'recipient_required' } });
        expect((err.details!.eligible as unknown[]).length).toBe(2);
    });
});

describe('authorization', () => {
    it('only the care recipient or coordinator may approve; a viewer and a caregiver may not', () => {
        const s = setup();
        const id = propose(s).handoff.id;
        for (const who of ['mem_meera', 'mem_arjun']) expect(errorOf(() => decide(s, who, id, 'approve')).code).toBe('FORBIDDEN');
        expect(statusOf(s, id)).toBe('PENDING_APPROVAL');
    });

    it('a viewer cannot propose, but can read', () => {
        const s = setup();
        expect(errorOf(() => propose(s, 'mem_meera')).code).toBe('FORBIDDEN');
        expect(s.svc.getHandoffs(s.as('mem_meera'), { household_id: 'hh_rao' }).handoffs).toEqual([]);
    });

    it('the proposed recipient can never approve their own handoff, even as coordinator', () => {
        const s = setup(THURSDAY); // Arjun on duty, Priya (coordinator) proposed
        const id = propose(s, 'mem_ravi', { proposed_recipient: 'Priya' }).handoff.id;
        expect(errorOf(() => decide(s, 'mem_priya', id, 'approve')).details).toMatchObject({ reason: 'recipient_cannot_approve' });
        expect(decide(s, 'mem_ravi', id, 'approve').handoff.status).toBe('PENDING_ACCEPTANCE');
        expect(respond(s, 'mem_priya', id, 'accept').handoff.status).toBe('COMPLETED');
    });

    it('only the named recipient may accept or decline: not another coordinator, not the care recipient', () => {
        const s = setup();
        const id = propose(s).handoff.id;
        decide(s, 'mem_priya', id, 'approve');
        expect(errorOf(() => respond(s, 'mem_priya', id, 'accept')).details).toMatchObject({ reason: 'not_proposed_recipient' });
        expect(errorOf(() => respond(s, 'mem_ravi', id, 'accept')).code).toBe('FORBIDDEN'); // role
        expect(errorOf(() => respond(s, 'mem_priya', id, 'decline')).code).toBe('FORBIDDEN');
        expect(statusOf(s, id)).toBe('PENDING_ACCEPTANCE');
    });

    it('is household-scoped: other households can neither act on nor even see a handoff', () => {
        const s = setup();
        const id = propose(s).handoff.id;
        const wei = s.as('mem_wei');
        const decideBody = { idempotency_key: key('wei-attempt'), handoff_id: id, decision: 'approve' };
        expect(errorOf(() => s.svc.decideHandoff(wei, { household_id: 'hh_rao', ...decideBody })).code).toBe('FORBIDDEN');
        expect(errorOf(() => s.svc.decideHandoff(wei, { household_id: 'hh_chen', ...decideBody })).code).toBe('NOT_FOUND');
        expect(errorOf(() => s.svc.respondToHandoff(wei, { household_id: 'hh_chen', idempotency_key: key('wei-attempt'), handoff_id: id, response: 'accept' })).code).toBe('NOT_FOUND');
        expect(errorOf(() => s.svc.getHandoffs(wei, { household_id: 'hh_rao' })).code).toBe('FORBIDDEN');
        expect(s.svc.getHandoffs(wei, { household_id: 'hh_chen' }).handoffs).toEqual([]);
        expect(statusOf(s, id)).toBe('PENDING_APPROVAL');
    });
});

describe('duplicates, retries and concurrent updates', () => {
    it('retrying a proposal with the same key replays; a fresh key for the same ask deduplicates', () => {
        const s = setup();
        const body = { household_id: 'hh_rao', idempotency_key: 'propose-retry-0001', task_description: TASK, proposed_recipient: 'mem_arjun' };
        const first = s.svc.proposeHandoff(s.as('mem_ravi'), body);
        expect(first.replayed).toBe(false);
        const retry = s.svc.proposeHandoff(s.as('mem_ravi'), body);
        expect(retry).toMatchObject({ replayed: true, handoff: { id: first.handoff.id } });
        const again = propose(s, 'mem_ravi', { task_description: TASK.toUpperCase() });
        expect(again).toMatchObject({ deduplicated: true, handoff: { id: first.handoff.id } });
        expect(s.count('handoffs')).toBe(1);
        expect(s.count('handoff_transitions')).toBe(1);
    });

    it('reusing a key for a different request is an idempotency conflict', () => {
        const s = setup();
        const body = { household_id: 'hh_rao', idempotency_key: 'propose-conflict-1', task_description: TASK, proposed_recipient: 'mem_arjun' };
        s.svc.proposeHandoff(s.as('mem_ravi'), body);
        expect(errorOf(() => s.svc.proposeHandoff(s.as('mem_ravi'), { ...body, task_description: 'Something else entirely' })).code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('a double-clicked approval replays; a second decision under a new key is an invalid transition', () => {
        const s = setup();
        const id = propose(s).handoff.id;
        const body = { household_id: 'hh_rao', idempotency_key: 'approve-twice-001', handoff_id: id, decision: 'approve' };
        expect(s.svc.decideHandoff(s.as('mem_priya'), body).replayed).toBe(false);
        expect(s.svc.decideHandoff(s.as('mem_priya'), body).replayed).toBe(true);
        expect(errorOf(() => decide(s, 'mem_ravi', id, 'reject')).code).toBe('INVALID_TRANSITION');
        expect(s.count('handoff_transitions')).toBe(2);
    });

    it('two connections racing approve vs reject: exactly one wins', () => {
        const path = tempDbPath();
        const a = setup(FIXED_NOW, path);
        const b = { db: openDatabase(path) };
        const svcB = new CareService(b.db, { now: () => FIXED_NOW });
        const id = propose(a).handoff.id;
        expect(decide(a, 'mem_priya', id, 'approve').handoff.status).toBe('PENDING_ACCEPTANCE');
        const lost = errorOf(() => svcB.decideHandoff(svcB.resolveActor('mem_ravi'), { household_id: 'hh_rao', idempotency_key: key('race'), handoff_id: id, decision: 'reject' }));
        expect(lost.code).toBe('INVALID_TRANSITION');
        expect(statusOf(a, id)).toBe('PENDING_ACCEPTANCE');
        b.db.close();
    });

    it('a stale read loses the compare-and-set and changes nothing', () => {
        const s = setup();
        const id = propose(s).handoff.id;
        const real = s.svc.q.handoff.bind(s.svc.q);
        vi.spyOn(s.svc.q, 'handoff').mockImplementationOnce((hh, hid) => ({ ...real(hh, hid)!, version: 0 }));
        const err = errorOf(() => decide(s, 'mem_priya', id, 'approve'));
        expect(err).toMatchObject({ code: 'INVALID_TRANSITION', details: { reason: 'concurrent_update' } });
        expect(statusOf(s, id)).toBe('PENDING_APPROVAL');
        expect(s.count('handoff_transitions')).toBe(1);
    });

    it('a crash before commit leaves no half-written handoff, and the same key then succeeds', () => {
        let crash = true;
        const db = openDatabase(':memory:');
        seedDemoData(db);
        const svc = new CareService(db, {
            now: () => FIXED_NOW,
            faultInjector: point => {
                if (crash && point === 'before_commit:propose_handoff') throw new Error('simulated crash');
            }
        });
        const body = { household_id: 'hh_rao', idempotency_key: 'crash-propose-001', task_description: TASK, proposed_recipient: 'mem_arjun' };
        expect(() => svc.proposeHandoff(svc.resolveActor('mem_ravi'), body)).toThrow('simulated crash');
        expect((db.prepare('SELECT COUNT(*) AS n FROM handoffs').get() as { n: number }).n).toBe(0);
        crash = false;
        expect(svc.proposeHandoff(svc.resolveActor('mem_ravi'), body).handoff.status).toBe('PENDING_APPROVAL');
    });
});

describe('persistence and migration', () => {
    it('everything survives a restart, and the lifecycle continues from the stored state', () => {
        const path = tempDbPath();
        const first = setup(FIXED_NOW, path);
        const id = propose(first).handoff.id;
        decide(first, 'mem_priya', id, 'approve');
        first.db.close();

        const db = openDatabase(path);
        const svc = new CareService(db, { now: () => FIXED_NOW });
        const [reopened] = svc.getHandoffs(svc.resolveActor('mem_arjun'), { household_id: 'hh_rao' }).handoffs;
        expect(reopened).toMatchObject({ id, status: 'PENDING_ACCEPTANCE' });
        expect(reopened!.history.map(h => h.event)).toEqual(['propose', 'approve']);
        const done = svc.respondToHandoff(svc.resolveActor('mem_arjun'), { household_id: 'hh_rao', idempotency_key: 'after-restart-001', handoff_id: id, response: 'accept' });
        expect(done.handoff.status).toBe('COMPLETED');
        db.close();
    });

    it('upgrades an existing v1 database in place without touching its data', () => {
        const path = tempDbPath();
        const v1 = setup(FIXED_NOW, path);
        v1.svc.recordCareEvent(v1.as('mem_ravi'), { household_id: 'hh_rao', idempotency_key: 'pre-upgrade-001', kind: 'meal', note: 'synthetic: ate rice' });
        v1.db.exec('DROP TABLE handoff_transitions; DROP TABLE handoffs; PRAGMA user_version = 1;');
        v1.db.close();

        const db = openDatabase(path);
        expect((db.prepare('SELECT COUNT(*) AS n FROM care_events').get() as { n: number }).n).toBe(1);
        expect((db.prepare('SELECT COUNT(*) AS n FROM handoffs').get() as { n: number }).n).toBe(0);
        db.close();
    });
});

describe('audit trail', () => {
    it('records every attempt: who, what, target, outcome, and the stored transitions agree', () => {
        const s = setup();
        const id = propose(s).handoff.id;
        errorOf(() => decide(s, 'mem_arjun', id, 'approve')); // wrong role
        errorOf(() => respond(s, 'mem_arjun', id, 'accept')); // before approval
        decide(s, 'mem_priya', id, 'approve');
        errorOf(() => respond(s, 'mem_priya', id, 'accept')); // not the recipient
        respond(s, 'mem_arjun', id, 'accept');

        const rows = s.svc
            .auditTrail('hh_rao')
            .filter(a => /handoff/.test(a.action!))
            .map(a => [a.action, a.actor_member_id, a.target_id, a.outcome]);
        expect(rows).toEqual([
            ['propose_handoff', 'mem_ravi', id, 'ok'],
            ['decide_handoff', 'mem_arjun', null, 'denied'],
            ['respond_to_handoff', 'mem_arjun', null, 'conflict'],
            ['decide_handoff', 'mem_priya', id, 'ok'],
            ['respond_to_handoff', 'mem_priya', null, 'denied'],
            ['respond_to_handoff', 'mem_arjun', id, 'ok']
        ]);

        const stored = s.db.prepare('SELECT event, actor_member_id, actor_mode, at FROM handoff_transitions WHERE handoff_id = ? ORDER BY id').all(id);
        expect(stored).toEqual([
            { event: 'propose', actor_member_id: 'mem_ravi', actor_mode: 'session', at: FIXED_NOW.toISOString() },
            { event: 'approve', actor_member_id: 'mem_priya', actor_mode: 'session', at: FIXED_NOW.toISOString() },
            { event: 'accept', actor_member_id: 'mem_arjun', actor_mode: 'session', at: FIXED_NOW.toISOString() }
        ]);
    });
});

describe('simulated actor (demo only)', () => {
    const args = (extra: object) => ({ household_id: 'hh_rao', idempotency_key: key('sim'), handoff_id: 'x', decision: 'approve', ...extra });

    it('is refused unless the server enables it, and the refusal is audited', () => {
        const s = setup();
        const err = errorOf(() => s.svc.resolveSessionActor('mem_priya', 'decide_handoff', args({ simulated_actor_id: 'mem_ravi' }), false));
        expect(err).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'simulation_disabled' } });
        expect(s.svc.auditTrail('hh_rao').at(-1)).toMatchObject({ action: 'decide_handoff', actor_member_id: 'mem_priya', outcome: 'denied' });
    });

    it('when enabled, acts as a member of the session household only, and every record says it was simulated', () => {
        const s = setup();
        const id = propose(s).handoff.id;
        const asRavi = s.svc.resolveSessionActor('mem_priya', 'decide_handoff', args({ simulated_actor_id: 'mem_ravi' }), true);
        expect(asRavi).toMatchObject({ memberId: 'mem_ravi', role: 'care_recipient', simulatedBy: 'mem_priya' });
        const out = s.svc.decideHandoff(asRavi, { household_id: 'hh_rao', idempotency_key: key('sim'), handoff_id: id, decision: 'approve' });
        expect(out.handoff.history.at(-1)).toMatchObject({ event: 'approve', actor_mode: 'simulated', by: { name: 'Ravi' }, simulated_by: { name: 'Priya' } });
        const audit = s.svc.auditTrail('hh_rao').at(-1)!;
        expect(JSON.parse(audit.detail!)).toMatchObject({ simulated: true, simulated_by: 'mem_priya' });

        for (const outsider of ['mem_wei', 'mem_nobody']) {
            expect(errorOf(() => s.svc.resolveSessionActor('mem_priya', 'decide_handoff', args({ simulated_actor_id: outsider }), true)).details).toMatchObject({
                reason: 'simulated_actor_not_in_household'
            });
        }
    });

    it('does not widen authority: the simulated member is still checked by role and identity', () => {
        const s = setup();
        const id = propose(s).handoff.id;
        const asMeera = s.svc.resolveSessionActor('mem_priya', 'decide_handoff', args({ simulated_actor_id: 'mem_meera' }), true);
        expect(errorOf(() => s.svc.decideHandoff(asMeera, { household_id: 'hh_rao', idempotency_key: key('sim'), handoff_id: id, decision: 'approve' })).code).toBe('FORBIDDEN');
        const asArjun = s.svc.resolveSessionActor('mem_priya', 'decide_handoff', args({ simulated_actor_id: 'mem_arjun' }), true);
        expect(errorOf(() => s.svc.decideHandoff(asArjun, { household_id: 'hh_rao', idempotency_key: key('sim'), handoff_id: id, decision: 'approve' })).code).toBe('FORBIDDEN');
        expect(statusOf(s, id)).toBe('PENDING_APPROVAL');
    });

    it('is ignored for every other operation, so a model-style call cannot switch identity', () => {
        const s = setup();
        const actor = s.svc.resolveSessionActor('mem_ravi', 'propose_handoff', { household_id: 'hh_rao', simulated_actor_id: 'mem_priya' }, true);
        expect(actor).toMatchObject({ memberId: 'mem_ravi' });
        expect(actor.simulatedBy).toBeUndefined();
    });
});
