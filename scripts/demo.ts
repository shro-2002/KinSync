/**
 * One-command local KinSync demo: fresh synthetic database, MCP server, the official MCP Apps reference host,
 * and Ravi's spoken request turned into a handoff proposal, with the conversation and every tool action printed.
 *
 *   pnpm demo                      fresh DB, deterministic (rule-based) planner, waits for Enter before Ravi speaks
 *   pnpm demo -- --keep            reuse the demo DB (show that everything survived a restart); no new request
 *   pnpm demo -- --planner ollama  EXPERIMENTAL: a local Ollama model plans the request (no fallback if it fails)
 *   pnpm demo -- --smoke           non-interactive self-check: start, request, verify over MCP, shut down
 *
 * $0, offline: no paid API, no cloud, no credentials. All people and data are synthetic.
 * The browser's "simulated identity" switcher is a labeled demo aid, not authentication.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline/promises';

import { AgentAdapter } from '../src/agent/adapter.js';
import { DeterministicHandoffPlanner, HANDOFF_UTTERANCE } from '../src/agent/handoff-planner.js';
import type { ModelPlanner } from '../src/agent/model.js';
import { OllamaPlanner } from '../src/agent/ollama-planner.js';
import { runAgentTurn } from '../src/agent/runner.js';
import { connect } from '../src/client.js';
import { openDatabase } from '../src/domain/migrations.js';
import { seedDemoData } from '../src/domain/seed.js';
import { startServer } from '../src/server.js';

const PORT = Number(process.env.PORT ?? 3333);
const HOST_ORIGIN = 'http://localhost:8080';
const BASIC_HOST_DIR = 'hosts/ext-apps/examples/basic-host';
const DB_PATH = 'data/kinsync-demo.db';
const CLOCK_FILE = 'data/kinsync-demo.clock';
// Monday 09:30 in Asia/Kolkata: the synthetic rota puts Priya on duty, which the story needs.
const DEMO_START = Date.parse('2026-10-12T04:00:00.000Z');
const SESSION_ACTOR = 'mem_priya';
const TIMEOUT_MS = 15_000;

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
};
const keep = flag('keep');
const smoke = flag('smoke');
const plannerKind = option('planner') ?? 'deterministic';
const utterance = option('say') ?? HANDOFF_UTTERANCE;
const log = (line = '') => console.log(line);

function fail(message: string): never {
    console.error(`\n[demo] ${message}`);
    process.exit(1);
}

const portFree = (port: number) =>
    new Promise<boolean>(resolve => {
        const socket = createConnection({ port, host: '127.0.0.1' });
        socket.once('connect', () => {
            socket.destroy();
            resolve(false);
        });
        socket.once('error', () => resolve(true));
    });

async function waitForHttp(url: string): Promise<void> {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await fetch(url).then(r => r.ok, () => false)) return;
        await new Promise(r => setTimeout(r, 200));
    }
    fail(`timed out waiting for ${url}`);
}

/** Demo clock: starts at DEMO_START and runs in real time; the anchor survives --keep restarts. */
function demoClock(): () => Date {
    if (!keep || !existsSync(CLOCK_FILE)) writeFileSync(CLOCK_FILE, String(Date.now()));
    const anchor = Number(readFileSync(CLOCK_FILE, 'utf8'));
    return () => new Date(DEMO_START + (Date.now() - anchor));
}

function makePlanner(): ModelPlanner {
    if (plannerKind === 'deterministic') return new DeterministicHandoffPlanner();
    if (plannerKind === 'ollama') return new OllamaPlanner({ model: process.env.OLLAMA_MODEL });
    return fail(`unknown --planner ${plannerKind} (use deterministic or ollama)`);
}

async function preflight(): Promise<void> {
    if (!existsSync(`${BASIC_HOST_DIR}/dist`)) fail(`MCP Apps reference host not built. Run once: scripts/setup-basic-host.sh (needs git, npm; ~1 min).`);
    const bun = spawn('bun', ['--version'], { stdio: 'ignore' });
    const bunOk = await new Promise<boolean>(resolve => {
        bun.once('error', () => resolve(false));
        bun.once('exit', code => resolve(code === 0));
    });
    if (!bunOk) fail('`bun` is required to serve the reference host (https://bun.sh). Install it, then re-run.');
    for (const port of [PORT, 8080, 8081]) if (!(await portFree(port))) fail(`port ${port} is in use. Stop whatever is using it (another pnpm server or demo?) and re-run.`);
    if (plannerKind === 'ollama' && !(await fetch('http://127.0.0.1:11434/api/tags').then(r => r.ok, () => false))) {
        fail('--planner ollama needs the local Ollama daemon on 127.0.0.1:11434 with the model already pulled. There is no fallback in this mode.');
    }
}

