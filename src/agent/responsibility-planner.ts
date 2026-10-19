/**
 * "Who's taking Dad to the clinic Thursday?" Deterministic (rule-based, NOT an LLM) read-only planner. It reads the
 * household roster and the persisted handoffs over MCP, then says who is responsible according to those records.
 * It calls read tools only, so it cannot change anything. When the records do not settle the question, it says so
 * instead of guessing: an assistant can carry the question, it cannot manufacture the answer.
 */
import { readEnvelope, type ModelToolMessage } from './adapter.js';
import { ZERO_USAGE, type ModelPlanner, type PlannerRequest, type PlannerResponse } from './model.js';

export const RESPONSIBILITY_QUESTION = "Who's taking Dad to the clinic Thursday?";

const WHO_INTENT = /\bwho('s|\s+is|\s+has|\s+will|\s+got)?\b/i;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const TASK_WORDS = ['clinic', 'doctor', 'appointment', 'checkup', 'hospital', 'pharmacy', 'dentist', 'physio'];
const RELATION_WORDS: Readonly<Record<string, string>> = { dad: 'father', father: 'father', papa: 'father', mom: 'mother', mum: 'mother', mother: 'mother', grandma: 'grandmother', grandpa: 'grandfather' };

type Member = { member_id: string; name: string; relationship: string; role: string };
type Person = { member_id: string; name: string };
export type HandoffRecord = {
    id: string;
    status: 'PENDING_APPROVAL' | 'PENDING_ACCEPTANCE' | 'COMPLETED' | 'REJECTED' | 'DECLINED';
    task_description: string;
    requested_by: Person;
    current_owner: Person;
    proposed_recipient: Person;
    approval: { by: Person | null };
    updated_at: string;
};

const say = (text: string): PlannerResponse => ({ text, toolCalls: [], stop: 'end_turn', usage: ZERO_USAGE, model: 'deterministic' });
const call = (id: number, name: string): PlannerResponse => ({ text: '', toolCalls: [{ id: `det_${id}`, name, arguments: {} }], stop: 'tool_use', usage: ZERO_USAGE, model: 'deterministic' });
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const hasWord = (text: string, word: string) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
const OPEN = new Set(['PENDING_APPROVAL', 'PENDING_ACCEPTANCE']);

export class DeterministicResponsibilityPlanner implements ModelPlanner {
    readonly name = 'deterministic/who-is-responsible/v1';
    readonly model = 'deterministic';

    async plan(req: PlannerRequest): Promise<PlannerResponse> {
        const question = req.messages.find(m => m.role === 'user')?.text.trim() ?? '';
        const toolMessages: ModelToolMessage[] = req.messages.flatMap(m => (m.role === 'tool_results' ? m.results.map(r => ({ role: 'tool' as const, tool: r.tool, content: r.content })) : []));
        const payload = (tool: string) => {
            const m = toolMessages.find(x => x.tool === tool);
            return m ? (readEnvelope(m).payload as Record<string, any>) : undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
        };

        if (!WHO_INTENT.test(question)) return say('I can tell you who is responsible for a care task, for example: "Who\'s taking Dad to the clinic Thursday?"');
        const status = payload('get_household_status');
        if (!status) return call(toolMessages.length + 1, 'get_household_status');
        const handoffs = payload('get_handoffs');
        if (!handoffs && !status.error) return call(toolMessages.length + 1, 'get_handoffs');
        if (status.error || handoffs?.error) return say("I couldn't read this household's records, so I can't say who is responsible. Nothing was changed.");
        return say(answerResponsibility(question, status.members as Member[], handoffs!.handoffs as HandoffRecord[]));
    }
}

/** Pure: the answer to a "who has it?" question, from the roster and handoff records the server returned. */
export function answerResponsibility(question: string, members: readonly Member[], handoffs: readonly HandoffRecord[]): string {
    const weekday = WEEKDAYS.find(d => hasWord(question, d));
    const tasks = TASK_WORDS.filter(w => hasWord(question, w));
    if (!weekday && tasks.length === 0) return 'Which task or day do you mean? I can only answer from what the family has recorded.';

    const relationWord = Object.keys(RELATION_WORDS).find(w => hasWord(question, w));
    const named = members.filter(m => hasWord(question, m.name));
    const byRelation = relationWord ? members.filter(m => m.relationship === RELATION_WORDS[relationWord]) : [];
    const people = [...new Map([...named, ...byRelation].map(m => [m.member_id, m])).values()];
    if (people.length > 1) return `Do you mean ${people.map(p => p.name).join(' or ')}? I can't tell who you're asking about.`;
    if (relationWord && people.length === 0) return `I can't tell who "${relationWord}" is in this household. Could you use their name?`;
    const person = people[0];

    const isAboutQuestion = (handoff: HandoffRecord) =>
        (!person || handoff.requested_by.member_id === person.member_id || hasWord(handoff.task_description, person.name)) &&
        (!weekday || hasWord(handoff.task_description, weekday)) &&
        tasks.every(task => hasWord(handoff.task_description, task));
    const matches = handoffs.filter(isAboutQuestion);
    const what = [person ? `${person.name}'s` : '', tasks.join(' ') || 'care task', weekday ? `on ${capitalize(weekday)}` : ''].filter(Boolean).join(' ');

    if (matches.length === 0) return `There is no handoff or agreement recorded for ${what}, so I can't say who is responsible. I won't guess.`;
    const open = matches.filter(h => OPEN.has(h.status));
    if (open.length > 1) return `More than one open handoff matches ${what} (to ${open.map(h => h.proposed_recipient.name).join(' and ')}), so I can't give one answer. Check the dashboard.`;
    // One open handoff wins; otherwise the most recently updated record is the current one.
    const current = open[0] ?? [...matches].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]!;
    return describe(current);
}

function describe(h: HandoffRecord): string {
    const owner = h.current_owner.name;
    const to = h.proposed_recipient.name;
    switch (h.status) {
        case 'PENDING_APPROVAL':
            return `${owner} is still responsible. ${h.requested_by.name} asked for ${to} to take over, but nobody has approved that yet.`;
        case 'PENDING_ACCEPTANCE':
            return `${owner} still has it. ${h.approval.by?.name ?? 'A family member'} approved asking ${to}, but ${to} hasn't said yes yet, so nothing has moved.`;
        case 'COMPLETED':
            return `${to} accepted the handoff. ${to} is now listed as responsible for it. That is a family agreement, not proof the visit happened.`;
        case 'REJECTED':
            return `The handoff didn't go through: ${h.approval.by?.name ?? 'the approver'} said no. ${owner} remains responsible.`;
        case 'DECLINED':
            return `The handoff didn't go through: ${to} said no. ${owner} remains responsible.`;
    }
}
