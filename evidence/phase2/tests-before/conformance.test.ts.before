/**
 * Raw-HTTP checks against MCP spec 2025-11-25, basic/transports (Streamable HTTP).
 * Each test names the rule it checks. Rules that are conditional on a server choice
 * (MAY/SHOULD) branch on what the server actually did instead of hardcoding a status.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { EXPECTED_TOOLS, initializeMessage, rawInitialize, rawPost, SPEC_VERSION, startHarness, type Harness } from './helpers.js';

let harness: Harness | undefined;
afterEach(async () => {
    await harness?.stop();
    harness = undefined;
});

const LIST_TOOLS = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const VISIBLE_ASCII = /^[\x21-\x7E]+$/;
// Notes for evidence: conditional branches report which path they took.
const observe = (label: string, value: unknown) => console.info(`[observed] ${label}: ${JSON.stringify(value)}`);

describe('lifecycle: version negotiation', () => {
    it('server answers initialize(2025-11-25) with protocolVersion 2025-11-25', async () => {
        harness = await startHarness();
        const res = await rawPost(harness.url, initializeMessage(SPEC_VERSION));
        expect((res.body as { result: { protocolVersion: string } }).result.protocolVersion).toBe(SPEC_VERSION);
    });

    it('unsupported requested version: server MUST respond with another version it supports (lifecycle §version negotiation)', async () => {
        harness = await startHarness();
        const res = await rawPost(harness.url, initializeMessage('2099-01-01'));
        const body = res.body as { result?: { protocolVersion: string }; error?: unknown };
        observe('init with 2099-01-01', { status: res.status, body });
        // Pinned server supports only 2025-11-25, so that is the only valid counter-offer.
        expect(body.result?.protocolVersion).toBe(SPEC_VERSION);
    });
});

describe('transports: Streamable HTTP', () => {
    it('POST of a JSON-RPC request returns application/json or text/event-stream (MUST)', async () => {
        harness = await startHarness();
        const { headers } = await rawInitialize(harness.url);
        const res = await rawPost(harness.url, LIST_TOOLS, headers);
        const type = res.headers.get('content-type') ?? '';
        expect(type.includes('application/json') || type.includes('text/event-stream')).toBe(true);
        expect((res.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(t => t.name).sort()).toEqual(EXPECTED_TOOLS);
    });

    it('POST of a JSON-RPC notification that is accepted returns 202 with no body (MUST)', async () => {
        harness = await startHarness();
        const init = await rawPost(harness.url, initializeMessage());
        const sid = init.headers.get('mcp-session-id');
        const headers: Record<string, string> = { 'mcp-protocol-version': SPEC_VERSION, ...(sid ? { 'mcp-session-id': sid } : {}) };
        const res = await rawPost(harness.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
        expect(res.status).toBe(202);
        expect(res.body).toBeUndefined();
    });

    it('GET returns text/event-stream or 405 (MUST)', async () => {
        harness = await startHarness();
        const { headers } = await rawInitialize(harness.url);
        const controller = new AbortController();
        const res = await fetch(harness.url, { method: 'GET', headers: { accept: 'text/event-stream', ...headers }, signal: controller.signal });
        observe('GET status/content-type', [res.status, res.headers.get('content-type')]);
        const ok = res.status === 405 || (res.headers.get('content-type') ?? '').includes('text/event-stream');
        controller.abort();
        expect(ok).toBe(true);
    });

    it('invalid or unsupported MCP-Protocol-Version header returns 400 (MUST)', async () => {
        harness = await startHarness();
        const { headers } = await rawInitialize(harness.url);
        const res = await rawPost(harness.url, LIST_TOOLS, { ...headers, 'mcp-protocol-version': '1999-01-01' });
        expect(res.status).toBe(400);
    });
});

describe('security: Origin validation', () => {
    it('present and invalid Origin returns 403 (MUST)', async () => {
        harness = await startHarness();
        const res = await rawPost(harness.url, initializeMessage(), { origin: 'https://evil.example' });
        expect(res.status).toBe(403);
    });

    it('localhost Origin is accepted (local browser host must be able to connect)', async () => {
        harness = await startHarness();
        const res = await rawPost(harness.url, initializeMessage(), { origin: 'http://localhost:5173' });
        expect(res.status).toBe(200);
    });

    it('absent Origin is not rejected (spec only constrains a present Origin)', async () => {
        harness = await startHarness();
        const res = await rawPost(harness.url, initializeMessage());
        expect(res.status).not.toBe(403);
    });

    it('server is bound to loopback only (SHOULD when running locally)', async () => {
        harness = await startHarness();
        expect(new URL(harness.url).hostname).toBe('127.0.0.1');
    });
});

describe('transports: session management', () => {
    it('session id, if assigned, is visible ASCII 0x21-0x7E (MUST)', async () => {
        harness = await startHarness();
        const { sessionId } = await rawInitialize(harness.url);
        observe('session id assigned', sessionId !== null);
        if (sessionId === null) return; // MAY not assign: nothing further to check
        expect(sessionId).toMatch(VISIBLE_ASCII);
    });

    it('server that requires a session id rejects non-init requests without one with 400 (SHOULD)', async () => {
        harness = await startHarness();
        const { sessionId } = await rawInitialize(harness.url);
        if (sessionId === null) return; // stateless server: rule not applicable
        const res = await rawPost(harness.url, LIST_TOOLS, { 'mcp-protocol-version': SPEC_VERSION });
        expect(res.status).toBe(400);
    });

    it('after DELETE terminates the session, requests with that id get 404 (MUST); DELETE may be 405', async () => {
        harness = await startHarness();
        const { sessionId, headers } = await rawInitialize(harness.url);
        if (sessionId === null) return;
        const del = await fetch(harness.url, { method: 'DELETE', headers });
        observe('DELETE status', del.status);
        if (del.status === 405) return; // server declined client-initiated termination: allowed
        expect(del.ok).toBe(true);
        const res = await rawPost(harness.url, LIST_TOOLS, headers);
        expect(res.status).toBe(404);
    });

    it('a live session keeps working across requests (session id round-trips)', async () => {
        harness = await startHarness();
        const { headers } = await rawInitialize(harness.url);
        const first = await rawPost(harness.url, LIST_TOOLS, headers);
        const second = await rawPost(harness.url, { ...LIST_TOOLS, id: 3 }, headers);
        expect([first.status, second.status]).toEqual([200, 200]);
    });

    it('informative: request with a never-issued session id', async () => {
        harness = await startHarness();
        const res = await rawPost(harness.url, LIST_TOOLS, { 'mcp-protocol-version': SPEC_VERSION, 'mcp-session-id': 'never-issued' });
        observe('unknown session id status', res.status);
        expect([400, 404]).toContain(res.status);
    });
});
