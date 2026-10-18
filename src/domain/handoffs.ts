/**
 * KinSync care handoff: a proposed move of responsibility for a care task from the current duty contact
 * to another household member. propose (model-safe) -> approve|reject (human) -> accept|decline (the recipient).
 * Called inside CareService.mutate, so each function runs in one transaction with its idempotency record and audit row.
 */
import type { DatabaseSync } from 'node:sqlite';

import { PERMISSIONS } from './authz.js';
import { DomainError } from './errors.js';
import { nextStatus, type HandoffEvent, type HandoffStatus } from './handoff-state.js';
import type { DecideHandoffInput, ProposeHandoffInput, RespondToHandoffInput } from './inputs.js';
import type { Queries } from './queries.js';
import { dutyContact } from './status.js';
import type { Actor, Handoff, HandoffTransition, Member } from './types.js';

export const HANDOFF_NOTICE = 'KinSync records who agrees to take responsibility for a care task. It sends no messages, books nothing, and does not confirm that any care was given.';

export interface HandoffContext {
    db: DatabaseSync;
    q: Queries;
    now: Date;
    actor: Actor;
}

const eligibleRecipients = (q: Queries, householdId: string, fromMemberId: string): Member[] =>
    q.members(householdId).filter(m => PERMISSIONS.respond_to_handoff.includes(m.role) && m.id !== fromMemberId);

/** Human approvers: the decide_handoff roles, minus the proposed recipient (they cannot approve their own acceptance). */
const eligibleApprovers = (q: Queries, h: Handoff): Member[] =>
    q.members(h.householdId).filter(m => PERMISSIONS.decide_handoff.includes(m.role) && m.id !== h.toMemberId);

// ---------- writes ----------

export function applyPropose(ctx: HandoffContext, input: ProposeHandoffInput, handoffId: string) {
    const { q, actor } = ctx;
    const hh = input.household_id;
    const owner = dutyContact(q, ctx.now, hh).contact.member_id;

    let recipient: Member | undefined;
    let basis: Handoff['recipientBasis'] = 'named';
    if (input.proposed_recipient) {
        recipient = q.memberByRef(hh, input.proposed_recipient);
        if (!recipient) throw new DomainError('NOT_FOUND', `Household member ${input.proposed_recipient} not found`);
    } else {
        const eligible = eligibleRecipients(q, hh, owner);
        if (eligible.length !== 1) {
            throw new DomainError('INVALID_INPUT', 'proposed_recipient is required: it is not the only eligible member', {
                reason: 'recipient_required',
                eligible: eligible.map(m => ({ member_id: m.id, name: m.displayName }))
            });
        }
        recipient = eligible[0]!;
        basis = 'only_eligible_member';
    }
    if (!PERMISSIONS.respond_to_handoff.includes(recipient.role)) throw new DomainError('INVALID_INPUT', `${recipient.displayName} cannot take on care duties`, { reason: 'recipient_role' });
    if (recipient.id === owner) throw new DomainError('INVALID_INPUT', `${recipient.displayName} is already the duty contact`, { reason: 'recipient_is_current_owner' });
    if (recipient.id === actor.memberId) throw new DomainError('INVALID_INPUT', 'A handoff cannot be proposed to the person asking for help', { reason: 'recipient_is_requester' });

    // Natural-key dedupe: re-asking for the same handoff with a fresh key must not open a second one.
    const existing = q.openHandoffMatching(hh, recipient.id, input.task_description);
    if (existing) return { handoff: handoffView(q, existing), deduplicated: true, nothing_dispatched: true, notice: HANDOFF_NOTICE };

    const at = ctx.now.toISOString();
    ctx.db
        .prepare(
            "INSERT INTO handoffs (id, household_id, requested_by_member_id, from_member_id, to_member_id, task_as_reported, recipient_basis, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', 1, ?, ?)"
        )
        .run(handoffId, hh, actor.memberId, owner, recipient.id, input.task_description, basis, at, at);
    recordTransition(ctx, handoffId, hh, 'propose', null, 'PENDING_APPROVAL', undefined);
    return { handoff: handoffView(q, q.handoff(hh, handoffId)!), deduplicated: false, nothing_dispatched: true, notice: HANDOFF_NOTICE };
}

export function applyDecision(ctx: HandoffContext, input: DecideHandoffInput) {
    const h = requireHandoff(ctx, input.household_id, input.handoff_id);
    if (!eligibleApprovers(ctx.q, h).some(m => m.id === ctx.actor.memberId)) {
        throw new DomainError('FORBIDDEN', 'The proposed recipient cannot approve their own handoff', { reason: 'recipient_cannot_approve' });
    }
    return moved(ctx, h, input.decision, input.reason);
}

export function applyResponse(ctx: HandoffContext, input: RespondToHandoffInput) {
    const h = requireHandoff(ctx, input.household_id, input.handoff_id);
    if (h.toMemberId !== ctx.actor.memberId) {
        throw new DomainError('FORBIDDEN', 'Only the proposed recipient may accept or decline', { reason: 'not_proposed_recipient' });
    }
    return moved(ctx, h, input.response, input.reason);
}

