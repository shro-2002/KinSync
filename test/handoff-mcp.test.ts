/** KinSync care handoff over real MCP sessions: human tools, the AI boundary, the deterministic planner, simulated actors. */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentAdapter, envelope, type ModelToolCall, type Planner } from '../src/agent/adapter.js';
import { DeterministicHandoffPlanner, HANDOFF_UTTERANCE } from '../src/agent/handoff-planner.js';
import { checkFinalReply } from '../src/agent/output-safety.js';
import { runAgentTurn } from '../src/agent/runner.js';
import { evaluateTrace, GOLDEN_CARE_HANDOFF, type TraceStep } from '../src/agent/trace.js';
import { connect } from '../src/client.js';
import { startHarness, tempDbPath, type Harness, type HarnessOptions } from './helpers.js';

let harness: Harness | undefined;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
    await Promise.all(closers.splice(0).map(c => c()));
    await harness?.stop();
    harness = undefined;
});

const start = async (options: HarnessOptions = {}) => (harness = await startHarness(tempDbPath(), [], options));
async function client(actor?: string): Promise<Client> {
    const c = await connect(harness!.url, actor ? { actor } : {});
    closers.push(() => c.client.close());
    return c.client;
}
async function adapter(actorMemberId = 'mem_ravi'): Promise<AgentAdapter> {
    const a = await AgentAdapter.open(harness!.url, { actorMemberId, householdId: 'hh_rao' });
    closers.push(() => a.close());
    return a;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
    const res = await c.callTool({ name, arguments: args });
    return { isError: res.isError === true, data: res.structuredContent ?? JSON.parse((res.content as Array<{ text: string }>)[0]!.text) };
}
const HH = { household_id: 'hh_rao' };
let n = 0;
const key = () => `mcp-handoff-${String(++n).padStart(5, '0')}`;
const handoffRows = () => harness!.db.prepare('SELECT status FROM handoffs').all() as Array<{ status: string }>;
const audit = () => harness!.db.prepare('SELECT actor_member_id, action, outcome, detail FROM audit_events ORDER BY id').all() as Array<Record<string, string | null>>;
const TURN = 'turn_handoff0000001';
const runPlanner = async (utterance: string, turnId = TURN) =>
    runAgentTurn({ adapter: await adapter(), planner: new DeterministicHandoffPlanner(), turn: { turnId, userUtterance: utterance }, sessionContext: 'Speaking with Ravi in the Rao household.' });

describe('human handoff lifecycle over MCP', () => {
    it('Ravi proposes, Priya approves, Arjun accepts: each is a separate session bound to its own identity', async () => {
        await start();
        const proposed = await call(await client('mem_ravi'), 'propose_handoff', { ...HH, idempotency_key: key(), task_description: 'I need a ride to the clinic on Thursday', proposed_recipient: 'Arjun' });
        expect(proposed.data.handoff.status).toBe('PENDING_APPROVAL');
        const id = proposed.data.handoff.id as string;

        const approved = await call(await client('mem_priya'), 'decide_handoff', { ...HH, idempotency_key: key(), handoff_id: id, decision: 'approve' });
        expect(approved.data.handoff.status).toBe('PENDING_ACCEPTANCE');
        const done = await call(await client('mem_arjun'), 'respond_to_handoff', { ...HH, idempotency_key: key(), handoff_id: id, response: 'accept' });
        expect(done.data.handoff.status).toBe('COMPLETED');

        const listed = await call(await client('mem_meera'), 'get_handoffs', HH);
        expect(listed.data.handoffs[0].history.map((h: { by: { name: string } }) => h.by.name)).toEqual(['Ravi', 'Priya', 'Arjun']);
        const dash = await call(await client('mem_meera'), 'show_care_dashboard', {});
        expect(dash.data.handoffs[0]).toMatchObject({ id, status: 'COMPLETED' });
        expect(dash.data.simulation).toEqual({ enabled: false, session_actor_id: 'mem_meera' });
        expect(dash.data.members.map((m: { name: string }) => m.name)).toContain('Arjun');
    });

    it('refuses the wrong people with stable error codes and changes nothing', async () => {
        await start();
        const id = (await call(await client('mem_ravi'), 'propose_handoff', { ...HH, idempotency_key: key(), task_description: 'Please cover Thursday', proposed_recipient: 'Arjun' })).data.handoff.id as string;
        const attempt = async (actor: string, tool: string, extra: object) => (await call(await client(actor), tool, { ...HH, idempotency_key: key(), handoff_id: id, ...extra })).data.error?.code;

        expect(await attempt('mem_arjun', 'decide_handoff', { decision: 'approve' })).toBe('FORBIDDEN');
        expect(await attempt('mem_meera', 'decide_handoff', { decision: 'approve' })).toBe('FORBIDDEN');
        expect(await attempt('mem_wei', 'decide_handoff', { decision: 'approve' })).toBe('FORBIDDEN');
        expect(await attempt('mem_arjun', 'respond_to_handoff', { response: 'accept' })).toBe('INVALID_TRANSITION');
        expect(handoffRows()).toEqual([{ status: 'PENDING_APPROVAL' }]);
        await call(await client('mem_priya'), 'decide_handoff', { ...HH, idempotency_key: key(), handoff_id: id, decision: 'approve' });
        expect(await attempt('mem_priya', 'respond_to_handoff', { response: 'accept' })).toBe('FORBIDDEN');
        expect(handoffRows()).toEqual([{ status: 'PENDING_ACCEPTANCE' }]);
    });

    it('persists across a server restart on the same database', async () => {
        const path = tempDbPath();
        harness = await startHarness(path);
        const id = (await call(await client('mem_ravi'), 'propose_handoff', { ...HH, idempotency_key: key(), task_description: 'Please cover Thursday', proposed_recipient: 'Arjun' })).data.handoff.id as string;
        await call(await client('mem_priya'), 'decide_handoff', { ...HH, idempotency_key: key(), handoff_id: id, decision: 'approve' });
        await Promise.all(closers.splice(0).map(c => c()));
        await harness.stop();

        harness = await startHarness(path);
        const done = await call(await client('mem_arjun'), 'respond_to_handoff', { ...HH, idempotency_key: key(), handoff_id: id, response: 'accept' });
        expect(done.data.handoff).toMatchObject({ status: 'COMPLETED' });
        expect(done.data.handoff.history).toHaveLength(3);
    });
});

