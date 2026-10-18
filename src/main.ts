import { openDatabase } from './domain/migrations.js';
import { isEmpty, seedDemoData } from './domain/seed.js';
import { startServer } from './server.js';

const DEFAULT_PORT = 3333;
const port = Number(process.env.PORT ?? DEFAULT_PORT);
const dbPath = process.env.CARELOOP_DB ?? 'data/careloop.db';
// Comma-separated browser origins allowed CORS access, e.g. http://localhost:8080 for the MCP Apps basic-host.
const corsOrigins = (process.env.CARELOOP_CORS_ORIGINS ?? '').split(',').map(o => o.trim()).filter(Boolean);
// Local demos only: synthetic actor for sessions without an X-CareLoop-Actor header.
const defaultActorId = process.env.CARELOOP_DEFAULT_ACTOR || undefined;

// Demo only: lets header-less (browser host) sessions use the labeled simulated-actor switcher. Not authentication.
const simulatedActors = process.env.CARELOOP_SIMULATED_ACTORS === '1';

const db = openDatabase(dbPath);
if (isEmpty(db)) seedDemoData(db);
const server = await startServer({ db, port, corsOrigins, defaultActorId, simulatedActors });
console.error(
    `[careloop] MCP server on ${server.url} (db: ${dbPath}, cors: ${corsOrigins.join(' ') || 'none'}, default actor: ${defaultActorId ?? 'none'}, simulated actors: ${simulatedActors}, pid ${process.pid})`
);

const shutdown = async () => {
    await server.close();
    db.close();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
