/** Writes the golden tool-call trace (careloop.tool-trace/v1) produced by the deterministic planner via AgentAdapter. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentAdapter } from '../src/agent/adapter.js';
import { DeterministicPlanner, GOLDEN_UTTERANCE } from '../src/agent/planner.js';
import { SYSTEM_POLICY } from '../src/agent/policy.js';
import { evaluateTrace, GOLDEN_MEDICATION_APPOINTMENT } from '../src/agent/trace.js';
import { openDatabase } from '../src/domain/migrations.js';
import { seedDemoData } from '../src/domain/seed.js';
import { startServer } from '../src/server.js';

const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'careloop-golden-')), 'golden.db'));
seedDemoData(db);
const server = await startServer({ db, port: 0, now: () => new Date('2026-10-12T04:00:00.000Z') });
const adapter = await AgentAdapter.open(server.url, { actorMemberId: 'mem_ravi', householdId: 'hh_rao' });
const turn = { turnId: 'turn_golden00000001', userUtterance: GOLDEN_UTTERANCE };
const first = await adapter.runTurn(turn, new DeterministicPlanner());
const retry = await adapter.runTurn(turn, new DeterministicPlanner());
const modelTools = await adapter.listModelTools();
const evaluation = evaluateTrace(first.trace, GOLDEN_MEDICATION_APPOINTMENT, GOLDEN_UTTERANCE);
await adapter.close();
await server.close();
db.close();

mkdirSync('evidence/phase3a', { recursive: true });
writeFileSync(
    'evidence/phase3a/golden-trace.json',
    JSON.stringify({ contract: GOLDEN_MEDICATION_APPOINTMENT, utterance: GOLDEN_UTTERANCE, system_policy: SYSTEM_POLICY, model_tools: modelTools, trace: first.trace, evaluation, retry_outcomes: retry.trace.steps.map(s => `${s.tool}:${s.outcome}`) }, null, 2)
);
console.error(`golden: pass=${evaluation.pass} violations=${evaluation.violations.length} stop=${first.trace.stop_reason}; retry=${retry.trace.steps.map(s => s.outcome).join(',')}`);
if (!evaluation.pass) process.exit(1);
