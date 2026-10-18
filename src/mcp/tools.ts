/**
 * MCP tool surface for the CareLoop domain. Tools are thin: the session's synthetic actor
 * plus the raw arguments go to CareService, which validates, authorizes and audits.
 * Domain errors become tool errors (isError) with a stable machine-readable code.
 */
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';

import { DomainError } from '../domain/errors.js';
import * as inputs from '../domain/inputs.js';
import { domainValidated } from './schema.js';
import type { CareService } from '../domain/service.js';
import type { Operation } from '../domain/authz.js';
import type { Actor } from '../domain/types.js';

/** Resolves the session's synthetic actor for an operation; failures are audited by the service. */
export type ActorResolver = (op: Operation, args: unknown) => Actor;

/** Server-decided facts about this MCP session (never taken from tool arguments). */
export interface SessionInfo {
    /** True only on a demo server whose session has no actor header: the labeled simulated-actor switcher may be used. */
    simulatedActors: boolean;
}

export function toolResult(run: () => object): CallToolResult {
    try {
        const data = run() as Record<string, unknown>;
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        const error = { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] };
    }
}

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const READ = { readOnlyHint: true, openWorldHint: false } as const;

export function registerDomainTools(server: McpServer, service: CareService, actor: ActorResolver): void {
    server.registerTool(
        'record_care_event',
        {
            title: 'Record care event',
            description:
                'Record something a household member reports (e.g. "I took my morning medicines", a meal, a symptom in their own words). ' +
                'Stores the words verbatim; does not interpret or give advice. Retry with the same idempotency_key.',
            inputSchema: domainValidated(inputs.recordCareEventInput),
            annotations: WRITE
        },
        args => toolResult(() => service.recordCareEvent(actor('record_care_event', args), args))
    );

    server.registerTool(
        'get_household_status',
        {
            title: 'Get household status',
            description:
                "Current household picture: members, today's duty contact, medication schedule reference with today's reports, recent events, " +
                'open appointment requests and pending approvals. A schedule with no report says "No report recorded yet today" - that is not evidence of a missed dose.',
            inputSchema: domainValidated(inputs.householdOnlyInput),
            annotations: READ
        },
        args => toolResult(() => service.getHouseholdStatus(actor('get_household_status', args), args))
    );

    server.registerTool(
        'prepare_appointment_request',
        {
            title: 'Prepare appointment request',
            description:
                "Prepare (not book) a request for a family member to arrange a doctor's appointment, using the person's own words for the reason. " +
                'Nothing is booked or sent. Retry with the same idempotency_key.',
            inputSchema: domainValidated(inputs.prepareAppointmentRequestInput),
            annotations: WRITE
        },
        args => toolResult(() => service.prepareAppointmentRequest(actor('prepare_appointment_request', args), args))
    );

    server.registerTool(
        'get_duty_contact',
        {
            title: 'Get duty contact',
            description: 'Which family member is on duty for a date (from the family rota; falls back to the coordinator).',
            inputSchema: domainValidated(inputs.dutyContactInput),
            annotations: READ
        },
        args => toolResult(() => service.getDutyContact(actor('get_duty_contact', args), args))
    );

    server.registerTool(
        'draft_caregiver_notification',
        {
            title: 'Draft caregiver notification',
            description:
                'Draft a message to a family member (default: today\'s duty contact) about an appointment request and/or a reported event. ' +
                'Creates a pending approval; nothing is sent until decide_approval approves it, and even then delivery is simulated.',
            inputSchema: domainValidated(inputs.draftNotificationInput),
            annotations: WRITE
        },
        args => toolResult(() => service.draftCaregiverNotification(actor('draft_caregiver_notification', args), args))
    );

    server.registerTool(
        'propose_handoff',
        {
            title: 'Propose care handoff',
            description:
                'Propose that another household member (a coordinator or caregiver, not the current duty contact) take over responsibility for a care task the person described. ' +
                'Creates a proposal in PENDING_APPROVAL; nothing is sent or arranged, and it takes effect only after a human approves it and the recipient accepts. Retry with the same idempotency_key.',
            inputSchema: domainValidated(inputs.proposeHandoffInput),
            annotations: WRITE
        },
        args => toolResult(() => service.proposeHandoff(actor('propose_handoff', args), args))
    );

    server.registerTool(
        'get_handoffs',
        {
            title: 'Get care handoffs',
            description: 'List care handoff proposals for the household with their status, who approved, who accepted, and the timestamped history (read-only).',
            inputSchema: domainValidated(inputs.getHandoffsInput),
            annotations: READ
        },
        args => toolResult(() => service.getHandoffs(actor('get_handoffs', args), args))
    );

    server.registerTool(
        'decide_handoff',
        {
            title: 'Approve or reject care handoff',
            description:
                'HUMAN ONLY (not available to the AI model). Approve or reject a proposed care handoff. Only the care recipient or the coordinator may decide, and never the proposed recipient. ' +
                'Approval moves it to PENDING_ACCEPTANCE; it is not complete until the recipient accepts. simulated_actor_id is for the labeled demo mode only.',
            inputSchema: domainValidated(inputs.decideHandoffToolInput),
            annotations: WRITE
        },
        args => toolResult(() => service.decideHandoff(actor('decide_handoff', args), args))
    );

    server.registerTool(
        'respond_to_handoff',
        {
            title: 'Accept or decline care handoff',
            description:
                'HUMAN ONLY (not available to the AI model). The proposed recipient, and only they, accepts or declines responsibility after a human has approved the handoff. ' +
                'Acceptance completes the handoff as a record of agreement; it does not confirm that any care was given. simulated_actor_id is for the labeled demo mode only.',
            inputSchema: domainValidated(inputs.respondToHandoffToolInput),
            annotations: WRITE
        },
        args => toolResult(() => service.respondToHandoff(actor('respond_to_handoff', args), args))
    );

    server.registerTool(
        'decide_approval',
        {
            title: 'Approve or reject proposed action',
            description:
                'Approve or reject a pending proposed action (currently: sending a drafted notification). Only the care recipient or the coordinator may decide. ' +
                'Approval queues a simulated send; no real message is delivered.',
            inputSchema: domainValidated(inputs.decideApprovalInput),
            annotations: WRITE
        },
        args => toolResult(() => service.decideApproval(actor('decide_approval', args), args))
    );
}