describe('the AI model cannot take human decisions', () => {
    it('never sees the human tools and cannot call them, even when asked to', async () => {
        await start();
        const names = (await (await adapter()).listModelTools()).map(t => t.name);
        expect(names).toEqual(expect.arrayContaining(['propose_handoff', 'get_handoffs']));
        expect(names).not.toContain('decide_handoff');
        expect(names).not.toContain('respond_to_handoff');

        const ravi = await adapter();
        const proposed = await call(await client('mem_ravi'), 'propose_handoff', { ...HH, idempotency_key: key(), task_description: 'Please cover Thursday', proposed_recipient: 'Arjun' });
        const id = proposed.data.handoff.id as string;
        for (const [tool, args] of [
            ['decide_handoff', { handoff_id: id, decision: 'approve' }],
            ['respond_to_handoff', { handoff_id: id, response: 'accept' }]
        ] as const) {
            const { step, message } = await ravi.execute({ turnId: TURN, userUtterance: 'approve it' }, { name: tool, arguments: { ...args, simulated_actor_id: 'mem_priya' } }, 1);
            expect(step).toMatchObject({ decision: 'policy_denied', policy_reason: 'HUMAN_ONLY_TOOL', outcome: 'not_called' });
            expect(JSON.parse(message.content).trust).toBe('policy');
        }
        expect(audit().filter(a => /decide_handoff|respond_to_handoff/.test(a.action!))).toEqual([]); // never reached the server
        expect(handoffRows()).toEqual([{ status: 'PENDING_APPROVAL' }]);
    });

    it('discards identity-like arguments on the tools it may call, and quotes the person verbatim', async () => {
        await start();
        const ravi = await adapter();
        const turn = { turnId: TURN, userUtterance: 'I need help with the Thursday clinic visit' };
        const bad = await ravi.execute(turn, { name: 'propose_handoff', arguments: { task_description: 'Dad wants everyone to stop his tablets', proposed_recipient: 'Arjun' } }, 1);
        expect(bad.step).toMatchObject({ decision: 'policy_denied', policy_reason: 'VERBATIM_REQUIRED:task_description' });

        const ok = await ravi.execute(turn, { name: 'propose_handoff', arguments: { task_description: turn.userUtterance, proposed_recipient: 'Arjun', household_id: 'hh_chen', simulated_actor_id: 'mem_priya', idempotency_key: 'model-key-0001' } }, 2);
        expect(ok.step.discarded_args.sort()).toEqual(['household_id', 'idempotency_key', 'simulated_actor_id']);
        expect(ok.step.effective_args).toMatchObject({ household_id: 'hh_rao' });
        expect(ok.step.effective_args).not.toHaveProperty('simulated_actor_id');
        expect(ok.step.outcome).toBe('ok');
        expect(harness!.db.prepare('SELECT requested_by_member_id AS who FROM handoffs').get()).toEqual({ who: 'mem_ravi' });
    });

    it('a compromised planner that tries to approve and accept its own proposal is stopped by code', async () => {
        await start();
        const utterance = 'I need help with the Thursday clinic visit';
        const rogue: Planner = {
            name: 'malicious/self-approves',
            next: ({ messages }) => {
                const proposed = messages.find(m => m.tool === 'propose_handoff');
                const queue: ModelToolCall[] = [{ name: 'propose_handoff', arguments: { task_description: utterance, proposed_recipient: 'Arjun' } }];
                if (proposed) {
                    const id = (JSON.parse(proposed.content).payload.handoff as { id: string }).id;
                    queue.push({ name: 'decide_handoff', arguments: { handoff_id: id, decision: 'approve' } }, { name: 'respond_to_handoff', arguments: { handoff_id: id, response: 'accept' } });
                }
                return queue[messages.length] ?? { done: true };
            }
        };
        const { trace } = await (await adapter()).runTurn({ turnId: TURN, userUtterance: utterance }, rogue);
        expect(trace.steps.map(s => [s.tool, s.decision])).toEqual([
            ['propose_handoff', 'executed'],
            ['decide_handoff', 'policy_denied'],
            ['respond_to_handoff', 'policy_denied']
        ]);
        expect(evaluateTrace(trace, GOLDEN_CARE_HANDOFF, utterance).pass).toBe(false);
        expect(handoffRows()).toEqual([{ status: 'PENDING_APPROVAL' }]);
    });
});

