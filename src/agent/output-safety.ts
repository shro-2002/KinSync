/**
 * Output safety for the model's final reply. Rules are checked against the turn's trace,
 * so a claim is allowed only when a tool result confirms it. Violations either repair the
 * reply (missing approval notice) or replace it with a fact-based summary built from the trace.
 */
import { readEnvelope, type ModelToolMessage } from './adapter.js';
import type { TraceStep } from './trace.js';

export type SafetyRule = 'medical_advice' | 'diagnosis' | 'fabricated_side_effect' | 'unconfirmed_claim' | 'foreign_identifier' | 'missing_approval_notice' | 'empty';

export interface SafetyVerdict {
    action: 'passed' | 'repaired' | 'replaced';
    violations: Array<{ rule: SafetyRule; detail: string }>;
    text: string;
    originalText: string;
}

const NEGATION = /\b(not|n't|never|nothing|nobody|no( one)?|without|cannot|can't|won't|until)\b/i;
const DOSAGE_DIRECTIVE = /\b(take|taking|increase|decrease|double|halve|skip|stop|start|reduce|add)\b[^.!?]{0,50}\b(dose|doses|dosage|tablets?|pills?|medicines?|medications?|mg|ml|capsules?)\b/i;
const DOSE_AMOUNT = /\b\d+(\.\d+)?\s?(mg|mcg|ml|units?)\b/i;
const DIAGNOSIS = /\b(diagnos\w*|you (probably|likely|may|might) have|sounds like (you have|a|an)|it('s| is) (probably|likely) (a|an)?|symptoms? of (arthritis|infection|fracture|diabetes|stroke))\b/i;
// A factual statement about whether a report exists ("no one has reported taking...", "no
// report of the dose yet") is not a dosage directive or diagnosis, even though it shares
// words like "taking"/"medicines" with real advice. Only sentences that are both negated and
// about reporting are exempted, so an actual directive that happens to contain "not" is still caught.
const REPORT_STATUS = /\b(report|reports|reported|recorded|logged)\b/i;
// Also: nobody is ever reported as having arrived, travelled, or given care; KinSync cannot know that.
const SIDE_EFFECT =
    /\b(sent|booked|scheduled|purchased|bought|ordered|paid|notified|messaged|texted|emailed|called|confirmed (the|your) appointment|delivered|arrived|(is|are) on (the|his|her|their) way|en route|provided care|gave care|has taken over|took over|is now responsible)\b/i;
const CLAIMS: Array<{ re: RegExp; tools: string[] }> = [
    { re: /\b(recorded|logged|noted|saved)\b/i, tools: ['record_care_event'] },
    { re: /\b(prepared|set up)\b[^.!?]*\b(appointment|request)\b|\bappointment request\b/i, tools: ['prepare_appointment_request'] },
    { re: /\b(drafted|draft|wrote a message|written a message)\b/i, tools: ['draft_caregiver_notification'] },
    { re: /\b(handoff|hand-off|handed off|proposal)\b/i, tools: ['propose_handoff', 'get_handoffs'] }
];
// A human decision on a handoff may be reported only if a tool result in this turn shows that status.
const HANDOFF_DECISION =
    /\b(handoff|hand-off|responsibility|proposal)\b[^.!?]*\b(approved|accepted|declined|rejected|completed)\b|\b(approved|accepted|declined|rejected|completed)\b[^.!?]*\b(handoff|hand-off|responsibility|proposal)\b/i;
const DECISION_STATUSES: Record<string, string[]> = {
    approved: ['PENDING_ACCEPTANCE', 'COMPLETED'],
    accepted: ['COMPLETED'],
    completed: ['COMPLETED'],
    rejected: ['REJECTED'],
    declined: ['DECLINED']
};
const IDENTIFIER = /\b(hh|mem|evt|apt|ntf|apv|out|med)_[a-z0-9_]+\b/g;

const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).filter(s => s.trim());
const succeeded = (steps: readonly TraceStep[], tool: string) =>
    steps.some(s => s.tool === tool && s.decision === 'executed' && (s.outcome === 'ok' || s.outcome === 'replayed' || s.outcome === 'deduplicated'));

/** Handoff statuses present in this turn's tool results (propose_handoff / get_handoffs payloads). */
function handoffStatusesSeen(messages: readonly ModelToolMessage[]): Set<string> {
    const seen = new Set<string>();
    for (const m of messages) {
        const payload = readEnvelope(m).payload as { handoff?: { status?: string }; handoffs?: Array<{ status?: string }> };
        if (payload.handoff?.status) seen.add(payload.handoff.status);
        for (const h of payload.handoffs ?? []) if (h.status) seen.add(h.status);
    }
    return seen;
}

/** Every id seen in this turn's tool results or arguments; anything else in the reply is foreign. */
function knownIdentifiers(messages: readonly ModelToolMessage[], steps: readonly TraceStep[]): Set<string> {
    const blob = messages.map(m => m.content).join(' ') + JSON.stringify(steps.map(s => s.effective_args));
    return new Set(blob.match(IDENTIFIER) ?? []);
}

/** Plain, fact-only reply derived from confirmed tool results. Used when the model's reply is unsafe or absent. */
export function summarizeFromTrace(steps: readonly TraceStep[], messages: readonly ModelToolMessage[]): string {
    const out: string[] = [];
    if (succeeded(steps, 'record_care_event')) out.push("I've recorded what you told me.");
    if (succeeded(steps, 'prepare_appointment_request')) out.push("I've prepared an appointment request for the family. Nothing has been booked.");
    if (succeeded(steps, 'draft_caregiver_notification')) {
        const duty = messages.find(m => m.tool === 'get_duty_contact');
        const name = duty ? ((readEnvelope(duty).payload.contact as { name?: string } | undefined)?.name ?? 'a family member') : 'a family member';
        out.push(`I've drafted a message to ${name}. It is waiting for approval and has not been sent.`);
    }
    if (succeeded(steps, 'propose_handoff')) {
        const proposed = messages.find(m => m.tool === 'propose_handoff' && !('error' in readEnvelope(m).payload));
        const name = (readEnvelope(proposed!).payload.handoff as { proposed_recipient?: { name?: string } } | undefined)?.proposed_recipient?.name ?? 'another family member';
        out.push(`I've prepared a proposal for ${name} to take over this task. A person needs to approve it, and ${name} needs to accept it, before anything changes. Nothing has been sent or arranged.`);
    }
    const failed = steps.find(s => s.outcome === 'tool_error');
    if (failed) out.push(`One step did not go through (${failed.error_code}).`);
    if (!out.length) out.push("I wasn't able to complete that. Nothing was changed.");
    return out.join(' ');
}

export function checkFinalReply(text: string, steps: readonly TraceStep[], messages: readonly ModelToolMessage[]): SafetyVerdict {
    const violations: SafetyVerdict['violations'] = [];
    const trimmed = text.trim();
    if (!trimmed) violations.push({ rule: 'empty', detail: 'no reply text' });

    for (const s of sentences(trimmed)) {
        const isNegatedReportStatus = NEGATION.test(s) && REPORT_STATUS.test(s);
        if (!isNegatedReportStatus) {
            if (DOSAGE_DIRECTIVE.test(s) || DOSE_AMOUNT.test(s)) violations.push({ rule: 'medical_advice', detail: s });
            if (DIAGNOSIS.test(s)) violations.push({ rule: 'diagnosis', detail: s });
        }
        if (NEGATION.test(s)) continue; // "has not been sent" / "nothing has been booked" are the safe phrasings
        if (SIDE_EFFECT.test(s)) violations.push({ rule: 'fabricated_side_effect', detail: s });
        for (const c of CLAIMS) if (c.re.test(s) && !c.tools.some(t => succeeded(steps, t))) violations.push({ rule: 'unconfirmed_claim', detail: `${c.tools[0]}: ${s}` });
        if (HANDOFF_DECISION.test(s)) {
            const seen = handoffStatusesSeen(messages);
            const words = Object.keys(DECISION_STATUSES).filter(w => new RegExp(`\\b${w}\\b`, 'i').test(s));
            if (words.some(w => !DECISION_STATUSES[w]!.some(st => seen.has(st)))) violations.push({ rule: 'unconfirmed_claim', detail: `handoff decision: ${s}` });
        }
    }

    const known = knownIdentifiers(messages, steps);
    for (const id of trimmed.match(IDENTIFIER) ?? []) if (!known.has(id)) violations.push({ rule: 'foreign_identifier', detail: id });

    if (violations.length) return { action: 'replaced', violations, text: summarizeFromTrace(steps, messages), originalText: text };

    if ((succeeded(steps, 'draft_caregiver_notification') || succeeded(steps, 'propose_handoff')) && !/approv/i.test(trimmed)) {
        return {
            action: 'repaired',
            violations: [{ rule: 'missing_approval_notice', detail: 'draft created but reply does not mention approval' }],
            text: `${trimmed} The message is waiting for approval and has not been sent.`,
            originalText: text
        };
    }
    return { action: 'passed', violations: [], text: trimmed, originalText: text };
}
