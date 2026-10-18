/**
 * MCP Apps (SEP-1865, spec 2026-01-26) server-side requirements, checked over the wire
 * with the same SDK client a host uses. Host-side rendering is covered by test/render.e2e.ts.
 */
import { getToolUiResourceUri, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/app-bridge';
import { afterEach, describe, expect, it } from 'vitest';

import { connect } from '../src/client.js';
import { DASHBOARD_URI } from '../src/server.js';
import { initializeMessage, rawPost, SPEC_VERSION, startHarness, type Harness } from './helpers.js';

let harness: Harness | undefined;
afterEach(async () => {
    await harness?.stop();
    harness = undefined;
});

interface DashboardData {
    total: number;
    counts: Record<string, number>;
    events: Array<{ id: string; note: string }>;
}

describe('MCP Apps: resource registration and discovery', () => {
    it('show_care_dashboard advertises a ui:// resource via _meta.ui.resourceUri (official helper)', async () => {
        harness = await startHarness();
        const { client } = await connect(harness.url);
        const { tools } = await client.listTools();
        const tool = tools.find(t => t.name === 'show_care_dashboard');

        expect(tool).toBeDefined();
        const uri = getToolUiResourceUri(tool!);
        expect(uri).toBe(DASHBOARD_URI);
        expect(uri!.startsWith('ui://')).toBe(true); // spec: URI MUST start with ui://
        await client.close();
    });

    it('the referenced resource exists in resources/list (spec: resource MUST exist on the server)', async () => {
        harness = await startHarness();
        const { client } = await connect(harness.url);
        const { resources } = await client.listResources();
        expect(resources.map(r => r.uri)).toContain(DASHBOARD_URI);
        await client.close();
    });

    it('resources/read returns text/html;profile=mcp-app with a complete HTML5 document', async () => {
        harness = await startHarness();
        const { client } = await connect(harness.url);
        const { contents } = await client.readResource({ uri: DASHBOARD_URI });
        const [content] = contents;

        expect(RESOURCE_MIME_TYPE).toBe('text/html;profile=mcp-app');
        expect(content?.mimeType).toBe(RESOURCE_MIME_TYPE);
        const html = content && 'text' in content ? content.text : '';
        expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
        expect(html).toContain('</html>');
        expect(html).toContain('ui/initialize'); // the bundled App performs the MCP Apps handshake
        await client.close();
    });

    it('the view gets no direct network path to the server: no CSP connectDomains, no server address embedded', async () => {
        harness = await startHarness();
        const { client } = await connect(harness.url);
        const { contents } = await client.readResource({ uri: DASHBOARD_URI });
        const content = contents[0] as { text?: string; _meta?: { ui?: { csp?: { connectDomains?: string[] } } } };
        const html = content.text ?? '';

        // spec: with no ui.csp declared the host MUST apply its restrictive default, which includes connect-src 'none'
        expect(content._meta?.ui?.csp?.connectDomains ?? []).toEqual([]);
        expect(html.includes(new URL(harness.url).host)).toBe(false);
        await client.close();
    });
});

describe('MCP Apps: data flow', () => {
    it('tool result carries the persisted events, and a later record_care_event is visible on the next call', async () => {
        harness = await startHarness();
        const { client } = await connect(harness.url, { actor: 'mem_ravi' });

        const before = (await client.callTool({ name: 'show_care_dashboard', arguments: {} })).structuredContent as DashboardData;
        await client.callTool({
            name: 'record_care_event',
            arguments: { household_id: 'hh_rao', idempotency_key: 'ui-meal-00001', kind: 'meal', note: 'synthetic NONCE-UI1' }
        });
        const after = (await client.callTool({ name: 'show_care_dashboard', arguments: {} })).structuredContent as DashboardData;

        expect(after.total).toBe(before.total + 1);
        expect(after.counts.meal).toBe((before.counts.meal ?? 0) + 1);
        expect(after.events[0]?.note).toBe('synthetic NONCE-UI1');
        await client.close();
    });

    it('session negotiated for the MCP Apps host path is still 2025-11-25', async () => {
        harness = await startHarness();
        const { client } = await connect(harness.url);
        expect(client.getNegotiatedProtocolVersion()).toBe(SPEC_VERSION);
        await client.close();
    });
});

describe('security: CORS allowlist for browser hosts', () => {
    const HOST_ORIGIN = 'http://localhost:8080';

    const preflight = (url: string, origin: string) =>
        fetch(url, {
            method: 'OPTIONS',
            headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, mcp-protocol-version' }
        });

    it('allowlisted origin: preflight grants the MCP headers', async () => {
        harness = await startHarness(undefined, [HOST_ORIGIN]);
        const res = await preflight(harness.url, HOST_ORIGIN);
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe(HOST_ORIGIN);
        expect(res.headers.get('access-control-allow-headers')).toContain('mcp-protocol-version');
    });

    it('allowlisted origin: initialize response exposes mcp-session-id to the page', async () => {
        harness = await startHarness(undefined, [HOST_ORIGIN]);
        const res = await rawPost(harness.url, initializeMessage(), { origin: HOST_ORIGIN });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe(HOST_ORIGIN);
        expect(res.headers.get('access-control-expose-headers')).toContain('mcp-session-id');
    });

    it('localhost origin not on the allowlist gets no CORS grant (browser cannot read responses)', async () => {
        harness = await startHarness(undefined, [HOST_ORIGIN]);
        const res = await preflight(harness.url, 'http://localhost:9999');
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('enabling CORS does not weaken Origin validation: foreign origin still gets 403 (preflight and POST)', async () => {
        harness = await startHarness(undefined, [HOST_ORIGIN, 'https://evil.example']);
        const pre = await preflight(harness.url, 'https://evil.example');
        const post = await rawPost(harness.url, initializeMessage(), { origin: 'https://evil.example' });
        expect(pre.status).toBe(403);
        expect(post.status).toBe(403);
    });

    it('default (no allowlist) sends no CORS headers at all', async () => {
        harness = await startHarness();
        const res = await rawPost(harness.url, initializeMessage(), { origin: HOST_ORIGIN });
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
});