function freshDatabase(): void {
    if (keep) return;
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB_PATH}${suffix}`, { force: true });
}

async function requestTurn(serverUrl: string, planner: ModelPlanner): Promise<void> {
    const kind =
        plannerKind === 'ollama'
            ? `EXPERIMENTAL local LLM inference (${planner.model} via Ollama) - single run, no retries, may fail`
            : 'DETERMINISTIC rule-based planner (not an LLM) - reproducible, $0';
    log('\n================ SIMULATED ALEXA+ TURN ================');
    log(`Ravi (care recipient) says:  "${utterance}"`);
    log(`Planner: ${kind}`);
    log('Model-facing tools: propose and read only. decide_handoff and respond_to_handoff are human-only and are never offered.\n');
    const adapter = await AgentAdapter.open(serverUrl, { actorMemberId: 'mem_ravi', householdId: 'hh_rao' });
    const turnId = `turn_demo${Date.now().toString(36)}aaaa`;
    const r = await runAgentTurn({ adapter, planner, turn: { turnId, userUtterance: utterance }, sessionContext: 'You are speaking with Ravi (the person being cared for) in the Rao household.' });
    await adapter.close();
    for (const s of r.trace.steps) {
        const args = s.effective_args ? JSON.stringify(Object.fromEntries(Object.entries(s.effective_args).filter(([k]) => k !== 'idempotency_key'))) : '';
        const result = s.decision === 'policy_denied' ? `DENIED by policy (${s.policy_reason})` : `${s.outcome}${s.error_code ? ` ${s.error_code}` : ''}`;
        log(`  tool ${s.seq}: ${s.tool} ${args}\n          -> ${result}`);
    }
    if (r.trace.steps.length === 0) log('  (no tool calls)');
    log(`\nKinSync replies: "${r.reply.text}"`);
    log(`Turn stop: ${r.stop}${r.reply.action === 'passed' ? '' : `  (output safety: ${r.reply.action})`}`);
    log('Nothing was sent, booked or dispatched. A human must approve, then the recipient must accept.');
    log('=======================================================\n');
}

async function smokeCheck(serverUrl: string): Promise<void> {
    const { client } = await connect(serverUrl, { actor: 'mem_meera' });
    const res = await client.callTool({ name: 'get_handoffs', arguments: { household_id: 'hh_rao' } });
    await client.close();
    const handoffs = (res.structuredContent as { handoffs: Array<{ status: string; history: unknown[] }> }).handoffs;
    const ok = keep ? handoffs.length > 0 : handoffs.length === 1 && handoffs[0]!.status === 'PENDING_APPROVAL';
    log(`[smoke] ${keep ? 'after restart' : 'fresh database'}: ${handoffs.length} handoff(s): ${handoffs.map(h => `${h.status} (${h.history.length} transitions)`).join(', ') || 'none'} -> ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
    await preflight();
    const planner = makePlanner();
    freshDatabase();
    const db = openDatabase(DB_PATH);
    seedDemoData(db);
    const now = demoClock();
    const server = await startServer({ db, port: PORT, corsOrigins: [HOST_ORIGIN], defaultActorId: SESSION_ACTOR, simulatedActors: true, now });
    const host: ChildProcess = spawn('bun', ['serve.ts'], { cwd: BASIC_HOST_DIR, env: { ...process.env, SERVERS: JSON.stringify([server.url]) }, stdio: 'ignore' });
    const shutdown = async () => {
        host.kill();
        await server.close();
        db.close();
    };
    // Ctrl+C (SIGINT) and SIGTERM both stop the reference host child and close the server and database cleanly.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown().then(() => process.exit(0)));
    await waitForHttp(`${HOST_ORIGIN}/api/servers`);
    await waitForHttp('http://localhost:8081/sandbox.html');

    log('\nKinSync demo (built from the CareLoop codebase) - an MCP Apps experience in a SIMULATED Alexa+ workflow, not native Alexa+.');
    log(`  MCP server      ${server.url}   (database ${DB_PATH}, ${keep ? 'KEPT from the last run' : 'fresh synthetic seed'})`);
    log(`  Dashboard       ${HOST_ORIGIN}/index.html?server=careloop&tool=show_care_dashboard&call=true`);
    log(`  Browser session acts as Priya (coordinator). The dashboard's identity switcher is SIMULATED - demo only, not authentication.`);
    log(`  Demo clock      starts Mon 2026-10-12 09:30 Asia/Kolkata (rota: Priya on duty) and runs in real time; now ${now().toISOString()}`);

    if (smoke) {
        if (!keep) await requestTurn(server.url, planner);
        await smokeCheck(server.url);
        await shutdown();
        return;
    }
    if (!keep) {
        if (process.stdin.isTTY) {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            await rl.question('\nOpen the dashboard, then press Enter to play Ravi\'s request... ');
            rl.close();
        }
        await requestTurn(server.url, planner);
        log('Next, in the dashboard: Refresh -> Approve (as Priya) -> switch identity to Arjun (SIMULATED) -> Accept.');
    } else {
        log('\n--keep: no new request. Open the dashboard to show the persisted agreement and its audit trail.');
    }
    log('Ctrl+C to stop.');
}

main().catch(err => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
