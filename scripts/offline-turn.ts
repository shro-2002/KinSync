/** Free, offline end-to-end turn through runAgentTurn with the DeterministicModelPlanner. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentAdapter } from '../src/agent/adapter.js';
import { DeterministicModelPlanner, GOLDEN_UTTERANCE } from '../src/agent/planner.js';
import { runAgentTurn } from '../src/agent/runner.js';
import { evaluateTrace, GOLDEN_MEDICATION_APPOINTMENT } from '../src/agent/trace.js';
import { openDatabase } from '../src/domain/migrations.js';
import { seedDemoData } from '../src/domain/seed.js';
import { startServer } from '../src/server.js';

const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'careloop-offline-')), 'offline.db'));
seedDemoData(db);
const server = await startServer({ db, port: 0, now: () => new Date('2026-10-12T04:00:00.000Z') });
const adapter = await AgentAdapter.open(server.url, { actorMemberId: 'mem_ravi', householdId: 'hh_rao' });
const r = await runAgentTurn({
    adapter,
    planner: new DeterministicModelPlanner(),
    turn: { turnId: 'turn_offline00000001', userUtterance: GOLDEN_UTTERANCE },
    sessionContext: 'You are speaking with Ravi (the person being cared for) in the Rao household.',
    usageLogPath: 'evidence/phase3b/offline-usage.jsonl'
});
const evaluation = evaluateTrace(r.trace, GOLDEN_MEDICATION_APPOINTMENT, GOLDEN_UTTERANCE);
await adapter.close();
await server.close();
db.close();
mkdirSync('evidence/phase3b', { recursive: true });
writeFileSync('evidence/phase3b/offline-turn.json', JSON.stringify({ result: r, evaluation }, null, 2));
console.error(`offline turn: stop=${r.stop} reply=${r.reply.action} "${r.reply.text}" golden=${evaluation.pass} cost=${r.usage.estimatedCostUsd}`);
if (!evaluation.pass) process.exit(1);
