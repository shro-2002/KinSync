/**
 * Phase 4 browser check: the KinSync care handoff, driven through the real dashboard controls inside the
 * official MCP Apps reference host (unmodified ext-apps basic-host, sandboxed iframe).
 *
 * Flow: the deterministic planner turns a spoken request into a PENDING_APPROVAL proposal; in the browser a
 * human approves (as the care recipient, via the labeled simulated-actor switcher), the recipient accepts, the
 * handoff completes; wrong-actor attempts are forced past the disabled buttons and the SERVER refuses them;
 * the whole thing survives a server restart. Every UI result is cross-checked against SQLite.
 * Evidence: evidence/phase4/browser/. Exits non-zero on any failed check.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type Frame, type Page } from 'playwright';

import { AgentAdapter } from '../src/agent/adapter.js';
import { DeterministicHandoffPlanner, HANDOFF_UTTERANCE } from '../src/agent/handoff-planner.js';
import { runAgentTurn } from '../src/agent/runner.js';
import { openDatabase } from '../src/domain/migrations.js';
import { seedDemoData } from '../src/domain/seed.js';
import { startServer, type RunningServer } from '../src/server.js';

const PORT = 3335;
const HOST_ORIGIN = 'http://localhost:8080';
const BASIC_HOST_DIR = 'hosts/ext-apps/examples/basic-host';
const EVIDENCE_DIR = process.env.VERIFY_EVIDENCE_DIR ?? 'evidence/phase4/browser';
const TIMEOUT_MS = 15_000;
const NOW = new Date('2026-10-12T04:00:00.000Z'); // Monday: Priya on duty
const NARROW = { width: 390, height: 844 };

const results: Array<{ check: string; pass: boolean; detail?: unknown }> = [];
function check(name: string, pass: boolean, detail?: unknown): void {
    results.push({ check: name, pass, detail });
    console.error(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
}

async function waitForHttp(url: string): Promise<void> {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await fetch(url).then(r => r.ok, () => false)) return;
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`timed out waiting for ${url}`);
}

async function findViewFrame(page: Page): Promise<Frame> {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        for (const frame of page.frames()) {
            if (frame !== page.mainFrame() && (await frame.$('#household').catch(() => null))) return frame;
        }
        await page.waitForTimeout(200);
    }
    throw new Error('dashboard view frame not found');
}

const openView = async (page: Page) => {
    await page.goto(`${HOST_ORIGIN}/index.html?server=careloop&tool=show_care_dashboard&call=true`);
    const view = await findViewFrame(page);
    await view.waitForFunction(() => document.querySelector('#handoffs-active article, #handoffs-history li[data-status]'), null, { timeout: TIMEOUT_MS });
    return view;
};
const waitStatus = (view: Frame, status: string) =>
    view.waitForFunction(s => !!document.querySelector(`#handoffs-history li[data-status="${s}"], article.handoff[data-status="${s}"]`), status, { timeout: TIMEOUT_MS });
const stages = (view: Frame) => view.$$eval('#handoffs-active article .lifecycle li, #handoffs-history article .lifecycle li', lis => lis.map(li => (li as HTMLElement).dataset.state));
/** Presses Tab from `start` until `selector` has focus; returns the number of presses, or -1. */
async function tabTo(page: Page, view: Frame, start: string, selector: string, max = 25): Promise<number> {
    await view.focus(start);
    for (let i = 1; i <= max; i++) {
        await page.keyboard.press('Tab');
        if (await view.$eval(selector, el => el === document.activeElement).catch(() => false)) return i;
    }
    return -1;
}
const focusRingVisible = (view: Frame) =>
    view.evaluate(() => {
        const a = document.activeElement as HTMLElement;
        const cs = getComputedStyle(a);
        return a.matches(':focus-visible') && cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2;
    });
