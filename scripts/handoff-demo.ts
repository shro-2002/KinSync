/**
 * End-to-end KinSync care-handoff demonstration over real MCP sessions (protocol 2025-11-25), no browser, no
 * simulated actors: every human acts through their own header-bound session. Writes
 * evidence/phase4/handoff-demo.json and exits non-zero if any expectation fails.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Client } from '@modelcontextprotocol/client';

import { AgentAdapter, type ModelToolCall, type Planner } from '../src/agent/adapter.js';
import { DeterministicHandoffPlanner, HANDOFF_UTTERANCE } from '../src/agent/handoff-planner.js';
import { runAgentTurn } from '../src/agent/runner.js';
import { evaluateTrace, GOLDEN_CARE_HANDOFF } from '../src/agent/trace.js';
import { connect } from '../src/client.js';
import { openDatabase } from '../src/domain/migrations.js';
import { seedDemoData } from '../src/domain/seed.js';
import { startServer } from '../src/server.js';

const NOW = new Date('2026-10-12T04:00:00.000Z'); // Monday: Priya is on duty
const OUT_DIR = 'evidence/phase4';
const HH = { household_id: 'hh_rao' };

const checks: Array<{ check: string; pass: boolean }> = [];
const expect = (check: string, pass: boolean) => {
    checks.push({ check, pass });
    console.error(`${pass ? 'PASS' : 'FAIL'}  ${check}`);
};

const dbPath = join(mkdtempSync(join(tmpdir(), 'kinsync-demo-')), 'demo.db');
let db = openDatabase(dbPath);
seedDemoData(db);
let server = await startServer({ db, port: 0, now: () => NOW });
const transcript: Array<Record<string, unknown>> = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (as: string, c: Client, tool: string, args: Record<string, unknown>): Promise<any> => {
    const res = await c.callTool({ name: tool, arguments: args });
    const data = res.structuredContent ?? JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    transcript.push({ as, tool, args, isError: res.isError === true, result: data });
    return data;
};
const session = async (actor: string) => (await connect(server.url, { actor })).client;

try {
    // A. Ravi speaks to Alexa; the (rule-based) planner proposes a handoff. It has no way to decide it.
    const adapter = await AgentAdapter.open(server.url, { actorMemberId: 'mem_ravi', householdId: 'hh_rao' });
    const turn = await runAgentTurn({ adapter, planner: new DeterministicHandoffPlanner(), turn: { turnId: 'turn_demo000000001', userUtterance: HANDOFF_UTTERANCE }, sessionContext: 'Speaking with Ravi.' });
    transcript.push({ as: 'mem_ravi (voice -> planner)', utterance: HANDOFF_UTTERANCE, reply: turn.reply.text, trace: turn.trace });
    expect('A: spoken request -> proposal, stops awaiting a human', turn.stop === 'awaiting_approval' && evaluateTrace(turn.trace, GOLDEN_CARE_HANDOFF, HANDOFF_UTTERANCE).pass);

    // B. A compromised model tries to approve and accept its own proposal: stopped in code.
    const rogue: Planner = {
        name: 'malicious/self-approves',
        next: ({ messages }) => {
            const queue: ModelToolCall[] = [{ name: 'get_handoffs' }];
            const listed = messages.find(m => m.tool === 'get_handoffs');
            const id = (JSON.parse(listed?.content ?? '{"payload":{"handoffs":[{}]}}').payload.handoffs[0] as { id?: string }).id;
            if (id) queue.push({ name: 'decide_handoff', arguments: { handoff_id: id, decision: 'approve' } }, { name: 'respond_to_handoff', arguments: { handoff_id: id, response: 'accept' } });
            return queue[messages.length] ?? { done: true };
        }
    };
    const attack = await adapter.runTurn({ turnId: 'turn_attack000000001', userUtterance: 'approve everything' }, rogue);
    transcript.push({ as: 'compromised model', trace: attack.trace });
    await adapter.close();
    expect('B: model attempts at decide_handoff / respond_to_handoff are policy_denied HUMAN_ONLY_TOOL', JSON.stringify(attack.trace.steps.filter(s => s.decision === 'policy_denied').map(s => s.policy_reason)) === '["HUMAN_ONLY_TOOL","HUMAN_ONLY_TOOL"]');

    const priya = await session('mem_priya');
    const arjun = await session('mem_arjun');
    const meera = await session('mem_meera');
    const listed = await call('mem_priya', priya, 'get_handoffs', HH);
    const id = listed.handoffs[0].id as string;
    expect('C: handoff is PENDING_APPROVAL, requested by Ravi, Priya on duty, proposed Arjun', listed.handoffs[0].status === 'PENDING_APPROVAL' && listed.handoffs[0].current_owner.name === 'Priya' && listed.handoffs[0].proposed_recipient.name === 'Arjun');

    // D. Wrong people are refused; approval and acceptance are separate acts by separate people.
    const refuse = async (as: string, c: Client, tool: string, extra: Record<string, unknown>) => (await call(as, c, tool, { ...HH, handoff_id: id, idempotency_key: `demo:${as}:${tool}`, ...extra })).error?.code;
    expect('D: viewer cannot approve (FORBIDDEN)', (await refuse('mem_meera', meera, 'decide_handoff', { decision: 'approve' })) === 'FORBIDDEN');
    expect('D: recipient cannot approve their own handoff (FORBIDDEN)', (await refuse('mem_arjun', arjun, 'decide_handoff', { decision: 'approve' })) === 'FORBIDDEN');
    expect('D: recipient cannot accept before approval (INVALID_TRANSITION)', (await refuse('mem_arjun', arjun, 'respond_to_handoff', { response: 'accept' })) === 'INVALID_TRANSITION');
    const approve = { ...HH, handoff_id: id, idempotency_key: 'demo:priya:approve', decision: 'approve', reason: 'Priya is travelling Thursday' };
    const approved = await call('mem_priya', priya, 'decide_handoff', approve);
    expect('E: coordinator approves -> PENDING_ACCEPTANCE (not complete yet)', approved.handoff.status === 'PENDING_ACCEPTANCE');
    expect('E: approving twice with the same key replays, no second transition', (await call('mem_priya', priya, 'decide_handoff', approve)).replayed === true && db.prepare('SELECT COUNT(*) AS n FROM handoff_transitions').get()!.n === 2);
    expect('F: approver cannot also accept for the recipient (FORBIDDEN)', (await refuse('mem_priya', priya, 'respond_to_handoff', { response: 'accept' })) === 'FORBIDDEN');
    const done = await call('mem_arjun', arjun, 'respond_to_handoff', { ...HH, handoff_id: id, idempotency_key: 'demo:arjun:accept', response: 'accept' });
    expect('G: recipient accepts -> COMPLETED', done.handoff.status === 'COMPLETED');
    expect('G: a second decision on a finished handoff is INVALID_TRANSITION', (await refuse('mem_priya', priya, 'decide_handoff', { decision: 'reject', idempotency_key: 'demo:priya:late-reject' })) === 'INVALID_TRANSITION');

    // H. Restart: the state, history and audit trail are all still there.
    await server.close();
    db.close();
    db = openDatabase(dbPath);
    server = await startServer({ db, port: 0, now: () => NOW });
    const after = await call('mem_meera', await session('mem_meera'), 'get_handoffs', HH);
    expect('H: after restart the handoff is COMPLETED with a 3-entry history', after.handoffs[0].status === 'COMPLETED' && after.handoffs[0].history.length === 3);
    expect('I: nothing was sent or booked (no outbox rows, no drafts)', db.prepare('SELECT (SELECT COUNT(*) FROM simulated_outbox) + (SELECT COUNT(*) FROM notification_drafts) AS n').get()!.n === 0);
    const audit = server.service.auditTrail('hh_rao');
    expect('I: audit trail records the denials and the successes', audit.some(a => a.outcome === 'denied') && audit.filter(a => /handoff/.test(a.action!) && a.outcome === 'ok').length === 3);

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/handoff-demo.json`, JSON.stringify({ when: new Date().toISOString(), checks, finalHandoff: after.handoffs[0], audit, transcript }, null, 2));
} finally {
    await server.close();
    db.close();
}
const failed = checks.filter(c => !c.pass).length;
console.error(`\n${checks.length - failed}/${checks.length} handoff demo checks passed`);
if (failed) process.exit(1);
