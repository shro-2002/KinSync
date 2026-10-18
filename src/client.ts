import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { ACTOR_HEADER } from './server.js';

export interface WireRecord {
    method: string;
    requestHeaders: Record<string, string>;
    status: number;
    responseHeaders: Record<string, string>;
}

const PICK_REQUEST = ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id', ACTOR_HEADER];
const PICK_RESPONSE = ['content-type', 'mcp-session-id'];

function pick(headers: Headers, keys: string[]): Record<string, string> {
    return Object.fromEntries(keys.filter(k => headers.has(k)).map(k => [k, headers.get(k)!]));
}

export interface ConnectedClient {
    client: Client;
    transport: StreamableHTTPClientTransport;
    wire: WireRecord[];
}

export interface ConnectOptions {
    /** Synthetic actor (member id) sent as X-CareLoop-Actor on every request of the session. */
    actor?: string;
}

// Independent MCP client: uses only the public client package, never server code paths.
export async function connect(url: string, options: ConnectOptions = {}): Promise<ConnectedClient> {
    const wire: WireRecord[] = [];
    const recordingFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const res = await fetch(input, init);
        wire.push({
            method: init?.method ?? 'GET',
            requestHeaders: pick(new Headers(init?.headers), PICK_REQUEST),
            status: res.status,
            responseHeaders: pick(res.headers, PICK_RESPONSE)
        });
        return res;
    };
    const client = new Client({ name: 'careloop-poc-client', version: '0.0.1' }, { versionNegotiation: { mode: 'legacy' } });
    const requestInit = options.actor ? { headers: { [ACTOR_HEADER]: options.actor } } : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: recordingFetch, requestInit });
    await client.connect(transport);
    return { client, transport, wire };
}
