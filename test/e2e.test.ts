import { afterEach, describe, expect, it } from 'vitest';

import type { Client } from '@modelcontextprotocol/client';

import { connect } from '../src/client.js';
import { EXPECTED_TOOLS, SPEC_VERSION, startHarness, type Harness } from './helpers.js';

let harness: Harness | undefined;

const RAVI = 'mem_ravi';
const recentNotes = async (client: Client) => {
    const res = await client.callTool({ name: 'get_household_status', arguments: { household_id: 'hh_rao' } });
    return (res.structuredContent as { recent_events: Array<{ note: string }> }).recent_events.map(e => e.note);
};
const eventCount = (h: Harness) => (h.db.prepare('SELECT COUNT(*) AS n FROM care_events').get() as { n: number }).n;
afterEach(async () => {
    await harness?.stop();
    harness = undefined;
});

describe('SDK client against CareLoop server', () => {
    it('negotiates protocol version 2025-11-25 and exposes exactly the expected tools', async () => {
        harness = await startHarness();
        const { client, transport } = await connect(harness.url);

        expect(client.getNegotiatedProtocolVersion()).toBe(SPEC_VERSION);
        const { tools } = await client.listTools();
        expect(tools.map(t => t.name).sort()).toEqual(EXPECTED_TOOLS);

        await client.close();
        expect(transport).toBeDefined();
    });

    it('sends MCP-Protocol-Version on every request after initialize', async () => {
        harness = await startHarness();
        const { client, wire } = await connect(harness.url);
        await client.listTools();
        await client.close();

        const [initPost, ...rest] = wire;
        expect(initPost?.method).toBe('POST');
        expect(rest.length).toBeGreaterThan(0);
        for (const record of rest) expect(record.requestHeaders['mcp-protocol-version']).toBe(SPEC_VERSION);
    });

    it('record_care_event stores a synthetic event and returns it as structured content', async () => {
        harness = await startHarness();
        const { client } = await connect(harness.url, { actor: RAVI });

        const result = await client.callTool({
            name: 'record_care_event',
            arguments: { household_id: 'hh_rao', idempotency_key: 'e2e-meal-0001', kind: 'meal', note: 'synthetic: ate lunch' }
        });

        expect(result.isError ?? false).toBe(false);
        expect((result.structuredContent as { event: object }).event).toMatchObject({ kind: 'meal', note: 'synthetic: ate lunch' });
        expect(await recentNotes(client)).toContain('synthetic: ate lunch');
        await client.close();
    });

    it('rejects invalid record_care_event input instead of storing it', async () => {
        harness = await startHarness();
        const { client } = await connect(harness.url, { actor: RAVI });

        let rejected = false;
        try {
            const result = await client.callTool({
                name: 'record_care_event',
                arguments: { household_id: 'hh_rao', idempotency_key: 'e2e-bad-0001', kind: 'not-a-kind', note: '' }
            });
            rejected = result.isError === true;
        } catch {
            rejected = true;
        }

        expect(rejected).toBe(true);
        expect(eventCount(harness)).toBe(0);
        await client.close();
    });

    it('persists events to disk: a fresh server and fresh client read what an earlier session wrote', async () => {
        harness = await startHarness();
        const { dbPath } = harness;
        const writer = await connect(harness.url, { actor: RAVI });
        await writer.client.callTool({
            name: 'record_care_event',
            arguments: { household_id: 'hh_rao', idempotency_key: 'e2e-persist-01', kind: 'medication', note: 'synthetic NONCE-T1' }
        });
        await writer.transport.terminateSession();
        await writer.client.close();
        await harness.stop();

        harness = await startHarness(dbPath);
        const reader = await connect(harness.url, { actor: RAVI });

        expect(reader.transport.sessionId).not.toBe(writer.transport.sessionId);
        expect(await recentNotes(reader.client)).toContain('synthetic NONCE-T1');
        await reader.client.close();
    });
});
