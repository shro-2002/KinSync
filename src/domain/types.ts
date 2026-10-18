import type { HandoffEvent, HandoffStatus } from './handoff-state.js';

export const ROLES = ['care_recipient', 'coordinator', 'caregiver', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const EVENT_KINDS = ['medication', 'meal', 'symptom', 'mood', 'appointment', 'note'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const APPOINTMENT_WINDOWS = ['asap_non_urgent', 'this_week', 'next_week'] as const;
export type AppointmentWindow = (typeof APPOINTMENT_WINDOWS)[number];

export const APPROVAL_DECISIONS = ['approve', 'reject'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** Who is acting. Resolved from the session's synthetic identity; never from tool arguments. */
export interface Actor {
    memberId: string;
    householdId: string;
    role: Role;
    displayName: string;
    /** Set only for a demo "simulated actor": the session identity that is acting as someone else. Never set from a model. */
    simulatedBy?: string;
}

export interface Member {
    id: string;
    householdId: string;
    displayName: string;
    relationship: string;
    role: Role;
    contactLabel: string;
}

export interface CareEvent {
    id: string;
    householdId: string;
    subjectMemberId: string;
    reportedByMemberId: string;
    kind: EventKind;
    note: string;
    medicationScheduleId: string | null;
    occurredAt: string;
    recordedAt: string;
}

export interface AppointmentRequest {
    id: string;
    householdId: string;
    subjectMemberId: string;
    requestedByMemberId: string;
    reasonAsReported: string;
    preferredWindow: AppointmentWindow;
    providerLabel: string | null;
    relatedEventId: string | null;
    status: 'prepared' | 'handed_off';
    createdAt: string;
}

export interface NotificationDraft {
    id: string;
    householdId: string;
    recipientMemberId: string;
    draftedByMemberId: string;
    appointmentRequestId: string | null;
    relatedEventId: string | null;
    channel: 'simulated';
    body: string;
    status: 'pending_approval' | 'approved' | 'rejected';
    createdAt: string;
}

export interface Approval {
    id: string;
    householdId: string;
    actionType: 'send_notification';
    targetId: string;
    requestedByMemberId: string;
    status: 'pending' | 'approved' | 'rejected';
    decidedByMemberId: string | null;
    decisionReason: string | null;
    createdAt: string;
    decidedAt: string | null;
}

export interface Handoff {
    id: string;
    householdId: string;
    requestedByMemberId: string;
    fromMemberId: string;
    toMemberId: string;
    taskAsReported: string;
    recipientBasis: 'named' | 'only_eligible_member';
    status: HandoffStatus;
    version: number;
    createdAt: string;
    updatedAt: string;
}

export interface HandoffTransition {
    id: number;
    handoffId: string;
    event: HandoffEvent;
    fromStatus: HandoffStatus | null;
    toStatus: HandoffStatus;
    actorMemberId: string;
    actorMode: 'session' | 'simulated';
    simulatedByMemberId: string | null;
    reason: string | null;
    at: string;
}
