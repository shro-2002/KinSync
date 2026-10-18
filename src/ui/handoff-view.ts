/**
 * KinSync care-handoff section of the MCP App view. Every button calls a real MCP tool through the host
 * (app -> host -> tools/call) and re-renders from the server's answer; nothing is decided or faked here.
 * Who may act is read from the server's `eligible` lists, and the server re-checks every call regardless.
 */
interface Person {
    member_id: string;
    name: string;
}

interface Step {
    by: Person | null;
    at: string | null;
    actor_mode: 'session' | 'simulated' | null;
    reason: string | null;
}

export interface HandoffData {
    id: string;
    status: string;
    status_text: string;
    task_description: string;
    requested_by: Person;
    current_owner: Person;
    proposed_recipient: Person;
    recipient_basis: string;
    approval: Step & { state: string };
    acceptance: Step & { state: string };
    eligible: { approve_or_reject: string[]; accept_or_decline: string[] };
    history: Array<{ event: string; from: string | null; to: string; by: Person; actor_mode: string; simulated_by: Person | null; reason: string | null; at: string }>;
    created_at: string;
}

type Member = Person & { relationship: string; role: string };

export interface HandoffViewData {
    householdId: string;
    members: Member[];
    handoffs: HandoffData[];
    simulation: { enabled: boolean; session_actor_id: string };
}

export interface HandoffHost {
    callTool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; content?: unknown }>;
    reload(): Promise<void>;
}

type StageState = 'done' | 'current' | 'todo' | 'stopped';

const OPEN = ['PENDING_APPROVAL', 'PENDING_ACCEPTANCE'];
const BADGE: Record<string, string> = {
    PENDING_APPROVAL: 'Awaiting approval',
    PENDING_ACCEPTANCE: 'Awaiting recipient acceptance',
    COMPLETED: 'Completed agreement',
    REJECTED: 'Rejected',
    DECLINED: 'Declined'
};
// Text, not just colour, carries each stage's state (also read by screen readers).
const STAGE_WORD: Record<StageState, string> = { done: 'Done', current: 'In progress', todo: 'Not yet', stopped: 'Stopped' };
const STAGE_MARK: Record<StageState, string> = { done: '✓', current: '●', todo: '○', stopped: '✕' };

const byId = (id: string) => document.getElementById(id)!;
const roleLabel = (role: string) => role.replace('_', ' ');

// Chosen in the (labeled, simulated) switcher; survives re-renders. Null until the first data arrives.
let actorId: string | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    const { dataset, ...rest } = props;
    Object.assign(node, rest);
    for (const [k, v] of Object.entries(dataset ?? {})) node.dataset[k] = v;
    node.append(...children);
    return node;
}

export function renderHandoffs(data: HandoffViewData, host: HandoffHost): void {
    if (!actorId || !data.members.some(m => m.member_id === actorId)) actorId = data.simulation.session_actor_id;
    renderActorSwitcher(data, host);
    const active = data.handoffs.filter(h => OPEN.includes(h.status));
    const closed = data.handoffs.filter(h => !OPEN.includes(h.status));
    byId('open-count').textContent = String(active.length);
    byId('done-count').textContent = String(closed.filter(h => h.status === 'COMPLETED').length);
    byId('handoffs-active').replaceChildren(
        ...(active.length ? active.map(h => card(h, data, host)) : [el('p', { className: 'muted', textContent: 'No open handoffs. When someone asks KinSync for help with a care task, the proposal appears here.' })])
    );
    byId('handoffs-history').replaceChildren(
        ...(closed.length ? closed.map(h => el('li', { dataset: { handoffId: h.id, status: h.status } }, card(h, data, host))) : [el('li', { className: 'muted', textContent: 'Nothing completed, rejected or declined yet.' })])
    );
}

function renderActorSwitcher(data: HandoffViewData, host: HandoffHost): void {
    const select = byId('actor') as HTMLSelectElement;
    const sessionName = data.members.find(m => m.member_id === data.simulation.session_actor_id)?.name ?? data.simulation.session_actor_id;
    byId('actor-bar').hidden = false;
    select.hidden = !data.simulation.enabled;
    byId('actor-tag').hidden = !data.simulation.enabled;
    if (!data.simulation.enabled) {
        byId('actor-label').textContent = `Acting as ${sessionName} (this session's identity)`;
        byId('actor-help').textContent = '';
        return;
    }
    byId('actor-label').textContent = 'Demo only, not authentication. Acting as:';
    byId('actor-help').textContent = `Switching people is a labeled demo aid. The real session is ${sessionName}'s; the server re-checks who may act on every click and records the switch as "simulated".`;
    select.replaceChildren(...data.members.map(m => el('option', { value: m.member_id, textContent: `${m.name} (${roleLabel(m.role)})`, selected: m.member_id === actorId })));
    select.onchange = () => {
        actorId = select.value;
        setMessage('', '');
        renderHandoffs(data, host);
    };
}

