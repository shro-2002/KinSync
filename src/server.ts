import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest, McpServer } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';

import type { Operation } from './domain/authz.js';
import { CareService, type ServiceOptions } from './domain/service.js';
import { registerDashboard } from './mcp/dashboard.js';
import { registerDomainTools, type SessionInfo } from './mcp/tools.js';

export { DASHBOARD_HTML_PATH, DASHBOARD_URI } from './mcp/dashboard.js';

// Rules require MCP spec 2025-11-25; pin it so newer SDK eras can't be negotiated.
export const PROTOCOL_VERSION = '2025-11-25';

/**
 * Synthetic identity header (no authentication yet). Bound to the session at initialize,
 * so tool arguments can never choose who is acting. To be replaced by OAuth bearer tokens.
 */
export const ACTOR_HEADER = 'x-careloop-actor';

export function buildMcpServer(service: CareService, actorId: string | undefined, session: SessionInfo = { simulatedActors: false }): McpServer {
    const server = new McpServer({ name: 'careloop', version: '0.3.0' }, { supportedProtocolVersions: [PROTOCOL_VERSION] });
    const actor = (op: Operation, args: unknown) => service.resolveSessionActor(actorId, op, args, session.simulatedActors);
    registerDomainTools(server, service, actor);
    registerDashboard(server, service, actor, session);
    return server;
}

const CORS_ALLOW_HEADERS = `content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id, ${ACTOR_HEADER}`;

// Browser hosts (e.g. the MCP Apps basic-host on :8080) call the server cross-origin.
// Runs after createMcpExpressApp's Origin validation, so it can only add headers for
// origins that already passed; it never widens what the server accepts.
function corsAllowlist(allowedOrigins: string[]) {
    const allowed = new Set(allowedOrigins);
    return (req: Request, res: Response, next: () => void) => {
        const origin = req.header('origin');
        if (origin && allowed.has(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
        }
        if (req.method !== 'OPTIONS') return next();
        if (origin && allowed.has(origin)) {
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
        }
        res.status(204).end();
    };
}

export interface ServerOptions extends ServiceOptions {
    db: DatabaseSync;
    port: number;
    corsOrigins?: string[];
    /** Local demos only: actor for sessions that send no X-CareLoop-Actor (e.g. browser hosts). */
    defaultActorId?: string;
    /**
     * Demo only: lets a session that has no X-CareLoop-Actor header (a browser host) act as another household
     * member on the two human handoff tools, labeled "simulated" everywhere. Header-bound sessions (the AI adapter,
     * independent clients) can never switch identity, whatever this is set to. Not authentication.
     */
    simulatedActors?: boolean;
}

export interface RunningServer {
    url: string;
    service: CareService;
    close(): Promise<void>;
}

const jsonRpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

// Sessionful 2025-era Streamable HTTP, following the SDK's standalone-get example.
export function startServer(options: ServerOptions): Promise<RunningServer> {
    const service = new CareService(options.db, options);
    const transports = new Map<string, NodeStreamableHTTPServerTransport>();
    const app = createMcpExpressApp(); // 127.0.0.1 bind => Host + Origin validation on by default
    app.use(corsAllowlist(options.corsOrigins ?? []));

    app.post('/mcp', async (req: Request, res: Response) => {
        const sid = req.header('mcp-session-id');
        const existing = sid ? transports.get(sid) : undefined;
        if (existing) return existing.handleRequest(req, res, req.body);
        if (sid) return res.status(404).json(jsonRpcError(-32_001, 'Session not found'));
        if (!isInitializeRequest(req.body)) return res.status(400).json(jsonRpcError(-32_000, 'Bad Request: Session ID required'));

        const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: id => void transports.set(id, transport)
        });
        transport.onclose = () => void (transport.sessionId && transports.delete(transport.sessionId));
        const headerActor = req.header(ACTOR_HEADER);
        const actorId = headerActor ?? options.defaultActorId;
        await buildMcpServer(service, actorId, { simulatedActors: options.simulatedActors === true && !headerActor }).connect(transport);
        await transport.handleRequest(req, res, req.body);
    });

    const sessionVerb = async (req: Request, res: Response) => {
        const sid = req.header('mcp-session-id');
        const transport = sid ? transports.get(sid) : undefined;
        if (!transport) return res.status(sid ? 404 : 400).json(jsonRpcError(-32_001, sid ? 'Session not found' : 'Missing session ID'));
        await transport.handleRequest(req, res);
    };
    app.get('/mcp', sessionVerb);
    app.delete('/mcp', sessionVerb);

    return new Promise(resolve => {
        const http: Server = app.listen(options.port, '127.0.0.1', () => {
            const address = http.address();
            const boundPort = typeof address === 'object' && address ? address.port : options.port;
            resolve({
                url: `http://127.0.0.1:${boundPort}/mcp`,
                service,
                close: async () => {
                    await Promise.all([...transports.values()].map(t => t.close()));
                    await new Promise<void>(done => http.close(() => done()));
                }
            });
        });
    });
}
