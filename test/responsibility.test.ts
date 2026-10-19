/** "Who's taking Dad to the clinic Thursday?" answered from persisted handoff state over real MCP sessions; read-only. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentAdapter, envelope } from '../src/agent/adapter.js';
import { checkFinalReply } from '../src/agent/output-safety.js';
import { answerResponsibility, DeterministicResponsibilityPlanner, RESPONSIBILITY_QUESTION, type HandoffRecord } from '../src/agent/responsibility-planner.js';
import { runAgentTurn } from '../src/agent/runner.js';
import type { TraceStep } from '../src/agent/trace.js';
import { connect } from '../src/client.js';
import { startHarness, tempDbPath, type Harness } from './helpers.js';

let harness: Harness | undefined;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
    await Promise.all(closers.splice(0).map(c => c()));
    await harness?.stop();
    harness = undefined;
});

const HH = { household_id: 'hh_rao' };
const TASK = 'I need help getting to my clinic visit on Thursday. Can Arjun take over from Priya?';
let n = 0;
const key = () => `who-has-it-${String(++n).padStart(5, '0')}`;

async function client(actor: string): Promise<Client> {
    const c = await connect(harness!.url, { actor });
    closers.push(() => c.client.close());
    return c.client;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (actor: string, name: string, args: Record<string, unknown>): Promise<any> => {
    const res = await (await client(actor)).callTool({ name, arguments: args });
    return res.structuredContent ?? JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
};
const snapshot = () => JSON.stringify(harness!.db.prepare('SELECT id, status, version FROM handoffs ORDER BY id').all()) + JSON.stringify(harness!.db.prepare('SELECT COUNT(*) AS n FROM handoff_transitions').get());

async function ask(question = RESPONSIBILITY_QUESTION, actorMemberId = 'mem_meera', householdId = 'hh_rao') {
    const adapter = await AgentAdapter.open(harness!.url, { actorMemberId, householdId });
    closers.push(() => adapter.close());
    const before = snapshot();
    const turn = await runAgentTurn({ adapter, planner: new DeterministicResponsibilityPlanner(), turn: { turnId: `turn_who${String(++n).padStart(12, '0')}`, userUtterance: question }, sessionContext: 'Simulated Alexa+ turn.' });
    // Read-only: only read tools were called, and the persisted handoff state is byte-for-byte unchanged.
    expect(turn.trace.steps.map(s => s.tool).every(t => t === 'get_household_status' || t === 'get_handoffs')).toBe(true);
    expect(snapshot()).toBe(before);
    expect(turn.reply.action).toBe('passed'); // output safety found nothing it had to replace
    return turn.reply.text;
}
const propose = async () => (await call('mem_ravi', 'propose_handoff', { ...HH, idempotency_key: key(), task_description: TASK, proposed_recipient: 'mem_arjun' })).handoff.id as string;
const decide = (id: string, decision: 'approve' | 'reject') => call('mem_priya', 'decide_handoff', { ...HH, idempotency_key: key(), handoff_id: id, decision });
const respond = (id: string, response: 'accept' | 'decline') => call('mem_arjun', 'respond_to_handoff', { ...HH, idempotency_key: key(), handoff_id: id, response });

describe("who's got Thursday? over MCP (read-only)", () => {
    it('follows the lifecycle: no record -> Priya still -> Priya STILL after approval -> Arjun only after he accepts', async () => {
        harness = await startHarness();
        expect(await ask()).toBe("There is no handoff or agreement recorded for Ravi's clinic on Thursday, so I can't say who is responsible. I won't guess.");
        const id = await propose();
        expect(await ask()).toBe('Priya is still responsible. Ravi asked for Arjun to take over, but nobody has approved that yet.');
        await decide(id, 'approve');
        expect(await ask()).toBe("Priya still has it. Priya approved asking Arjun, but Arjun hasn't said yes yet, so nothing has moved.");
        await respond(id, 'accept');
        expect(await ask()).toBe('Arjun accepted the handoff. Arjun is now listed as responsible for it. That is a family agreement, not proof the visit happened.');
    });

    it('rejected: the handoff did not go through and Priya remains responsible', async () => {
        harness = await startHarness();
        await decide(await propose(), 'reject');
        expect(await ask()).toBe("The handoff didn't go through: Priya said no. Priya remains responsible.");
    });

    it('declined: the handoff did not go through and Priya remains responsible', async () => {
        harness = await startHarness();
        const id = await propose();
        await decide(id, 'approve');
        await respond(id, 'decline');
        expect(await ask()).toBe("The handoff didn't go through: Arjun said no. Priya remains responsible.");
    });

    it('the short question works too, and any household member may ask (Ravi himself)', async () => {
        harness = await startHarness();
        const id = await propose();
        await decide(id, 'approve');
        expect(await ask("Who's taking Dad Thursday?", 'mem_ravi')).toBe("Priya still has it. Priya approved asking Arjun, but Arjun hasn't said yes yet, so nothing has moved.");
    });

    it('household isolation: the Chen household sees no Rao records, and a Chen member cannot read Rao', async () => {
        harness = await startHarness();
        await propose();
        expect(await ask("Who's taking Mom to the clinic Thursday?", 'mem_wei', 'hh_chen')).toBe("There is no handoff or agreement recorded for Lin's clinic on Thursday, so I can't say who is responsible. I won't guess.");
        expect(await ask(RESPONSIBILITY_QUESTION, 'mem_wei', 'hh_rao')).toBe("I couldn't read this household's records, so I can't say who is responsible. Nothing was changed.");
    });

    it('persists: after a server restart on the same database the answer is unchanged', async () => {
        const path = tempDbPath();
        harness = await startHarness(path);
        const id = await propose();
        await decide(id, 'approve');
        await respond(id, 'accept');
        const before = await ask();
        await Promise.all(closers.splice(0).map(c => c()));
        await harness.stop();
        harness = await startHarness(path);
        expect(await ask()).toBe(before);
    });
});

describe('pnpm ask (thin print wrapper over the same read-only planner)', () => {
    it("prints the question, the read-only MCP calls, and the server's real answer, and changes nothing", async () => {
        harness = await startHarness();
        const id = await propose();
        await decide(id, 'approve');
        const before = snapshot();
        // Async on purpose: the server under test lives in this process, so a blocking spawn would starve it.
        const { stdout: out } = await promisify(execFile)('pnpm', ['exec', 'tsx', 'scripts/ask.ts', "Who's taking Dad Thursday?", '--url', harness.url, '--as', 'mem_priya'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
        expect(out).toContain('[SIMULATED ALEXA+ - typed question] "Who\'s taking Dad Thursday?"');
        expect(out).toContain('MCP calls: get_household_status, get_handoffs  (read-only: yes)');
        expect(out).toContain(`KinSync: "${await ask("Who's taking Dad Thursday?", 'mem_priya')}"`);
        expect(snapshot()).toBe(before);
    }, 60_000);
});

describe('second layer: output safety will not let any planner claim acceptance the server has not recorded', () => {
    const steps = [{ tool: 'get_handoffs', decision: 'executed', outcome: 'ok' }] as unknown as TraceStep[];
    const seen = (status: string) => [envelope('get_handoffs', { handoffs: [{ status }] }, 'untrusted_data')];
    const claim = 'Arjun accepted the handoff. Arjun is now listed as responsible for it.';
    it('replaces the claim while the server says PENDING_ACCEPTANCE', () => {
        expect(checkFinalReply(claim, steps, seen('PENDING_ACCEPTANCE'))).toMatchObject({ action: 'replaced', violations: [{ rule: 'unconfirmed_claim' }] });
    });
    it('lets it through once the server says COMPLETED', () => {
        expect(checkFinalReply(claim, steps, seen('COMPLETED')).action).toBe('passed');
    });
});

describe('answerResponsibility: asks or refuses instead of guessing', () => {
    const members = [
        { member_id: 'mem_ravi', name: 'Ravi', relationship: 'father', role: 'care_recipient' },
        { member_id: 'mem_priya', name: 'Priya', relationship: 'daughter', role: 'coordinator' },
        { member_id: 'mem_arjun', name: 'Arjun', relationship: 'son', role: 'caregiver' }
    ];
    const person = (id: string) => ({ member_id: id, name: members.find(m => m.member_id === id)!.name });
    const handoff = (over: Partial<HandoffRecord>): HandoffRecord => ({
        id: 'hof_1', status: 'PENDING_APPROVAL', task_description: TASK, requested_by: person('mem_ravi'), current_owner: person('mem_priya'),
        proposed_recipient: person('mem_arjun'), approval: { by: null }, updated_at: '2026-10-12T04:00:00.000Z', ...over
    });

    it('no task and no day: asks which', () => {
        expect(answerResponsibility("Who's taking Dad?", members, [handoff({})])).toBe('Which task or day do you mean? I can only answer from what the family has recorded.');
    });
    it('a relative who is not in the household: asks for a name', () => {
        expect(answerResponsibility("Who's taking Mom to the clinic Thursday?", members, [handoff({})])).toBe('I can\'t tell who "mom" is in this household. Could you use their name?');
    });
    it('two people named: asks which one', () => {
        expect(answerResponsibility("Who's taking Ravi or Priya to the clinic Thursday?", members, [])).toBe("Do you mean Ravi or Priya? I can't tell who you're asking about.");
    });
    it('a different day has no record: refuses to guess', () => {
        expect(answerResponsibility("Who's taking Dad to the clinic Friday?", members, [handoff({})])).toMatch(/^There is no handoff or agreement recorded for Ravi's clinic on Friday.*I won't guess\.$/);
    });
    it('two open handoffs for the same visit: will not pick one', () => {
        const two = [handoff({}), handoff({ id: 'hof_2', proposed_recipient: person('mem_priya'), current_owner: person('mem_arjun') })];
        expect(answerResponsibility(RESPONSIBILITY_QUESTION, members, two)).toBe("More than one open handoff matches Ravi's clinic on Thursday (to Arjun and Priya), so I can't give one answer. Check the dashboard.");
    });
    it('a later open proposal outranks an earlier declined one', () => {
        const history = [handoff({ id: 'hof_old', status: 'DECLINED', updated_at: '2026-10-11T00:00:00.000Z' }), handoff({ id: 'hof_new' })];
        expect(answerResponsibility(RESPONSIBILITY_QUESTION, members, history)).toMatch(/^Priya is still responsible\./);
    });
});