function card(h: HandoffData, data: HandoffViewData, host: HandoffHost): HTMLElement {
    const [fromNote, toNote] = peopleLabels(h);
    const from = el('div', { className: 'person' }, el('span', { textContent: fromNote }), el('b', { textContent: h.current_owner.name }));
    const to = el('div', { className: 'person' }, el('span', { textContent: toNote }), el('b', { textContent: h.proposed_recipient.name }));
    return el(
        'article',
        { className: 'handoff', dataset: { handoffId: h.id, status: h.status } },
        el('div', { className: 'card-top' }, el('span', { className: 'badge', textContent: BADGE[h.status] ?? h.status }), el('span', { className: 'muted', textContent: `Requested by ${h.requested_by.name}` })),
        el('blockquote', { textContent: `“${h.task_description}”` }),
        el('div', { className: 'people' }, from, el('span', { className: 'arrow', textContent: '→', ariaHidden: 'true' }), to),
        el('ol', { className: 'lifecycle', ariaLabel: 'Handoff progress' }, ...stages(h).map(s => stage(s.title, s.note, s.state))),
        el('p', { className: 'status-text', textContent: h.status_text }),
        OPEN.includes(h.status) ? controls(h, data, host) : el('span'),
        auditTable(h)
    );
}

/** Who holds the task depends on the outcome; never say someone took over before they accepted. */
function peopleLabels(h: HandoffData): [string, string] {
    const onlyEligible = h.recipient_basis === 'only_eligible_member' ? ' (only eligible member)' : '';
    if (h.status === 'COMPLETED') return ['Was responsible (on duty)', 'Now responsible for this task (accepted)'];
    if (h.status === 'REJECTED' || h.status === 'DECLINED') return ['Still responsible (on duty)', `Was proposed${onlyEligible}`];
    return ['Responsible now (on duty)', `Proposed to take over${onlyEligible}`];
}

const by = (s: Step) => `${s.by?.name ?? 'someone'}${s.actor_mode === 'simulated' ? ' (SIMULATED)' : ''}`;

function stages(h: HandoffData): Array<{ title: string; note: string; state: StageState }> {
    const to = h.proposed_recipient.name;
    const approval = approvalStage(h);
    return [
        { title: 'Requested', note: `${h.requested_by.name} asked for help`, state: 'done' },
        approval,
        acceptanceStage(h, to),
        { title: 'Completed', note: h.status === 'COMPLETED' ? 'Agreement recorded' : 'Needs approval and acceptance', state: h.status === 'COMPLETED' ? 'done' : 'todo' }
    ];
}

function approvalStage(h: HandoffData): { title: string; note: string; state: StageState } {
    const title = 'Awaiting approval';
    if (h.approval.state === 'approved') return { title, note: `Approved by ${by(h.approval)}`, state: 'done' };
    if (h.approval.state === 'rejected') return { title, note: `Rejected by ${by(h.approval)}`, state: 'stopped' };
    return { title, note: 'Care recipient or coordinator decides', state: 'current' };
}

function acceptanceStage(h: HandoffData, to: string): { title: string; note: string; state: StageState } {
    const title = 'Awaiting recipient acceptance';
    if (h.acceptance.state === 'accepted') return { title, note: `Accepted by ${by(h.acceptance)}`, state: 'done' };
    if (h.acceptance.state === 'declined') return { title, note: `Declined by ${by(h.acceptance)}`, state: 'stopped' };
    if (h.status === 'PENDING_ACCEPTANCE') return { title, note: `Only ${to} can accept or decline`, state: 'current' };
    return { title, note: h.status === 'REJECTED' ? 'Not reached' : `${to} responds after approval`, state: 'todo' };
}

