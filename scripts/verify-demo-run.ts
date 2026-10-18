/**
 * Drives an ALREADY RUNNING `pnpm demo` in Chromium exactly as the demo script does (Refresh, Priya approves,
 * switch to Arjun, Arjun accepts), or with --after-restart checks a `pnpm demo -- --keep` instance still shows the
 * completed agreement. Captures desktop + narrow screenshots. Evidence: evidence/phase5/demo-run/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import { chromium, type Frame, type Page } from 'playwright';

const URL = 'http://localhost:8080/index.html?server=careloop&tool=show_care_dashboard&call=true';
const OUT = 'evidence/phase5/demo-run';
const afterRestart = process.argv.includes('--after-restart');
const T = 15_000;
const results: Array<{ check: string; pass: boolean }> = [];
const check = (check: string, pass: boolean) => {
    results.push({ check, pass });
    console.error(`${pass ? 'PASS' : 'FAIL'}  ${check}`);
};

async function view(page: Page): Promise<Frame> {
    const deadline = Date.now() + T;
    while (Date.now() < deadline) {
        for (const f of page.frames()) if (f !== page.mainFrame() && (await f.$('#household').catch(() => null))) return f;
        await page.waitForTimeout(200);
    }
    throw new Error('view not found');
}
const statusIs = (v: Frame, s: string) => v.waitForFunction(x => !!document.querySelector(`article.handoff[data-status="${x}"]`), s, { timeout: T });
const shoot = async (page: Page, name: string) => {
    await page.screenshot({ path: `${OUT}/${name}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${name}-narrow.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 1000 });
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(URL);
    const v = await view(page);
    if (afterRestart) {
        await statusIs(v, 'COMPLETED');
        await v.click('#handoffs-history summary');
        const text = (await v.textContent('#handoffs-history')) ?? '';
        check('after restart: Completed agreement with 3-entry audit trail, corrected responsibility labels', /Completed agreement/.test(text) && /Audit trail \(3\)/.test(text) && /Was responsible \(on duty\)Priya/.test(text) && /Now responsible for this task \(accepted\)Arjun/.test(text) && !/Responsible now/.test(text));
        await shoot(page, '40-after-restart');
    } else {
        await v.click('#refresh');
        await statusIs(v, 'PENDING_APPROVAL');
        check('Ravi\'s request is on the dashboard as Awaiting approval', /Awaiting approval/.test((await v.textContent('article.handoff')) ?? ''));
        await shoot(page, '30-awaiting-approval');
        await v.click('article.handoff button[data-action="approve"]');
        await statusIs(v, 'PENDING_ACCEPTANCE');
        check('Priya approved -> Awaiting recipient acceptance', true);
        await shoot(page, '31-awaiting-acceptance');
        await v.selectOption('#actor', 'mem_arjun');
        await v.click('article.handoff button[data-action="accept"]');
        await statusIs(v, 'COMPLETED');
        await v.click('#handoffs-history summary');
        const text = (await v.textContent('#handoffs-history')) ?? '';
        check('Arjun accepted -> Completed agreement, audit shows simulated accept, Arjun now responsible', /Completed agreement/.test(text) && /SIMULATED by Priya/.test(text) && /Was responsible \(on duty\)Priya/.test(text) && /Now responsible for this task \(accepted\)Arjun/.test(text) && !/Responsible now/.test(text));
        await shoot(page, '32-completed');
    }
} finally {
    await browser.close();
}
writeFileSync(`${OUT}/${afterRestart ? 'after-restart' : 'run'}.json`, JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
if (results.some(r => !r.pass)) process.exit(1);
