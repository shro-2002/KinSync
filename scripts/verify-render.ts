/**
 * PoC-1 end-to-end render check against the official MCP Apps reference host.
 *
 * 1. Starts CareLoop (temp SQLite DB, CORS for the host origin) on VERIFY_PORT.
 * 2. Starts the unmodified ext-apps basic-host (hosts/ext-apps, pinned commit) pointed at it.
 * 3. Drives Chromium: call show_care_dashboard in the host, find the view inside the
 *    sandbox iframes, assert it shows DB data, log a new event from an independent MCP
 *    client, click the view's Refresh, assert the new event appears.
 * 4. Records every JSON-RPC method the host sent to the server.
 * Exits non-zero on any failed assertion. Evidence goes to evidence/poc1/.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type Frame, type Page } from 'playwright';

import { connect } from '../src/client.js';
import { openDatabase } from '../src/domain/migrations.js';
import { seedDemoData } from '../src/domain/seed.js';
import { DASHBOARD_URI, startServer } from '../src/server.js';

const VERIFY_PORT = 3334;
const HOST_ORIGIN = 'http://localhost:8080';
const BASIC_HOST_DIR = 'hosts/ext-apps/examples/basic-host';
const EVIDENCE_DIR = process.env.VERIFY_EVIDENCE_DIR ?? 'evidence/phase2/render';
// Browser hosts can't send X-CareLoop-Actor, so the host session acts as the coordinator.
const HOST_ACTOR = 'mem_priya';
const TIMEOUT_MS = 15_000;

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
            if (frame === page.mainFrame()) continue;
            if (await frame.$('#household').catch(() => null)) return frame;
        }
        await page.waitForTimeout(200);
    }
    throw new Error('dashboard view frame not found');
}

async function main(): Promise<void> {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'careloop-render-')), 'render.db'));
    seedDemoData(db);
    const server = await startServer({ db, port: VERIFY_PORT, corsOrigins: [HOST_ORIGIN], defaultActorId: HOST_ACTOR });
    const ravi = server.service.resolveActor('mem_ravi');
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    server.service.recordCareEvent(ravi, { household_id: 'hh_rao', idempotency_key: 'render-seed-1', kind: 'medication', note: 'synthetic: Dad took 8am pills', medication_schedule_id: 'med_ravi_morning', occurred_at: at(2) });
    server.service.recordCareEvent(ravi, { household_id: 'hh_rao', idempotency_key: 'render-seed-2', kind: 'meal', note: 'synthetic: Dad ate oatmeal', occurred_at: at(1) });
    const apt = server.service.prepareAppointmentRequest(ravi, { household_id: 'hh_rao', idempotency_key: 'render-seed-3', reason_as_reported: 'Knee hurts', preferred_window: 'this_week' });
    const pending = server.service.draftCaregiverNotification(ravi, { household_id: 'hh_rao', idempotency_key: 'render-seed-4', appointment_request_id: apt.appointment_request.id });

    let host: ChildProcess | undefined;
    const browser = await chromium.launch();
    try {
        host = spawn('bun', ['serve.ts'], {
            cwd: BASIC_HOST_DIR,
            env: { ...process.env, SERVERS: JSON.stringify([server.url]) },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        await waitForHttp(`${HOST_ORIGIN}/api/servers`);
        await waitForHttp('http://localhost:8081/sandbox.html');

        const page = await browser.newPage();
        const sentMethods: Array<{ method: string; uri?: string; tool?: string; protocolVersion?: string; header?: string; extensions?: unknown }> = [];
        page.on('request', req => {
            if (!req.url().startsWith(server.url) || req.method() !== 'POST') return;
            const body = req.postDataJSON() as { method?: string; params?: { uri?: string; name?: string; protocolVersion?: string; capabilities?: { extensions?: unknown } } } | null;
            if (!body?.method) return;
            sentMethods.push({
                method: body.method,
                uri: body.params?.uri,
                tool: body.params?.name,
                protocolVersion: body.params?.protocolVersion,
                extensions: body.params?.capabilities?.extensions,
                header: req.headers()['mcp-protocol-version']
            });
        });

        await page.goto(`${HOST_ORIGIN}/index.html?server=careloop&tool=show_care_dashboard&call=true`);
        const view = await findViewFrame(page);
        await view.waitForFunction(() => document.querySelectorAll('#events tr').length > 0, null, { timeout: TIMEOUT_MS });

        const initialRows = await view.$$eval('#events tr td:nth-child(3)', tds => tds.map(td => td.textContent));
        check('view rendered inside a sandbox iframe (not the host page)', view !== page.mainFrame(), { frameUrl: view.url() || '(srcdoc/about:blank)' });
        check('view shows the events stored in SQLite', initialRows.length === 2 && initialRows.includes('synthetic: Dad ate oatmeal'), initialRows);
        const domainText = await view.textContent('main');
        check('view shows the duty contact from the rota', /On duty today: (Priya|Arjun)/.test(domainText ?? ''));
        check('view shows the medication reference with neutral no-report wording', (domainText ?? '').includes('No report recorded yet today') && !/missed/i.test(domainText ?? ''));
        check('view lists the pending approval', (await view.$(`#approvals li[data-key="${pending.approval.id}"]`)) !== null);
        check('initial data arrived via host tool-result notification', (await view.textContent('#status'))?.includes('host tool-result notification') ?? false);
        check(
            'host discovered the UI via MCP resources/read of the ui:// URI',
            sentMethods.some(m => m.method === 'resources/read' && m.uri === DASHBOARD_URI),
            sentMethods
        );
        const init = sentMethods.find(m => m.method === 'initialize');
        const postInit = sentMethods.filter(m => m.method !== 'initialize');
        check('browser host requested protocol 2025-11-25 in initialize', init?.protocolVersion === '2025-11-25', init);
        check(
            'browser host sent MCP-Protocol-Version: 2025-11-25 on every post-init request',
            postInit.length > 0 && postInit.every(m => m.header === '2025-11-25'),
            [...new Set(postInit.map(m => m.header))]
        );
        // Informative: spec SHOULD-gate UI tools on this capability; record what the host advertises.
        console.error(`INFO  host initialize capabilities.extensions = ${JSON.stringify(init?.extensions ?? null)}`);
        await page.screenshot({ path: `${EVIDENCE_DIR}/10-verify-initial.png`, fullPage: true });

        // Independent MCP client (separate session) writes a new event.
        const writer = await connect(server.url, { actor: 'mem_ravi' });
        await writer.client.callTool({
            name: 'record_care_event',
            arguments: { household_id: 'hh_rao', idempotency_key: 'render-nonce-1', kind: 'symptom', note: 'synthetic NONCE-RENDER' }
        });
        await writer.client.close();

        const callsBefore = sentMethods.filter(m => m.method === 'tools/call').length;
        await view.click('#refresh');
        await view.waitForFunction(() => document.body.textContent?.includes('synthetic NONCE-RENDER'), null, { timeout: TIMEOUT_MS });
        const after = await view.$$eval('#events tr td:nth-child(3)', tds => tds.map(td => td.textContent));
        check('new record_care_event visible after view Refresh', after[0] === 'synthetic NONCE-RENDER' && after.length === 3, after);
        check(
            'refresh went app -> host -> tools/call on the MCP server',
            sentMethods.filter(m => m.method === 'tools/call').length === callsBefore + 1 && (await view.textContent('#status'))!.includes('tools/call'),
            sentMethods.slice(-1)
        );
        await page.screenshot({ path: `${EVIDENCE_DIR}/11-verify-after-refresh.png`, fullPage: true });

        writeFileSync(`${EVIDENCE_DIR}/12-verify-render.json`, JSON.stringify({ when: new Date().toISOString(), server: server.url, results, sentMethods }, null, 2));
    } finally {
        await browser.close();
        host?.kill();
        await server.close();
        db.close();
    }

    const failed = results.filter(r => !r.pass).length;
    console.error(`\n${results.length - failed}/${results.length} render checks passed`);
    if (failed) process.exit(1);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
