// MCP Apps (SEP-1865): a read-only tool linked via _meta.ui.resourceUri to a ui:// HTML resource.
import { readFile } from 'node:fs/promises';

import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { dashboardInput } from '../domain/inputs.js';
import type { CareService } from '../domain/service.js';
import { domainValidated } from './schema.js';
import { toolResult, type ActorResolver, type SessionInfo } from './tools.js';

export const DASHBOARD_URI = 'ui://careloop/dashboard.html';
export const DASHBOARD_HTML_PATH = new URL('../../dist/ui/dashboard.html', import.meta.url);

// looseObject: the view needs these fields; the full household status rides along.
const dashboardOutput = z.looseObject({
    household: z.string(),
    householdId: z.string(),
    generatedAt: z.string(),
    total: z.number(),
    counts: z.record(z.string(), z.number()),
    events: z.array(z.object({ id: z.string(), kind: z.string(), note: z.string(), createdAt: z.string() }))
});

export function registerDashboard(server: McpServer, service: CareService, actor: ActorResolver, session: SessionInfo = { simulatedActors: false }): void {
    registerAppTool(
        server,
        'show_care_dashboard',
        {
            title: 'Show care dashboard',
            description: "Show the KinSync household care dashboard (read-only): duty contact, care handoffs with approval and acceptance status, today's medication reports, recent events, pending approvals.",
            inputSchema: domainValidated(dashboardInput),
            outputSchema: dashboardOutput,
            annotations: { readOnlyHint: true, openWorldHint: false },
            _meta: { ui: { resourceUri: DASHBOARD_URI } }
        },
        args =>
            toolResult(() => {
                const viewer = actor('show_care_dashboard', args);
                // Tells the view whether it may offer the labeled simulated-actor switcher; the server decides, not the view.
                return { ...service.showDashboard(viewer, args), simulation: { enabled: session.simulatedActors, session_actor_id: viewer.memberId } };
            })
    );

    registerAppResource(server, 'CareLoop dashboard', DASHBOARD_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => {
        const html = await readFile(DASHBOARD_HTML_PATH, 'utf8').catch(err => {
            throw new Error('Dashboard UI not built; run `pnpm build:ui`', { cause: err });
        });
        return { contents: [{ uri: DASHBOARD_URI, mimeType: RESOURCE_MIME_TYPE, text: html }] };
    });
}
