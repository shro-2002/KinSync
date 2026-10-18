import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../src/domain/migrations.js';
import { seedDemoData } from '../src/domain/seed.js';
import type { ServiceOptions } from '../src/domain/service.js';
import { startServer, type RunningServer } from '../src/server.js';

export const SPEC_VERSION = '2025-11-25';
export const ACCEPT_BOTH = 'application/json, text/event-stream';
// PoC-0 exposed log_event; PoC-1 added the MCP Apps dashboard; Phase 2 replaced log_event with the domain tools.
// Phase 4 (KinSync) added the four care-handoff tools.
export const EXPECTED_TOOLS = [
    'decide_approval',
    'decide_handoff',
    'draft_caregiver_notification',
    'get_duty_contact',
    'get_handoffs',
    'get_household_status',
    'prepare_appointment_request',
    'propose_handoff',
    'record_care_event',
    'respond_to_handoff',
    'show_care_dashboard'
];

// Fixed clock for deterministic tests: Monday 2026-10-12 09:30 in Asia/Kolkata (duty: Priya).
export const FIXED_NOW = new Date('2026-10-12T04:00:00.000Z');

export interface Harness {
    url: string;
    dbPath: string;
    db: DatabaseSync;
    server: RunningServer;
    stop(): Promise<void>;
}

export interface HarnessOptions extends ServiceOptions {
    defaultActorId?: string;
    simulatedActors?: boolean;
}

export const tempDbPath = () => join(mkdtempSync(join(tmpdir(), 'careloop-')), 'test.db');

export async function startHarness(dbPath = tempDbPath(), corsOrigins: string[] = [], options: HarnessOptions = {}): Promise<Harness> {
    const db = openDatabase(dbPath);
    seedDemoData(db);
    const server = await startServer({ db, port: 0, corsOrigins, now: () => FIXED_NOW, ...options });
    return {
        url: server.url,
        dbPath,
        db,
        server,
        stop: async () => {
            await server.close();
            db.close();
        }
    };
}

export interface RawResponse {
    status: number;
    headers: Headers;
    body: unknown;
}

// Reads either a single JSON body or the first JSON-RPC message of an SSE stream.
async function parseBody(res: Response): Promise<unknown> {
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    if (!text) return undefined;
    if (type.includes('text/event-stream')) {
        const dataLine = text.split('\n').find(line => line.startsWith('data:') && line.length > 'data:'.length + 1);
        return dataLine ? JSON.parse(dataLine.slice('data:'.length).trim()) : undefined;
    }
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

export async function rawPost(url: string, message: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: ACCEPT_BOTH, ...headers },
        body: JSON.stringify(message)
    });
    return { status: res.status, headers: res.headers, body: await parseBody(res) };
}

export const initializeMessage = (protocolVersion = SPEC_VERSION) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'raw-conformance', version: '0.0.1' } }
});

export interface RawSession {
    sessionId: string | null;
    initResponse: RawResponse;
    headers: Record<string, string>;
}

// Performs initialize + notifications/initialized the way the spec describes, with no SDK.
export async function rawInitialize(url: string, protocolVersion = SPEC_VERSION): Promise<RawSession> {
    const initResponse = await rawPost(url, initializeMessage(protocolVersion));
    const sessionId = initResponse.headers.get('mcp-session-id');
    const negotiated = (initResponse.body as { result?: { protocolVersion?: string } })?.result?.protocolVersion ?? SPEC_VERSION;
    const headers: Record<string, string> = { 'mcp-protocol-version': negotiated };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    await rawPost(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
    return { sessionId, initResponse, headers };
}