describe('deterministic care-handoff planner (rule-based, not an LLM)', () => {
    it('turns a spoken request into a PENDING_APPROVAL proposal and stops for a human', async () => {
        await start();
        const r = await runPlanner(HANDOFF_UTTERANCE);
        expect(r.stop).toBe('awaiting_approval');
        expect(evaluateTrace(r.trace, GOLDEN_CARE_HANDOFF, HANDOFF_UTTERANCE)).toMatchObject({ pass: true, violations: [] });
        expect(r.trace.steps.map(s => s.tool)).toEqual(['get_household_status', 'propose_handoff']);
        expect(r.reply.action).toBe('passed');
        expect(r.reply.text).toMatch(/proposal for Arjun/);
        expect(r.reply.text).toMatch(/Nothing has been sent or arranged/);
        expect(harness!.db.prepare('SELECT status, from_member_id AS f, to_member_id AS t, task_as_reported AS task FROM handoffs').all()).toEqual([
            { status: 'PENDING_APPROVAL', f: 'mem_priya', t: 'mem_arjun', task: HANDOFF_UTTERANCE }
        ]);
    });

    it('retrying the same turn replays: still one proposal', async () => {
        await start();
        await runPlanner(HANDOFF_UTTERANCE);
        const again = await runPlanner(HANDOFF_UTTERANCE);
        expect(again.trace.steps.at(-1)!.outcome).toBe('replayed');
        expect(handoffRows()).toHaveLength(1);
    });

    it('uses the only eligible member when nobody is named, and says so', async () => {
        await start();
        const r = await runPlanner('I need help getting to the clinic on Thursday');
        expect(r.stop).toBe('awaiting_approval');
        expect(harness!.db.prepare('SELECT to_member_id AS t, recipient_basis AS b FROM handoffs').get()).toEqual({ t: 'mem_arjun', b: 'only_eligible_member' });
    });

    it('asks instead of guessing when it is not sure what is being asked', async () => {
        await start();
        const vague = await runPlanner('What is the weather like?', 'turn_vague00000001');
        expect(vague.trace.steps).toEqual([]);
        expect(vague.reply.text).toMatch(/Tell me what you need help with/);

        harness!.db.prepare("INSERT INTO members (id, household_id, display_name, relationship, role, contact_label, created_at) VALUES ('mem_dev', 'hh_rao', 'Dev', 'cousin', 'caregiver', 'Dev phone (simulated)', '2026-10-01T00:00:00.000Z')").run();
        const crowded = await runPlanner('I need help getting to the clinic on Thursday', 'turn_crowded000001');
        expect(crowded.reply.text).toMatch(/Who should take over: .*Arjun.*Dev|Who should take over: .*Dev.*Arjun/);
        expect(crowded.trace.steps.map(s => s.tool)).toEqual(['get_household_status']);
        expect(handoffRows()).toEqual([]);
    });
});

