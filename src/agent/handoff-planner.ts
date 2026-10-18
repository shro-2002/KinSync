/**
 * Deterministic (rule-based, NOT an LLM) planner for the KinSync care-handoff request. It proposes tool calls through the
 * same AgentAdapter path a model uses, so every policy applies. It can only propose: approval and acceptance are human
 * tools it has no way to call. When it cannot tell what is being asked, it asks instead of acting.
 */
import { readEnvelope, type ModelToolMessage } from './adapter.js';
import { ZERO_USAGE, type ModelPlanner, type PlannerRequest, type PlannerResponse } from './model.js';
import { summarizeFromTrace } from './output-safety.js';
import { stepsFromMessages } from './planner.js';

export const HANDOFF_UTTERANCE = 'I need help getting to my clinic visit on Thursday. Can Arjun take over from Priya?';

const MAX_TASK_CHARS = 300;
const HANDOFF_INTENT = /\b(need(s)?\s+(some\s+)?help|can'?t|cannot|unable to|won'?t be able|take over|cover for|cover (it|that|this)|hand\s?off|someone (else )?(to )?(help|take|cover))\b/i;
const RECIPIENT_ROLES = ['coordinator', 'caregiver'];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const say = (text: string): PlannerResponse => ({ text, toolCalls: [], stop: 'end_turn', usage: ZERO_USAGE, model: 'deterministic' });
const call = (id: number, name: string, args: Json): PlannerResponse => ({ text: '', toolCalls: [{ id: `det_${id}`, name, arguments: args }], stop: 'tool_use', usage: ZERO_USAGE, model: 'deterministic' });

export class DeterministicHandoffPlanner implements ModelPlanner {
    readonly name = 'deterministic/care-handoff/v1';
    readonly model = 'deterministic';

    async plan(req: PlannerRequest): Promise<PlannerResponse> {
        const utterance = req.messages.find(m => m.role === 'user')?.text.trim() ?? '';
        const toolMessages: ModelToolMessage[] = req.messages.flatMap(m => (m.role === 'tool_results' ? m.results.map(r => ({ role: 'tool' as const, tool: r.tool, content: r.content })) : []));
        const payload = (tool: string) => {
            const m = toolMessages.find(x => x.tool === tool);
            return m ? (readEnvelope(m).payload as Json) : undefined;
        };

        if (payload('propose_handoff')) return say(summarizeFromTrace(stepsFromMessages(toolMessages), toolMessages));
        if (!HANDOFF_INTENT.test(utterance)) {
            return say('I can hand a care task to another family member for approval. Tell me what you need help with, and who should take over if you know.');
        }
        if (utterance.length > MAX_TASK_CHARS) return say(`Could you say that in a shorter sentence, under ${MAX_TASK_CHARS} characters?`);

        const status = payload('get_household_status');
        if (!status) return call(toolMessages.length + 1, 'get_household_status', {});
        if (status.error) return say(summarizeFromTrace(stepsFromMessages(toolMessages), toolMessages));

        const members = (status.members ?? []) as Array<{ member_id: string; name: string; role: string }>;
        const dutyId = status.duty_contact?.member_id as string | undefined;
        const candidates = members.filter(m => RECIPIENT_ROLES.includes(m.role) && m.member_id !== dutyId);
        const named = candidates.filter(m => new RegExp(`\\b${m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(utterance));

        if (named.length === 1) return call(toolMessages.length + 1, 'propose_handoff', { task_description: utterance, proposed_recipient: named[0]!.member_id });
        // Nobody named and exactly one possible recipient: let the server pick (and label it "only eligible member").
        if (named.length === 0 && candidates.length === 1) return call(toolMessages.length + 1, 'propose_handoff', { task_description: utterance });
        if (candidates.length === 0) return say('There is nobody else in the household who can take this on, so I have not changed anything.');
        return say(`Who should take over: ${candidates.map(m => m.name).join(' or ')}? I have not changed anything yet.`);
    }
}
