/**
 * MCP App view for the KinSync dashboard (built from the CareLoop codebase). Runs inside the host's sandboxed iframe and
 * receives data only through the MCP Apps bridge (tool-result notifications and
 * host-proxied tools/call), never by fetching the server directly.
 */
import { App } from '@modelcontextprotocol/ext-apps';

import { renderHandoffs, type HandoffViewData } from './handoff-view.js';

interface DashboardEvent {
    id: string;
    kind: string;
    note: string;
    createdAt: string;
}

interface DashboardData extends HandoffViewData {
    household: string;
    householdId: string;
    generatedAt: string;
    total: number;
    counts: Record<string, number>;
    events: DashboardEvent[];
    duty_contact?: { name: string; relationship: string };
    medication_reference?: Array<{ label: string; times_of_day: string[]; status_text: string }>;
    pending_approvals?: Array<{ approval_id: string; requested_by: string; draft_preview: string }>;
}

function listItems(id: string, items: Array<{ title: string; detail?: string; key?: string }>, empty: string): void {
    const nodes = items.length ? items : [{ title: empty }];
    byId(id).replaceChildren(
        ...nodes.map(item => {
            const li = document.createElement('li');
            li.textContent = item.title;
            if (item.key) li.dataset.key = item.key;
            if (item.detail) {
                const pre = document.createElement('pre');
                pre.textContent = item.detail;
                li.append(pre);
            }
            return li;
        })
    );
}

const byId = (id: string) => document.getElementById(id)!;

function isDashboardData(value: unknown): value is DashboardData {
    const v = value as Partial<DashboardData> | null;
    return !!v && typeof v.household === 'string' && Array.isArray(v.events) && typeof v.counts === 'object';
}

function cell(text: string): HTMLTableCellElement {
    const td = document.createElement('td');
    td.textContent = text; // textContent only: tool data is never parsed as HTML
    return td;
}

function render(data: DashboardData, via: string): void {
    byId('household').textContent = data.household;
    byId('duty').textContent = data.duty_contact ? `On duty today: ${data.duty_contact.name} (${data.duty_contact.relationship})` : '';
    listItems(
        'meds',
        (data.medication_reference ?? []).map(m => ({ title: `${m.label} - ${m.times_of_day.join(', ')} - ${m.status_text}` })),
        'No schedule entered'
    );
    listItems(
        'approvals',
        (data.pending_approvals ?? []).map(a => ({ title: `Notification requested by ${a.requested_by}`, detail: a.draft_preview, key: a.approval_id })),
        'Nothing waiting'
    );
    renderHandoffs(data, handoffHost);
    byId('status').textContent = `${data.total} events · generated ${data.generatedAt} · via ${via}`;

    const counts = byId('counts');
    counts.replaceChildren(
        ...Object.entries(data.counts).map(([kind, n]) => {
            const li = document.createElement('li');
            const strong = document.createElement('strong');
            strong.textContent = String(n);
            li.append(strong, kind);
            return li;
        })
    );

    byId('events').replaceChildren(
        ...data.events.map(e => {
            const tr = document.createElement('tr');
            tr.dataset.eventId = String(e.id);
            tr.append(cell(String(e.id)), cell(e.kind), cell(e.note), cell(e.createdAt));
            return tr;
        })
    );
}

const handoffHost = {
    callTool: (name: string, args: Record<string, unknown>) => app.callServerTool({ name, arguments: args }),
    reload: async () => showResult(await app.callServerTool({ name: 'show_care_dashboard', arguments: {} }), 'app → host → tools/call')
};

function showResult(result: { structuredContent?: unknown; isError?: boolean }, via: string): void {
    if (result.isError || !isDashboardData(result.structuredContent)) {
        byId('status').textContent = `Could not load dashboard data (${via}).`;
        return;
    }
    render(result.structuredContent, via);
}

const app = new App({ name: 'KinSync Dashboard', version: '0.1.0' });
app.ontoolresult = result => showResult(result, 'host tool-result notification');
app.onerror = err => console.error('[kinsync-view]', err);

byId('refresh').addEventListener('click', async () => {
    byId('status').textContent = 'Refreshing...';
    try {
        showResult(await app.callServerTool({ name: 'show_care_dashboard', arguments: {} }), 'app → host → tools/call');
    } catch (err) {
        console.error('[kinsync-view] refresh failed', err);
        byId('status').textContent = 'Refresh failed.';
    }
});

void app.connect();
