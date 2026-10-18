/** Phase 2 workflow over real MCP (Streamable HTTP, 2025-11-25): sessions carry synthetic actors via X-CareLoop-Actor. */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import { DEMO_SCENARIO, runMedicationAppointmentScenario } from '../src/agent/scenario.js';
import { connect } from '../src/client.js';
import { SPEC_VERSION, startHarness, type Harness } from './helpers.js';

let harness: Harness | undefined;
const clients: Client[] = [];
afterEach(async () => {
    await Promise.all(clients.splice(0).map(c => c.close()));
    await harness?.stop();
    harness = undefined;
});

async function session(actor?: string) {
    const c = await connect(harness!.url, actor ? { actor } : {});
    clients.push(c.client);
    return c.client;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
    const res = await client.callTool({ name, arguments: args });
    const data = res.structuredContent ?? JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    return { isError: res.isError === true, data };
}

const count = (table: string) => (harness!.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const allCounts = () =>
    ['care_events', 'appointment_requests', 'notification_drafts', 'approvals', 'simulated_outbox', 'idempotency_keys'].map(count);

describe('workflow over MCP', () => {
    it('happy path: scenario stops at the approval boundary; coordinator approval queues exactly one simulated send', async () => {
        harness = await startHarness();
        const ravi = await session('mem_ravi');
        const outcome = await runMedicationAppointmentScenario(ravi, DEMO_SCENARIO);

        expect(ravi.getNegotiatedProtocolVersion()).toBe(SPEC_VERSION);
        expect(outcome.status).toBe('awaiting_approval');
        expect(outcome.steps.map(s => s.tool)).toEqual([
            'record_care_event',
            'prepare_appointment_request',
            'get_duty_contact',
            'draft_caregiver_notification',
            'get_household_status'
        ]);
        expect(outcome.steps.every(s => !s.isError)).toBe(true);
        expect(outcome.dutyContact).toBe('Priya');
        expect(count('simulated_outbox')).toBe(0);

        const priya = await session('mem_priya');
        const decided = await call(priya, 'decide_approval', { household_id: 'hh_rao', idempotency_key: 'wf-approve-01', approval_id: outcome.approvalId, decision: 'approve' });
        expect(decided.isError).toBe(false);
        expect(decided.data.outbox.delivery).toBe('simulated_not_sent');
        expect(count('simulated_outbox')).toBe(1);
    });

    it('duplicate calls: re-running the same turn replays every write and adds no rows', async () => {
        harness = await startHarness();
        const ravi = await session('mem_ravi');
        const first = await runMedicationAppointmentScenario(ravi, DEMO_SCENARIO);
        const before = allCounts();
        const again = await runMedicationAppointmentScenario(ravi, DEMO_SCENARIO);

        expect(again.replayed).toEqual([true, true, true]);
        expect(again.approvalId).toBe(first.approvalId);
        expect(allCounts()).toEqual(before);
    });

    it('duplicate calls with fresh keys: no duplicate request or notification; the repeated event is stored and flagged', async () => {
        harness = await startHarness();
        const ravi = await session('mem_ravi');
        const first = await runMedicationAppointmentScenario(ravi, DEMO_SCENARIO);
        const second = await runMedicationAppointmentScenario(ravi, { ...DEMO_SCENARIO, runId: 'demo-turn-0002-retry' });

        expect(second.replayed).toEqual([false, false, false]);
        expect(second.eventId).not.toBe(first.eventId);
        expect((second.steps[0]!.result as { possible_duplicate_of: string }).possible_duplicate_of).toBe(first.eventId);
        expect([second.appointmentRequestId, second.approvalId]).toEqual([first.appointmentRequestId, first.approvalId]);
        expect([count('care_events'), count('appointment_requests'), count('notification_drafts'), count('approvals')]).toEqual([2, 1, 1, 1]);
    });

    it('invalid input over MCP is a tool error and stores nothing', async () => {
        harness = await startHarness();
        const ravi = await session('mem_ravi');
        const res = await ravi.callTool({ name: 'record_care_event', arguments: { household_id: 'hh_rao', idempotency_key: 'wf-bad-00001', kind: 'dosage_change', note: 'x' } });
        expect(res.isError).toBe(true);
        expect(count('care_events')).toBe(0);
    });

    it('cross-household access is denied over MCP', async () => {
        harness = await startHarness();
        const wei = await session('mem_wei');
        const status = await call(wei, 'get_household_status', { household_id: 'hh_rao' });
        const write = await call(wei, 'record_care_event', { household_id: 'hh_rao', idempotency_key: 'wf-xh-00001', kind: 'note', note: 'hello' });
        const dash = await call(wei, 'show_care_dashboard', { household_id: 'hh_rao' });
        expect([status.data.error.code, write.data.error.code, dash.data.error.code]).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN']);
        expect(count('care_events')).toBe(0);
    });

    it('the actor cannot be chosen through tool arguments (impersonation attempt is ignored)', async () => {
        harness = await startHarness();
        const meera = await session('mem_meera'); // viewer
        const res = await call(meera, 'record_care_event', {
            household_id: 'hh_rao',
            idempotency_key: 'wf-imp-00001',
            kind: 'note',
            note: 'pretending to be Priya',
            actor_id: 'mem_priya',
            reported_by_member_id: 'mem_priya'
        });
        expect(res.data.error.code).toBe('FORBIDDEN');
        expect(count('care_events')).toBe(0);
    });

    it('sessions without an actor or with an unknown actor are refused', async () => {
        harness = await startHarness();
        const anon = await call(await session(), 'get_household_status', { household_id: 'hh_rao' });
        const ghost = await call(await session('mem_ghost'), 'get_household_status', { household_id: 'hh_rao' });
        expect([anon.data.error.code, ghost.data.error.code]).toEqual(['UNAUTHENTICATED_SESSION', 'UNKNOWN_ACTOR']);
    });

    it('rejected approval over MCP: nothing sent, request remains open', async () => {
        harness = await startHarness();
        const outcome = await runMedicationAppointmentScenario(await session('mem_ravi'), DEMO_SCENARIO);
        const priya = await session('mem_priya');
        const rejected = await call(priya, 'decide_approval', {
            household_id: 'hh_rao',
            idempotency_key: 'wf-reject-001',
            approval_id: outcome.approvalId,
            decision: 'reject',
            reason: 'Will call him directly'
        });
        const status = await call(priya, 'get_household_status', { household_id: 'hh_rao' });

        expect(rejected.data.approval.status).toBe('rejected');
        expect(rejected.data.outbox).toBeNull();
        expect(count('simulated_outbox')).toBe(0);
        expect(status.data.pending_approvals).toHaveLength(0);
        expect(status.data.open_appointment_requests.map((a: { id: string }) => a.id)).toEqual([outcome.appointmentRequestId]);
    });

    it('state persists across a server restart in the middle of the workflow', async () => {
        harness = await startHarness();
        const outcome = await runMedicationAppointmentScenario(await session('mem_ravi'), DEMO_SCENARIO);
        await Promise.all(clients.splice(0).map(c => c.close()));
        const { dbPath } = harness;
        await harness.stop();

        harness = await startHarness(dbPath);
        const replay = await runMedicationAppointmentScenario(await session('mem_ravi'), DEMO_SCENARIO);
        expect(replay.replayed).toEqual([true, true, true]);
        const decided = await call(await session('mem_priya'), 'decide_approval', {
            household_id: 'hh_rao',
            idempotency_key: 'wf-restart-ap1',
            approval_id: outcome.approvalId,
            decision: 'approve'
        });
        expect(decided.data.approval.status).toBe('approved');
        expect(count('simulated_outbox')).toBe(1);
    });

    it('a failed write over MCP rolls back and the same key succeeds on retry', async () => {
        let failNext = true;
        harness = await startHarness(undefined, [], {
            faultInjector: point => {
                if (failNext && point === 'before_commit:record_care_event') {
                    failNext = false;
                    throw new Error('simulated crash');
                }
            }
        });
        const ravi = await session('mem_ravi');
        const args = { household_id: 'hh_rao', idempotency_key: 'wf-fault-0001', kind: 'meal', note: 'synthetic lunch' };
        const failed = await ravi.callTool({ name: 'record_care_event', arguments: args });
        expect(failed.isError).toBe(true);
        expect(count('care_events')).toBe(0);

        const ok = await call(ravi, 'record_care_event', args);
        expect([ok.isError, ok.data.replayed]).toEqual([false, false]);
        expect(count('care_events')).toBe(1);
    });
});

describe('MCP Apps dashboard with domain state', () => {
    it('is read-only and shows duty contact, medication reference and pending approvals', async () => {
        harness = await startHarness();
        const outcome = await runMedicationAppointmentScenario(await session('mem_ravi'), DEMO_SCENARIO);
        const priya = await session('mem_priya');
        const before = allCounts();
        const dash = await call(priya, 'show_care_dashboard', {});
        await call(priya, 'show_care_dashboard', { household_id: 'hh_rao' });

        expect(allCounts()).toEqual(before);
        expect(dash.isError).toBe(false);
        expect(dash.data.householdId).toBe('hh_rao');
        expect(dash.data.duty_contact.name).toBe('Priya');
        expect(dash.data.pending_approvals.map((a: { approval_id: string }) => a.approval_id)).toEqual([outcome.approvalId]);
        expect(dash.data.medication_reference.map((m: { status_text: string }) => m.status_text)).toEqual(['Report recorded today (1)', 'No report recorded yet today']);
        expect(dash.data.events[0].note).toBe(DEMO_SCENARIO.medicationNote);
    });

    it('tool annotations describe write tools as idempotent and read tools as read-only', async () => {
        harness = await startHarness();
        const { tools } = await (await session('mem_ravi')).listTools();
        const byName = Object.fromEntries(tools.map(t => [t.name, t.annotations]));
        for (const name of ['record_care_event', 'prepare_appointment_request', 'draft_caregiver_notification', 'decide_approval']) {
            expect(byName[name]).toMatchObject({ readOnlyHint: false, idempotentHint: true });
        }
        for (const name of ['get_household_status', 'get_duty_contact', 'show_care_dashboard']) expect(byName[name]?.readOnlyHint).toBe(true);
    });
});
