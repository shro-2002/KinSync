/**
 * "Who's got Thursday?" end-to-end, over real MCP sessions (protocol 2025-11-25) on a real SQLite file.
 * SIMULATED Alexa+ turn (typed question, rule-based read-only planner); synthetic data. Every answer is produced
 * live by runAgentTurn from get_household_status + get_handoffs; nothing below prints a canned reply.
 * Writes evidence/phase7/who-has-it-demo.json and exits non-zero if any expectation fails.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentAdapter } from '../src/agent/adapter.js';
import { DeterministicResponsibilityPlanner, RESPONSIBILITY_QUESTION } from '../src/agent/responsibility-planner.js';
import { runAgentTurn } from '../src/agent/runner.js';
import { connect } from '../src/client.js';
import { openDatabase } from '../src/domain/migrations.js';
import { seedDemoData } from '../src/domain/seed.js';
import { startServer } from '../src/server.js';

const NOW = new Date('2026-10-12T04:00:00.000Z'); // Monday: Priya is on duty when the request is made
const OUT_DIR = 'evidence/phase7';
const HH = { household_id: 'hh_rao' };
const TASK = 'I need help getting to my clinic visit on Thursday. Can Arjun take over from Priya?';

const log: Array<Record<string, unknown>> = [];
const checks: Array<{ check: string; pass: boolean }> = [];
const expect = (check: string, pass: boolean) => {
    checks.push({ check, pass });
    console.log(`    [${pass ? 'PASS' : 'FAIL'}] ${check}`);
};
const step = (title: string) => console.log(`\n== ${title}`);

async function scenario(dbPath: string) {
    let db = openDatabase(dbPath);
    seedDemoData(db);
    let server = await startServer({ db, port: 0, now: () => NOW });
    let turnNo = 0;
    const ask = async (question = RESPONSIBILITY_QUESTION, asker = 'mem_meera') => {
        const adapter = await AgentAdapter.open(server.url, { actorMemberId: asker, householdId: 'hh_rao' });
        const before = JSON.stringify(db.prepare('SELECT id, status, version FROM handoffs').all());
        const turn = await runAgentTurn({ adapter, planner: new DeterministicResponsibilityPlanner(), turn: { turnId: `turn_who${String(++turnNo).padStart(12, '0')}`, userUtterance: question }, sessionContext: 'Simulated Alexa+ turn.' });
        await adapter.close();
        const tools = turn.trace.steps.map(s => s.tool);
        const unchanged = before === JSON.stringify(db.prepare('SELECT id, status, version FROM handoffs').all());
        console.log(`  [SIMULATED ALEXA+] ${asker.replace('mem_', '')}: "${question}"`);
        console.log(`  MCP calls: ${tools.join(', ')} (read-only; handoff rows unchanged: ${unchanged})`);
        console.log(`  KinSync: "${turn.reply.text}"`);
        log.push({ question, asker, tools, reply: turn.reply.text, safety: turn.reply.action, state_unchanged: unchanged });
        expect('question used read tools only and changed no state', unchanged && tools.every(t => t === 'get_household_status' || t === 'get_handoffs'));
        return turn.reply.text;
    };
    // Humans act through their own header-bound MCP sessions, exactly as in pnpm handoff:demo.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const act = async (actor: string, tool: string, args: Record<string, unknown>): Promise<any> => {
        const { client } = await connect(server.url, { actor });
        const res = await client.callTool({ name: tool, arguments: args });
        await client.close();
        const data = res.structuredContent ?? JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
        console.log(`  ${actor.replace('mem_', '')} -> ${tool}: ${data.handoff?.status ?? data.error?.code}`);
        log.push({ actor, tool, args, status: data.handoff?.status ?? null, error: data.error ?? null });
        return data;
    };
    const restart = async () => {
        await server.close();
        db.close();
        db = openDatabase(dbPath);
        server = await startServer({ db, port: 0, now: () => NOW });
        console.log(`  server stopped and started again on the same database file -> ${server.url}`);
    };
    return { ask, act, restart, close: async () => (await server.close(), db.close()) };
}

const dir = mkdtempSync(join(tmpdir(), 'kinsync-who-'));
console.log('KinSync "Who\'s got Thursday?" -- SIMULATED Alexa+ workflow (not native Alexa+). Synthetic data. Rule-based planner (not an LLM).');

const main = await scenario(join(dir, 'main.db'));
try {
    step('1-3. Before anyone has asked for help');
    expect('no record -> refuses to name anyone', (await main.ask()).includes("I won't guess"));

    step('4-6. Ravi asks for Arjun to take over (proposal only)');
    const id = (await main.act('mem_ravi', 'propose_handoff', { ...HH, idempotency_key: 'who:propose', task_description: TASK, proposed_recipient: 'mem_arjun' })).handoff.id;
    expect('pending approval -> Priya is still responsible', (await main.ask()).startsWith('Priya is still responsible.'));

    step('7-9. Priya approves -- Arjun has been asked, he has not said yes');
    await main.act('mem_priya', 'decide_handoff', { ...HH, idempotency_key: 'who:approve', handoff_id: id, decision: 'approve' });
    expect("approved -> Priya STILL has it; Arjun hasn't said yes", /^Priya still has it\..*hasn't said yes yet/.test(await main.ask("Who's taking Dad Thursday?")));

    step('10-12. Arjun accepts');
    await main.act('mem_arjun', 'respond_to_handoff', { ...HH, idempotency_key: 'who:accept', handoff_id: id, response: 'accept' });
    const after = await main.ask("Who's taking Dad Thursday?");
    expect('accepted -> Arjun is now listed as responsible', after.startsWith('Arjun accepted the handoff.'));

    step('14. Restart the server; ask again');
    await main.restart();
    expect('after restart the answer is identical', (await main.ask("Who's taking Dad Thursday?")) === after);
} finally {
    await main.close();
}

const isolated = await scenario(join(dir, 'decline.db'));
try {
    step('13. Separate database: Priya approves, Arjun declines');
    const id = (await isolated.act('mem_ravi', 'propose_handoff', { ...HH, idempotency_key: 'who:propose', task_description: TASK, proposed_recipient: 'mem_arjun' })).handoff.id;
    await isolated.act('mem_priya', 'decide_handoff', { ...HH, idempotency_key: 'who:approve', handoff_id: id, decision: 'approve' });
    await isolated.act('mem_arjun', 'respond_to_handoff', { ...HH, idempotency_key: 'who:decline', handoff_id: id, response: 'decline' });
    expect('declined -> Priya remains responsible', (await isolated.ask()).endsWith('Priya remains responsible.'));
} finally {
    await isolated.close();
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/who-has-it-demo.json`, JSON.stringify({ when: new Date().toISOString(), simulated_alexa: true, synthetic_data: true, checks, log }, null, 2));
const failed = checks.filter(c => !c.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exit(1);