const stage = (title: string, note: string, state: StageState) =>
    el(
        'li',
        { dataset: { state } },
        el('strong', {}, el('span', { textContent: `${STAGE_MARK[state]} `, ariaHidden: 'true' }), title),
        el('span', { textContent: `${STAGE_WORD[state]}: ${note}` })
    );

function controls(h: HandoffData, data: HandoffViewData, host: HandoffHost): HTMLElement {
    const awaitingApproval = h.status === 'PENDING_APPROVAL';
    const allowed = awaitingApproval ? h.eligible.approve_or_reject : h.eligible.accept_or_decline;
    const mayAct = allowed.includes(actorId!);
    const actor = data.members.find(m => m.member_id === actorId);
    const actorText = actor ? `${actor.name} (${roleLabel(actor.role)})` : 'this person';
    const tool = awaitingApproval ? 'decide_handoff' : 'respond_to_handoff';
    const pair = awaitingApproval ? ([['approve', 'Approve'], ['reject', 'Reject']] as const) : ([['accept', 'Accept'], ['decline', 'Decline']] as const);
    const why = awaitingApproval
        ? `Only the care recipient or the coordinator can approve, and not the person who would take over. ${actor?.name ?? 'This person'} cannot.`
        : `Only ${h.proposed_recipient.name} can accept or decline. ${actor?.name ?? 'This person'} cannot.`;
    const whyId = `why-${h.id}`;
    const heading = awaitingApproval ? `Human approval, acting as ${actorText}` : `${h.proposed_recipient.name}'s response, acting as ${actorText}`;
    return el(
        'div',
        { className: 'controls' },
        el('p', { className: 'muted', textContent: heading }),
        ...pair.map(([action, label], i) => {
            const button = el('button', {
                type: 'button',
                textContent: label,
                className: i === 0 ? 'primary' : '',
                disabled: !mayAct,
                title: mayAct ? '' : why,
                dataset: { action },
                onclick: () => void act(host, data, tool, h.id, action, awaitingApproval ? 'decision' : 'response')
            });
            if (!mayAct) button.setAttribute('aria-describedby', whyId);
            return button;
        }),
        mayAct ? el('span') : el('p', { className: 'muted why', id: whyId, textContent: why })
    );
}

function setMessage(text: string, kind: 'ok' | 'err' | '') {
    const msg = byId('handoff-msg');
    msg.textContent = text;
    msg.className = kind;
}

async function act(host: HandoffHost, data: HandoffViewData, tool: string, handoffId: string, action: string, field: 'decision' | 'response'): Promise<void> {
    setMessage('Sending to the server...', '');
    const args: Record<string, unknown> = { household_id: data.householdId, handoff_id: handoffId, [field]: action, idempotency_key: `ui:${action}:${handoffId}` };
    if (data.simulation.enabled && actorId !== data.simulation.session_actor_id) args.simulated_actor_id = actorId;
    try {
        const res = await host.callTool(tool, args);
        const text = (res.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '{}';
        const body = JSON.parse(text) as { error?: { code: string; message: string }; handoff?: { status: string } };
        if (res.isError) setMessage(`✕ Server refused: ${body.error?.code} - ${body.error?.message}`, 'err');
        else setMessage(`✓ Saved by the server. Handoff is now ${BADGE[body.handoff?.status ?? ''] ?? body.handoff?.status} (${body.handoff?.status}).`, 'ok');
    } catch (err) {
        console.error('[kinsync-view] action failed', err);
        setMessage('✕ Could not reach the server.', 'err');
    }
    await host.reload();
}

function auditTable(h: HandoffData): HTMLElement {
    const rows = h.history.map(t =>
        el(
            'tr',
            {},
            el('td', { textContent: t.at }),
            el('td', {}, el('code', { textContent: t.event })),
            el('td', {}, el('code', { textContent: `${t.from ?? 'new'} → ${t.to}` })),
            el('td', { textContent: `${t.by.name}${t.simulated_by ? ` (SIMULATED by ${t.simulated_by.name})` : ''}${t.reason ? ` · "${t.reason}"` : ''}` })
        )
    );
    const head = el('tr', {}, ...['When (UTC)', 'Event', 'State change', 'By'].map(c => el('th', { scope: 'col', textContent: c })));
    return el(
        'details',
        { className: 'audit' },
        el('summary', { textContent: `Audit trail (${h.history.length})` }),
        el('div', { className: 'table-wrap' }, el('table', {}, el('thead', {}, head), el('tbody', {}, ...rows)))
    );
}
