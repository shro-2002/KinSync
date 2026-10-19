/**
 * Ask a RUNNING KinSync server who is responsible, e.g. while `pnpm demo` is up:
 *   pnpm ask "Who's taking Dad Thursday?"   [--as mem_priya] [--household hh_rao] [--url http://127.0.0.1:3333/mcp]
 * A thin print wrapper over the tested read-only planner (src/agent/responsibility-planner.ts) and the normal
 * AgentAdapter. It adds no answers of its own: the reply is whatever the server's records produce. SIMULATED Alexa+
 * turn (typed text), synthetic data.
 */
import { AgentAdapter } from '../src/agent/adapter.js';
import { WRITE_TOOLS } from '../src/agent/policy.js';
import { DeterministicResponsibilityPlanner } from '../src/agent/responsibility-planner.js';
import { runAgentTurn } from '../src/agent/runner.js';

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
    const at = args.indexOf(`--${name}`);
    return at < 0 ? fallback : (args.splice(at, 2)[1] ?? fallback);
};
const url = option('url', 'http://127.0.0.1:3333/mcp');
const asker = option('as', 'mem_priya');
const household = option('household', 'hh_rao');
const question = args.join(' ').trim();
if (!question) {
    console.error('usage: pnpm ask "Who\'s taking Dad Thursday?" [--as mem_priya] [--household hh_rao] [--url <mcp url>]');
    process.exit(2);
}

const adapter = await AgentAdapter.open(url, { actorMemberId: asker, householdId: household });
try {
    const turn = await runAgentTurn({ adapter, planner: new DeterministicResponsibilityPlanner(), turn: { turnId: `turn_ask${Date.now().toString().padStart(13, '0')}`, userUtterance: question }, sessionContext: 'Simulated Alexa+ turn.' });
    const tools = turn.trace.steps.map(s => s.tool);
    const readOnly = turn.trace.steps.every(s => s.decision === 'executed' && !WRITE_TOOLS.has(s.tool));
    console.log(`[SIMULATED ALEXA+ - typed question] "${question}"`);
    console.log(`MCP calls: ${tools.join(', ')}  (read-only: ${readOnly ? 'yes' : 'NO'})`);
    console.log(`KinSync: "${turn.reply.text}"`);
} finally {
    await adapter.close();
}
