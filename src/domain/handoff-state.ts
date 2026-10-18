/** Care-handoff state machine. The only place that says which status may follow which. */
import { DomainError } from './errors.js';

export const HANDOFF_STATUSES = ['PENDING_APPROVAL', 'PENDING_ACCEPTANCE', 'COMPLETED', 'REJECTED', 'DECLINED'] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const HANDOFF_EVENTS = ['propose', 'approve', 'reject', 'accept', 'decline'] as const;
export type HandoffEvent = (typeof HANDOFF_EVENTS)[number];

const TRANSITIONS: Readonly<Record<HandoffStatus, Partial<Record<HandoffEvent, HandoffStatus>>>> = {
    PENDING_APPROVAL: { approve: 'PENDING_ACCEPTANCE', reject: 'REJECTED' },
    PENDING_ACCEPTANCE: { accept: 'COMPLETED', decline: 'DECLINED' },
    COMPLETED: {},
    REJECTED: {},
    DECLINED: {}
};

export const OPEN_HANDOFF_STATUSES: readonly HandoffStatus[] = ['PENDING_APPROVAL', 'PENDING_ACCEPTANCE'];

/** Next status for an event, or throws INVALID_TRANSITION (terminal states accept nothing). */
export function nextStatus(from: HandoffStatus, event: HandoffEvent): HandoffStatus {
    const to = TRANSITIONS[from][event];
    if (!to) throw new DomainError('INVALID_TRANSITION', `Handoff is ${from}; ${event} is not allowed`, { from, event });
    return to;
}
