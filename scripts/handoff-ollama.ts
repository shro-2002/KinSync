/**
 * EXPERIMENTAL, local, $0: one care-handoff request planned by a local Ollama model through the same AgentAdapter
 * policy as everything else. Single run, no retries, no fallback to the rule-based planner. The model can only
 * propose; decide_handoff / respond_to_handoff are human-only and denied if it tries. Evidence: evidence/phase4/ollama-run.json.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentAdapter } from '../src/agent/adapter.js';
import { HANDOFF_UTTERANCE } from '../src/agent/handoff-planner.js';
import { OllamaPlanner } from '../src/agent/ollama-planner.js';
import { runAgentTurn } from '../src/agent/runner.js';
import { evaluateTrace, GOLDEN_CARE_HANDOFF } from '../src/agent/trace.js';
import { openDatabase } from '../src/domain/migrations.js';
import { seedDemoData } from '../src/domain/seed.js';
import { startServer } from '../src/server.js';

const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'kinsync-ollama-')), 'ollama.db'));
seedDemoData(db);
const server = await startServer({ db, port: 0, now: () => new Date('2026-10-12T04:00:00.000Z') });
const adapter = await AgentAdapter.open(server.url, { actorMemberId: 'mem_ravi', householdId: 'hh_rao' });
const planner = new OllamaPlanner({ model: process.env.OLLAMA_MODEL });
const r = await runAgentTurn({ adapter, planner, turn: { turnId: 'turn_ollama0000001', userUtterance: HANDOFF_UTTERANCE }, sessionContext: 'You are speaking with Ravi (the person being cared for) in the Rao household.' });
const evaluation = evaluateTrace(r.trace, GOLDEN_CARE_HANDOFF, HANDOFF_UTTERANCE);
const handoffs = db.prepare('SELECT status, to_member_id FROM handoffs').all();
await adapter.close();
await server.close();
db.close();
mkdirSync('evidence/phase4', { recursive: true });
writeFileSync('evidence/phase4/ollama-run.json', JSON.stringify({ planner: planner.name, model: planner.model, result: r, evaluation, handoffs }, null, 2));
console.error(`ollama handoff: model=${planner.model} stop=${r.stop} tools=${r.trace.steps.map(s => `${s.tool}:${s.outcome}`).join(',') || 'none'} reply=${r.reply.action} golden=${evaluation.pass} handoffs=${JSON.stringify(handoffs)}`);
console.error(`reply: ${r.reply.text}`);
