# Workflow Spec: "Medication report + appointment help" (Phase 2)

Implementation: `src/agent/scenario.ts` (deterministic planner), `scripts/run-scenario.ts` (evidence run), `test/workflow.test.ts`.

## 1. Trigger

The care recipient (Ravi, `mem_ravi`) says:

> "I took my morning medicines. Can you help me get a doctor's appointment for my knee?"

In Phase 2 there is no language understanding. The utterance is represented by a fixed `ScenarioInput` (`DEMO_SCENARIO`). A future LLM planner would fill exactly this slot, using the same tools, order, and keys.

## 2. Preconditions

- The MCP session is initialized at protocol `2025-11-25` with `X-CareLoop-Actor: mem_ravi`.
- The household is seeded, and a medication schedule `med_ravi_morning` exists (user-entered reference).

## 3. Steps (all are real MCP `tools/call`)

| # | Tool | Key arguments | Effect | Idempotency key |
|---|---|---|---|---|
| 1 | `record_care_event` | `kind=medication`, `medication_schedule_id=med_ravi_morning`, `note` = the person's words | Inserts a care event (verbatim) | `<runId>:medication-report` |
| 2 | `prepare_appointment_request` | `reason_as_reported` = the person's words, `preferred_window=this_week`, `provider_label`, `related_event_id` = step 1 | Inserts a `prepared` request. **Nothing booked.** | `<runId>:appointment-request` |
| 3 | `get_duty_contact` | household | Reads the rota for the household's local weekday, falling back to the coordinator | (read) |
| 4 | `draft_caregiver_notification` | `appointment_request_id`, `related_event_id`, `recipient_member_id` = step 3 | Inserts a templated draft plus a **pending approval**. **Nothing sent.** | `<runId>:notify-duty-contact` |
| 5 | `get_household_status` | household | Confirms the approval is listed as pending | (read) |

**Stop condition:** the planner returns `status: "awaiting_approval"` and does not proceed. Only a human decision continues the flow.

## 4. Approval (separate session, a human)

| Actor | Tool | Result |
|---|---|---|
| Priya (coordinator) or Ravi (care recipient) | `decide_approval` with `decision=approve` | Approval becomes `approved`, draft becomes `approved`, one `simulated_outbox` row with `delivery=simulated_not_sent`, appointment request becomes `handed_off`. `real_message_sent: false`. |
| Same | `decide_approval` with `decision=reject` and optional `reason` | Approval and draft become `rejected`, no outbox row, request stays `prepared`. A new draft (e.g. to another sibling) may be created. |
| Arjun (caregiver), Meera (viewer) | `decide_approval` | `FORBIDDEN` (role) |
| Wei (another household) | `decide_approval` | `FORBIDDEN` (household) |

## 5. State machine

```
care_event: (recorded)
appointment_request: prepared ──approve──> handed_off
notification_draft:  pending_approval ──approve──> approved
                                     └─reject──> rejected
approval:            pending ──approve|reject (once)──> approved|rejected
simulated_outbox:    (row created only on approve, at most one per draft)
```

## 6. Failure and retry semantics

| Situation | Behaviour |
|---|---|
| Same turn retried (same `runId`) | Every write returns `replayed: true` with the original ids; row counts are unchanged. |
| Planner retries with fresh keys | Natural-key dedupe returns the same event, request, and approval (`deduplicated: true`). |
| Same key, different arguments | `IDEMPOTENCY_CONFLICT`; nothing written. |
| Crash inside a write | The transaction rolls back: no partial rows, no stored key, and an `error` audit row. A retry with the same key succeeds once. |
| Server restart mid-workflow | State persists in SQLite. Replaying the turn after restart replays. Approval after restart works. |
| Second approval with a new key | `ALREADY_DECIDED`; still exactly one simulated send. |
| Invalid input | Tool error (`isError`); nothing stored. |

## 7. Safety behaviour inside the flow

- The draft body is a fixed template. It quotes the person's words with attribution and ends with "This is a coordination message, not medical advice." It is labelled "simulated, not sent".
- Status reports medication schedules as either "Report recorded today (n)" or "No report recorded yet today". It never says "missed".
- Appointment responses carry an emergency-services notice and `nothing_booked: true`.

## 8. Evidence

`pnpm scenario` writes `evidence/phase2/scenario-transcript.json`. It contains the full step transcript, the replay, cross-household and wrong-role attempts, approval, same-key replay, the second-approval refusal, final status, final row counts, the audit trail, and 17 checks.