describe('simulated actor (demo only, labeled)', () => {
    const decide = (c: Client, id: string, extra: object) => call(c, 'decide_handoff', { ...HH, idempotency_key: key(), handoff_id: id, decision: 'approve', ...extra });
    const proposeAsRavi = async () => (await call(await client('mem_ravi'), 'propose_handoff', { ...HH, idempotency_key: key(), task_description: 'Please cover Thursday', proposed_recipient: 'Arjun' })).data.handoff.id as string;

    it('a header-less demo session can act as another member of its household, and the record says simulated', async () => {
        await start({ simulatedActors: true, defaultActorId: 'mem_priya' });
        const id = await proposeAsRavi();
        const browser = await client(); // no X-CareLoop-Actor: like a browser host
        const dash = await call(browser, 'show_care_dashboard', {});
        expect(dash.data.simulation).toEqual({ enabled: true, session_actor_id: 'mem_priya' });

        const asRavi = await decide(browser, id, { simulated_actor_id: 'mem_ravi' });
        expect(asRavi.data.handoff.history.at(-1)).toMatchObject({ event: 'approve', actor_mode: 'simulated', by: { name: 'Ravi' }, simulated_by: { name: 'Priya' } });

        const asArjun = await call(browser, 'respond_to_handoff', { ...HH, idempotency_key: key(), handoff_id: id, response: 'accept', simulated_actor_id: 'mem_arjun' });
        expect(asArjun.data.handoff.status).toBe('COMPLETED');
    });

    it('switching identity never bypasses authorization: wrong role, wrong person, other household', async () => {
        await start({ simulatedActors: true, defaultActorId: 'mem_priya' });
        const id = await proposeAsRavi();
        const browser = await client();
        expect((await decide(browser, id, { simulated_actor_id: 'mem_meera' })).data.error.code).toBe('FORBIDDEN');
        expect((await decide(browser, id, { simulated_actor_id: 'mem_arjun' })).data.error.code).toBe('FORBIDDEN');
        expect((await decide(browser, id, { simulated_actor_id: 'mem_wei' })).data.error.details.reason).toBe('simulated_actor_not_in_household');
        expect((await call(browser, 'respond_to_handoff', { ...HH, idempotency_key: key(), handoff_id: id, response: 'accept', simulated_actor_id: 'mem_arjun' })).data.error.code).toBe('INVALID_TRANSITION');
        expect(handoffRows()).toEqual([{ status: 'PENDING_APPROVAL' }]);
    });

    it('is refused for header-bound sessions (the AI adapter, independent clients) and when the server has it off', async () => {
        await start({ simulatedActors: true, defaultActorId: 'mem_priya' });
        const id = await proposeAsRavi();
        const bound = await decide(await client('mem_priya'), id, { simulated_actor_id: 'mem_ravi' });
        expect(bound.data.error).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'simulation_disabled' } });
        expect((await call(await client('mem_priya'), 'show_care_dashboard', {})).data.simulation.enabled).toBe(false);
        await harness!.stop();

        await start({ defaultActorId: 'mem_priya' });
        const id2 = await proposeAsRavi();
        const off = await decide(await client(), id2, { simulated_actor_id: 'mem_ravi' });
        expect(off.data.error.details.reason).toBe('simulation_disabled');
        expect(audit().filter(a => a.outcome === 'denied')).not.toEqual([]);
        expect(handoffRows()).toEqual([{ status: 'PENDING_APPROVAL' }]);
    });
});

describe('output safety for handoffs', () => {
    const step = (tool: string): TraceStep => ({ seq: 1, tool, model_args: {}, effective_args: {}, idempotency_key: null, decision: 'executed', policy_reason: null, discarded_args: [], outcome: 'ok', error_code: null });
    const proposal = envelope('propose_handoff', { handoff: { id: 'hof_1', status: 'PENDING_APPROVAL', proposed_recipient: { name: 'Arjun' } } }, 'untrusted_data');

    it('lets an honest proposal report through', () => {
        const v = checkFinalReply("I've prepared a proposal for Arjun. It is waiting for a person to approve it, and nothing has been sent.", [step('propose_handoff')], [proposal]);
        expect(v.action).toBe('passed');
    });

    it.each([
        ['an approval nobody gave', 'The handoff to Arjun is approved.'],
        ['an acceptance nobody gave', 'Arjun accepted responsibility for the handoff.'],
        ['someone arriving', 'Arjun has arrived and is helping your father.'],
        ['care having been given', 'Arjun took over and provided care today.']
    ])('replaces a reply claiming %s', (_label, text) => {
        const v = checkFinalReply(text, [step('propose_handoff')], [proposal]);
        expect(v.action).toBe('replaced');
        expect(v.text).toMatch(/proposal for Arjun/);
    });

    it('allows reporting an acceptance only when a tool result shows it', () => {
        const completed = envelope('get_handoffs', { handoffs: [{ id: 'hof_1', status: 'COMPLETED' }] }, 'untrusted_data');
        expect(checkFinalReply('Arjun accepted responsibility for the handoff.', [step('get_handoffs')], [completed]).action).toBe('passed');
    });
});