function requireHandoff(ctx: HandoffContext, householdId: string, handoffId: string): Handoff {
    const h = ctx.q.handoff(householdId, handoffId);
    if (!h) throw new DomainError('NOT_FOUND', `Handoff ${handoffId} not found`);
    return h;
}

function moved(ctx: HandoffContext, h: Handoff, event: HandoffEvent, reason: string | undefined) {
    const to = nextStatus(h.status, event);
    // Compare-and-set on status and version: a concurrent writer on another connection loses cleanly.
    const res = ctx.db
        .prepare('UPDATE handoffs SET status = ?, version = version + 1, updated_at = ? WHERE household_id = ? AND id = ? AND status = ? AND version = ?')
        .run(to, ctx.now.toISOString(), h.householdId, h.id, h.status, h.version);
    if (Number(res.changes) !== 1) {
        throw new DomainError('INVALID_TRANSITION', 'Handoff changed while this request was being processed', { from: h.status, event, reason: 'concurrent_update' });
    }
    recordTransition(ctx, h.id, h.householdId, event, h.status, to, reason);
    return { handoff: handoffView(ctx.q, ctx.q.handoff(h.householdId, h.id)!), nothing_dispatched: true, notice: HANDOFF_NOTICE };
}

function recordTransition(ctx: HandoffContext, handoffId: string, householdId: string, event: HandoffEvent, from: HandoffStatus | null, to: HandoffStatus, reason: string | undefined): void {
    const { actor } = ctx;
    ctx.db
        .prepare(
            'INSERT INTO handoff_transitions (handoff_id, household_id, event, from_status, to_status, actor_member_id, actor_mode, simulated_by_member_id, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(handoffId, householdId, event, from, to, actor.memberId, actor.simulatedBy ? 'simulated' : 'session', actor.simulatedBy ?? null, reason ?? null, ctx.now.toISOString());
}

// ---------- reads ----------

export const handoffViews = (q: Queries, householdId: string, status?: HandoffStatus) => q.handoffs(householdId, status).map(h => handoffView(q, h));

export function handoffView(q: Queries, h: Handoff) {
    const who = (memberId: string) => ({ member_id: memberId, name: q.member(memberId)?.displayName ?? memberId });
    const history = q.handoffTransitions(h.householdId, h.id);
    const approval = history.find(t => t.event === 'approve' || t.event === 'reject');
    const response = history.find(t => t.event === 'accept' || t.event === 'decline');
    const step = (t: HandoffTransition | undefined) => (t ? { by: who(t.actorMemberId), at: t.at, actor_mode: t.actorMode, reason: t.reason } : { by: null, at: null, actor_mode: null, reason: null });
    return {
        id: h.id,
        status: h.status,
        status_text: statusText(h, who, approval),
        task_description: h.taskAsReported,
        requested_by: who(h.requestedByMemberId),
        current_owner: who(h.fromMemberId),
        proposed_recipient: who(h.toMemberId),
        recipient_basis: h.recipientBasis,
        approval: { state: approvalState(approval), ...step(approval) },
        acceptance: { state: acceptanceState(h.status), ...step(response) },
        // Who may act right now, computed by the same rules the server enforces; the dashboard only reads this.
        eligible: {
            approve_or_reject: h.status === 'PENDING_APPROVAL' ? eligibleApprovers(q, h).map(m => m.id) : [],
            accept_or_decline: h.status === 'PENDING_ACCEPTANCE' ? [h.toMemberId] : []
        },
        history: history.map(t => ({
            event: t.event,
            from: t.fromStatus,
            to: t.toStatus,
            by: who(t.actorMemberId),
            actor_mode: t.actorMode,
            simulated_by: t.simulatedByMemberId ? who(t.simulatedByMemberId) : null,
            reason: t.reason,
            at: t.at
        })),
        created_at: h.createdAt,
        updated_at: h.updatedAt
    };
}

function approvalState(approval: HandoffTransition | undefined): 'pending' | 'approved' | 'rejected' {
    if (!approval) return 'pending';
    return approval.event === 'approve' ? 'approved' : 'rejected';
}

function acceptanceState(status: HandoffStatus): 'not_requested' | 'pending' | 'accepted' | 'declined' {
    if (status === 'PENDING_ACCEPTANCE') return 'pending';
    if (status === 'COMPLETED') return 'accepted';
    if (status === 'DECLINED') return 'declined';
    return 'not_requested';
}

function statusText(h: Handoff, who: (id: string) => { name: string }, approval: HandoffTransition | undefined): string {
    const to = who(h.toMemberId).name;
    const approver = approval ? who(approval.actorMemberId).name : 'a human approver';
    switch (h.status) {
        case 'PENDING_APPROVAL':
            return `Proposed: ${to} would take over this task. Waiting for a human approver. Nothing has been sent or arranged.`;
        case 'PENDING_ACCEPTANCE':
            return `Approved by ${approver}. Waiting for ${to} to accept or decline; ${to} is not responsible until they accept.`;
        case 'COMPLETED':
            return `${to} accepted responsibility for this task. This records a family agreement only; it does not confirm any care was provided.`;
        case 'REJECTED':
            return `Rejected by ${approver}. Responsibility is unchanged.`;
        case 'DECLINED':
            return `${to} declined. Responsibility is unchanged.`;
    }
}