async function narrowShot(page: Page, path: string): Promise<void> {
    const desktop = page.viewportSize()!;
    await page.setViewportSize(NARROW);
    await page.waitForTimeout(300);
    await page.screenshot({ path, fullPage: true });
    await page.setViewportSize(desktop);
}
const buttons = (view: Frame, action: string) => view.$$eval(`article.handoff button[data-action="${action}"]`, bs => bs.map(b => ({ disabled: (b as HTMLButtonElement).disabled, title: b.getAttribute('title') })));
/** Re-enables a disabled button in the DOM, then clicks it: proves the server, not the UI, is the authority. */
async function forceClick(view: Frame, action: string): Promise<void> {
    await view.$eval(`article.handoff button[data-action="${action}"]`, b => ((b as HTMLButtonElement).disabled = false));
    await view.click(`article.handoff button[data-action="${action}"]`);
}

async function main(): Promise<void> {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const dbPath = join(mkdtempSync(join(tmpdir(), 'kinsync-ui-')), 'handoff.db');
    let db = openDatabase(dbPath);
    seedDemoData(db);
    // A header-less browser session acts as the coordinator; simulated switching is the labeled demo mode.
    const boot = (): Promise<RunningServer> => startServer({ db, port: PORT, corsOrigins: [HOST_ORIGIN], defaultActorId: 'mem_priya', simulatedActors: true, now: () => NOW });
    let server = await boot();
    const one = <T>(sql: string, ...args: Array<string | number>) => db.prepare(sql).get(...args) as T;
    const handoff = () => one<{ status: string }>('SELECT status FROM handoffs');
    const transitions = () => db.prepare('SELECT event, actor_member_id AS who, actor_mode AS mode, simulated_by_member_id AS by FROM handoff_transitions ORDER BY id').all();

    // 1. Spoken request -> proposal, through the model-facing path (rule-based planner, not an LLM).
    const adapter = await AgentAdapter.open(server.url, { actorMemberId: 'mem_ravi', householdId: 'hh_rao' });
    const turn = await runAgentTurn({ adapter, planner: new DeterministicHandoffPlanner(), turn: { turnId: 'turn_ui0000000001', userUtterance: HANDOFF_UTTERANCE }, sessionContext: 'Speaking with Ravi.' });
    await adapter.close();
    check('spoken request became a PENDING_APPROVAL proposal (planner can only propose)', turn.stop === 'awaiting_approval' && handoff().status === 'PENDING_APPROVAL', turn.reply.text);

    let host: ChildProcess | undefined;
    const browser = await chromium.launch();
    try {
        host = spawn('bun', ['serve.ts'], { cwd: BASIC_HOST_DIR, env: { ...process.env, SERVERS: JSON.stringify([server.url]) }, stdio: ['ignore', 'pipe', 'pipe'] });
        await waitForHttp(`${HOST_ORIGIN}/api/servers`);
        await waitForHttp('http://localhost:8081/sandbox.html');
        const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
        let view = await openView(page);
        const card = async () => (await view.textContent('article.handoff')) ?? '';

        const text = await card();
        check('card shows the task in the person\'s words, requester, who is responsible now and who is proposed', text.includes(HANDOFF_UTTERANCE) && /Requested by Ravi/.test(text) && /Responsible now \(on duty\)Priya/.test(text) && /Proposed to take overArjun/.test(text), text.slice(0, 200));
        check('lifecycle reads Requested (done) -> Awaiting approval (in progress) -> acceptance -> Completed (not yet)', JSON.stringify(await stages(view)) === JSON.stringify(['done', 'current', 'todo', 'todo']) && /Awaiting approval/.test(text) && /Nothing has been sent or arranged/.test(text), await stages(view));
        const label = (await view.textContent('#actor-bar')) ?? '';
        check('simulated-actor switcher is visibly labeled SIMULATED, not authentication', /Simulated identity/i.test(label) && /not authentication/.test(label) && (await view.isVisible('#actor-tag')), label);
        check('starts as the session identity (Priya, coordinator): Approve and Reject enabled', (await view.inputValue('#actor')) === 'mem_priya' && (await buttons(view, 'approve'))[0]?.disabled === false && (await buttons(view, 'reject'))[0]?.disabled === false);
        check('no Accept/Decline offered while approval is pending', (await buttons(view, 'accept')).length === 0);
        await page.screenshot({ path: `${EVIDENCE_DIR}/20-pending-approval-desktop.png`, fullPage: true });
        await narrowShot(page, `${EVIDENCE_DIR}/20-pending-approval-narrow.png`);

        // Keyboard: the identity switcher and the controls are reachable with Tab and show a visible focus ring.
        const toSelect = await tabTo(page, view, '#refresh', '#actor');
        check('keyboard: Tab from Refresh reaches the identity switcher, with a visible focus ring', toSelect > 0 && (await focusRingVisible(view)), { tabs: toSelect });

        // 2. Wrong identity: the UI disables the control; forcing it anyway is refused by the server.
        await view.selectOption('#actor', 'mem_arjun');
        const arjunApprove = (await buttons(view, 'approve'))[0]!;
        check('as Arjun (the recipient): Approve is disabled with an explanation', arjunApprove.disabled && /cannot/.test(arjunApprove.title ?? '') && (await view.isVisible('article.handoff .why')), arjunApprove);
        await forceClick(view, 'approve');
        await view.waitForFunction(() => document.querySelector('#handoff-msg')?.textContent?.includes('Server refused'), null, { timeout: TIMEOUT_MS });
        check('forced approve as Arjun refused by the SERVER (FORBIDDEN); nothing changed', ((await view.textContent('#handoff-msg')) ?? '').includes('FORBIDDEN') && handoff().status === 'PENDING_APPROVAL', await view.textContent('#handoff-msg'));
        check(
            'the refusal is in the audit trail as a denied decide_handoff by Arjun',
            one<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'decide_handoff' AND outcome = 'denied' AND actor_member_id = 'mem_arjun'").n === 1
        );
        await page.screenshot({ path: `${EVIDENCE_DIR}/21-wrong-actor-refused.png`, fullPage: true });
        await view.selectOption('#actor', 'mem_meera');
        check('as Meera (viewer): Approve disabled; switching identity cleared the old error', (await buttons(view, 'approve'))[0]!.disabled && ((await view.textContent('#handoff-msg')) ?? '') === '');

        // 3. Priya (coordinator, her own session identity) approves - keyboard only: Tab to Approve, press Enter.
        await view.selectOption('#actor', 'mem_priya');
        const toApprove = await tabTo(page, view, '#actor', 'article.handoff button[data-action="approve"]');
        const ringOnApprove = await focusRingVisible(view);
        await page.keyboard.press('Enter');
        await waitStatus(view, 'PENDING_ACCEPTANCE');
        check('keyboard: Tab reaches Approve (visible focus ring) and Enter approves', toApprove > 0 && ringOnApprove && handoff().status === 'PENDING_ACCEPTANCE', { tabs: toApprove });
        check('approval recorded as Priya in her own (non-simulated) session', JSON.stringify(transitions()[1]) === JSON.stringify({ event: 'approve', who: 'mem_priya', mode: 'session', by: null }), transitions()[1]);
        check('card: approved by Priya, but Arjun is not responsible until he accepts', /Approved by Priya/.test(await card()) && /not responsible until they accept/.test(await card()) && JSON.stringify(await stages(view)) === JSON.stringify(['done', 'done', 'current', 'todo']));
        check('Approve/Reject are gone; Accept/Decline are shown', (await buttons(view, 'approve')).length === 0 && (await buttons(view, 'accept')).length === 1);
        await page.screenshot({ path: `${EVIDENCE_DIR}/22-pending-acceptance.png`, fullPage: true });

        // 4. Only the named recipient may accept.
        check('as Priya (not the recipient): Accept disabled', (await buttons(view, 'accept'))[0]!.disabled);
        await forceClick(view, 'accept');
        await view.waitForFunction(() => document.querySelector('#handoff-msg')?.textContent?.includes('Server refused'), null, { timeout: TIMEOUT_MS });
        check('forced accept as Priya refused by the SERVER; still PENDING_ACCEPTANCE', ((await view.textContent('#handoff-msg')) ?? '').includes('FORBIDDEN') && handoff().status === 'PENDING_ACCEPTANCE');

        await view.selectOption('#actor', 'mem_arjun');
        const toAccept = await tabTo(page, view, '#actor', 'article.handoff button[data-action="accept"]');
        await page.keyboard.press('Space');
        await waitStatus(view, 'COMPLETED');
        check('keyboard: Arjun (SIMULATED) tabs to Accept and presses Space: persisted as COMPLETED', toAccept > 0 && handoff().status === 'COMPLETED' && (await view.$$('#handoffs-active article')).length === 0, { tabs: toAccept });
        const history = (await view.textContent('#handoffs-history')) ?? '';
        check('completed card: all four stages done, Arjun now responsible, never claims care was given', JSON.stringify(await stages(view)) === JSON.stringify(['done', 'done', 'done', 'done']) && /Now responsible for this task \(accepted\)Arjun/.test(history) && !/Responsible now/.test(history) && /does not confirm any care was provided/.test(history) && !/arrived|provided care/.test(history.replace('does not confirm any care was provided', '')), history.slice(0, 200));
        check('transitions: propose(Ravi) approve(Priya) accept(Arjun, simulated via Priya\'s session)', JSON.stringify(transitions()) === JSON.stringify([
            { event: 'propose', who: 'mem_ravi', mode: 'session', by: null },
            { event: 'approve', who: 'mem_priya', mode: 'session', by: null },
            { event: 'accept', who: 'mem_arjun', mode: 'simulated', by: 'mem_priya' }
        ]), transitions());
        check('nothing was sent: simulated outbox empty, no notification drafts', one<{ n: number }>('SELECT COUNT(*) AS n FROM simulated_outbox').n === 0 && one<{ n: number }>('SELECT COUNT(*) AS n FROM notification_drafts').n === 0);
        await page.screenshot({ path: `${EVIDENCE_DIR}/23-completed-desktop.png`, fullPage: true });

        // 5. Restart the server on the same database; a fresh browser load still shows the full history.
        await server.close();
        db.close();
        db = openDatabase(dbPath);
        server = await boot();
        view = await openView(page);
        await waitStatus(view, 'COMPLETED');
        await view.click('#handoffs-history summary');
        const audit = (await view.textContent('#handoffs-history')) ?? '';
        check('after server restart + page reload the COMPLETED agreement and its 3-step audit trail are still shown', /Audit trail \(3\)/.test(audit) && /PENDING_APPROVAL → PENDING_ACCEPTANCE/.test(audit) && /SIMULATED by Priya/.test(audit) && /2026-10-12T04:00:00.000Z/.test(audit), audit.slice(0, 260));
        await page.screenshot({ path: `${EVIDENCE_DIR}/24-after-restart-desktop.png`, fullPage: true });
        await narrowShot(page, `${EVIDENCE_DIR}/24-after-restart-narrow.png`);

        writeFileSync(`${EVIDENCE_DIR}/25-verify-handoff-ui.json`, JSON.stringify({ when: new Date().toISOString(), server: server.url, results, transitions: transitions(), audit: server.service.auditTrail('hh_rao') }, null, 2));
    } finally {
        await browser.close();
        host?.kill();
        await server.close();
        db.close();
    }

    const failed = results.filter(r => !r.pass).length;
    console.error(`\n${results.length - failed}/${results.length} handoff UI checks passed`);
    if (failed) process.exit(1);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
