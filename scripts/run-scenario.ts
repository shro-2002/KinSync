/**
 * Reproducible end-to-end evidence for the Phase 2 workflow, entirely over MCP
 * (Streamable HTTP, protocol 2025-11-25) against a fresh seeded database and a fixed clock.
 * Writes evidence/phase2/scenario-transcript.json. Exits non-zero if any expectation fails.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEMO_SCENARIO, runMedicationAppointmentScenario } from '../src/agent/scenario.js';
import { connect } from '../src/client.js';
import { openDatabase } from '../src/domain/migrations.js';
import { seedDemoData } from '../src/domain/seed.js';
import { startServer } from '../src/server.js';

// Monday 2026-10-12, 09:30 Asia/Kolkata: the rota puts Priya on duty.
const FIXED_NOW = new Date('2026-10-12T04:00:00.000Z');
const OUT_DIR = 'evidence/phase2';

const checks: Array<{ check: string; pass: boolean }> = [];
const expect = (check: string, pass: boolean) => {
    checks.push({ check, pass });
    console.error(`${pass ? 'PASS' : 'FAIL'}  ${check}`);
};

const dbPath = join(mkdtempSync(join(tmpdir(), 'careloop-scenario-')), 'scenario.db');
const db = openDatabase(dbPath);
seedDemoData(db);
const server = await startServer({ db, port: 0, now: () => FIXED_NOW });
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const counts = () => ({ care_events: count('care_events'), appointment_requests: count('appointment_requests'), notification_drafts: count('notification_drafts'), approvals: count('approvals'), simulated_outbox: count('simulated_outbox') });
const parse = (res: { structuredContent?: unknown; content?: unknown }) =>
    (res.structuredContent ?? JSON.parse((res.content as Array<{ text: string }>)[0]!.text)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

try {
    // A. Parent's session runs the deterministic plan and stops at the approval boundary.
    const ravi = await connect(server.url, { actor: 'mem_ravi' });
    const first = await runMedicationAppointmentScenario(ravi.client, DEMO_SCENARIO);
    const afterFirst = counts();
    expect('A: scenario stops in awaiting_approval', first.status === 'awaiting_approval');
    expect('A: duty contact on Monday is Priya', first.dutyContact === 'Priya');
    expect('A: nothing sent before approval', afterFirst.simulated_outbox === 0);
    expect('A: protocol 2025-11-25', ravi.client.getNegotiatedProtocolVersion() === '2025-11-25');

    // B. The same turn is retried (e.g. network retry): every write replays, nothing duplicates.
    const retry = await runMedicationAppointmentScenario(ravi.client, DEMO_SCENARIO);
    expect('B: retry replays all three writes', retry.replayed.every(Boolean));
    expect('B: retry returns the same ids', retry.approvalId === first.approvalId && retry.draftId === first.draftId);
    expect('B: no new rows after retry', JSON.stringify(counts()) === JSON.stringify(afterFirst));
    await ravi.client.close();

    // C. Someone from another household tries to approve: denied, nothing changes.
    const wei = await connect(server.url, { actor: 'mem_wei' });
    const crossHousehold = parse(
        await wei.client.callTool({ name: 'decide_approval', arguments: { household_id: 'hh_rao', idempotency_key: 'wei-attempt-0001', approval_id: first.approvalId, decision: 'approve' } })
    );
    expect('C: cross-household approval denied (FORBIDDEN)', crossHousehold.error?.code === 'FORBIDDEN');
    await wei.client.close();

    // D. Caregiver (not an approver role) tries: denied.
    const arjun = await connect(server.url, { actor: 'mem_arjun' });
    const wrongRole = parse(
        await arjun.client.callTool({ name: 'decide_approval', arguments: { household_id: 'hh_rao', idempotency_key: 'arjun-attempt-01', approval_id: first.approvalId, decision: 'approve' } })
    );
    expect('D: caregiver approval denied (FORBIDDEN, role)', wrongRole.error?.code === 'FORBIDDEN');
    await arjun.client.close();

    // E. Coordinator approves; approving again with a new key is refused; same key replays.
    const priya = await connect(server.url, { actor: 'mem_priya' });
    const approveArgs = { household_id: 'hh_rao', idempotency_key: 'priya-approve-0001', approval_id: first.approvalId, decision: 'approve' };
    const approved = parse(await priya.client.callTool({ name: 'decide_approval', arguments: approveArgs }));
    const replay = parse(await priya.client.callTool({ name: 'decide_approval', arguments: approveArgs }));
    const second = parse(await priya.client.callTool({ name: 'decide_approval', arguments: { ...approveArgs, idempotency_key: 'priya-approve-0002' } }));
    expect('E: approval recorded', approved.approval?.status === 'approved');
    expect('E: delivery is simulated only', approved.outbox?.delivery === 'simulated_not_sent' && approved.real_message_sent === false);
    expect('E: same-key approve replays', replay.replayed === true);
    expect('E: second approval with new key refused (ALREADY_DECIDED)', second.error?.code === 'ALREADY_DECIDED');
    expect('E: exactly one simulated send', count('simulated_outbox') === 1);

    const status = parse(await priya.client.callTool({ name: 'get_household_status', arguments: { household_id: 'hh_rao' } }));
    expect('F: no pending approvals left', status.pending_approvals.length === 0);
    expect('F: appointment request handed off (no longer open)', status.open_appointment_requests.length === 0);
    expect('F: morning schedule shows a report; evening shows neutral no-report text', status.medication_reference.map((m: { status_text: string }) => m.status_text).join(' | ') === 'Report recorded today (1) | No report recorded yet today');
    await priya.client.close();

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
        `${OUT_DIR}/scenario-transcript.json`,
        JSON.stringify(
            {
                generated_by: 'pnpm scenario',
                fixed_now: FIXED_NOW.toISOString(),
                protocol: '2025-11-25',
                scenario_input: DEMO_SCENARIO,
                first_run: first,
                retry_replayed: retry.replayed,
                counts_after_first_run: afterFirst,
                cross_household_attempt: crossHousehold,
                wrong_role_attempt: wrongRole,
                approval: approved,
                same_key_replay: { replayed: replay.replayed },
                second_approval_new_key: second,
                final_status: status,
                final_counts: counts(),
                audit_trail: server.service.auditTrail('hh_rao'),
                checks
            },
            null,
            2
        )
    );
} finally {
    await server.close();
    db.close();
}

const failed = checks.filter(c => !c.pass).length;
console.error(`\n${checks.length - failed}/${checks.length} scenario checks passed`);
if (failed) process.exit(1);
