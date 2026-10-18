import { DomainError } from './errors.js';
import { ROLES, type Actor, type Role } from './types.js';

export type Operation =
    | 'record_care_event'
    | 'get_household_status'
    | 'show_care_dashboard'
    | 'get_duty_contact'
    | 'prepare_appointment_request'
    | 'draft_caregiver_notification'
    | 'decide_approval'
    | 'propose_handoff'
    | 'get_handoffs'
    | 'decide_handoff'
    | 'respond_to_handoff';

const WRITERS: readonly Role[] = ['care_recipient', 'coordinator', 'caregiver'];

/** Role policy. Viewers read only. Approvals: the person being cared for, or the coordinator. */
export const PERMISSIONS: Readonly<Record<Operation, readonly Role[]>> = {
    record_care_event: WRITERS,
    get_household_status: ROLES,
    show_care_dashboard: ROLES,
    get_duty_contact: ROLES,
    prepare_appointment_request: WRITERS,
    draft_caregiver_notification: WRITERS,
    decide_approval: ['care_recipient', 'coordinator'],
    propose_handoff: WRITERS,
    get_handoffs: ROLES,
    // Handoffs: approval is the same human authority as decide_approval; only a coordinator or caregiver can take on duty.
    // Role is the coarse gate; the exact rules (approver is not the recipient, only the named recipient accepts) live in handoffs.ts.
    decide_handoff: ['care_recipient', 'coordinator'],
    respond_to_handoff: ['coordinator', 'caregiver']
};

/** Throws FORBIDDEN unless the actor belongs to the household and holds a permitted role. */
export function authorize(actor: Actor, householdId: string, op: Operation): void {
    if (actor.householdId !== householdId) {
        throw new DomainError('FORBIDDEN', `Actor is not a member of household ${householdId}`, { reason: 'household' });
    }
    if (!PERMISSIONS[op].includes(actor.role)) {
        throw new DomainError('FORBIDDEN', `Role ${actor.role} may not ${op}`, { reason: 'role', role: actor.role });
    }
}
