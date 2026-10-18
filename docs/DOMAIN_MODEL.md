# CareLoop Domain Model (Phase 2)

Source of truth: `src/domain/migrations.ts` (schema), `src/domain/types.ts`, `src/domain/authz.ts`, `src/domain/seed.ts`.
Storage is SQLite (`node:sqlite`) with `PRAGMA foreign_keys = ON` and WAL mode. All data is synthetic.

## 1. Entities

| Entity | Table | Purpose | Key fields | Notes |
|---|---|---|---|---|
| Household | `households` | Unit of tenancy and authorization | `id`, `name`, `timezone` | Every other row carries `household_id`. The time zone drives "today" and duty weekdays. |
| Family member and role | `members` | People in a household | `id`, `household_id`, `display_name`, `relationship`, `role`, `contact_label` | `role` ∈ `care_recipient`, `coordinator`, `caregiver`, `viewer`. A member belongs to exactly one household. `contact_label` is descriptive only; nothing is ever delivered. |
| User-reported care event | `care_events` | What someone reported, in their own words | `kind`, `note` (verbatim), `subject_member_id`, `reported_by_member_id`, `medication_schedule_id?`, `occurred_at`, `recorded_at` | `kind` ∈ `medication`, `meal`, `symptom`, `mood`, `appointment`, `note`. The subject must be a care recipient. The note is never interpreted. |
| Medication schedule (reference) | `medication_schedules` | What the family typed in: a label and times of day | `label`, `times_of_day` (JSON `["08:00"]`), `member_id`, `entered_by_member_id` | **There is deliberately no dose, strength, or drug field** (tested). Used only to group reports; never to recommend. |
| Appointment request | `appointment_requests` | A prepared, *not booked*, request for family help | `reason_as_reported`, `preferred_window`, `provider_label?`, `related_event_id?`, `status` | `status` ∈ `prepared` → `handed_off` (after an approved notification). Nothing is booked. |
| Duty assignment | `duty_assignments` | Rota: who is on duty per weekday | `member_id`, `weekday` (0=Sun … 6=Sat) | `UNIQUE(household_id, weekday)`. If a weekday has no entry, the coordinator is the fallback. |
| Notification draft | `notification_drafts` | Templated message to a family member | `recipient_member_id`, `appointment_request_id?`, `related_event_id?`, `body`, `channel`, `status` | `channel` is always `simulated` (CHECK). `status` ∈ `pending_approval`, `approved`, `rejected`. |
| Approval record | `approvals` | Human decision gate for a proposed action | `action_type` (`send_notification`), `target_id` (UNIQUE), `status`, `decided_by_member_id`, `decision_reason`, `decided_at` | One approval per draft. `pending` → `approved` or `rejected`, decided once. |
| Simulated outbox | `simulated_outbox` | What *would* have been sent | `notification_id` (UNIQUE), `delivery` | `delivery` is always `simulated_not_sent` (CHECK). The UNIQUE constraint makes a double send impossible at the storage layer. |
| Idempotency record | `idempotency_keys` | Exactly-once semantics for writes | PK `(actor_member_id, tool, key)`, `request_hash`, `response_json` | Written in the same transaction as the change it protects. |
| Audit event | `audit_events` | Append-only trail of every attempt | `at`, `actor_member_id`, `household_id`, `action`, `target_id`, `outcome`, `detail` | `outcome` ∈ `ok`, `replayed`, `deduplicated`, `denied`, `invalid`, `conflict`, `error`. Denials and failures are recorded outside the rolled-back transaction. |

```
households 1─* members 1─* medication_schedules
     │            │
     │            ├─* care_events (subject / reporter)
     │            └─* duty_assignments (one per weekday)
     ├─* appointment_requests ──(related_event)──> care_events
     ├─* notification_drafts ──> appointment_requests / care_events
     │        └─1 approvals ──(on approve)──> simulated_outbox (≤1 per draft)
     ├─* idempotency_keys
     └─* audit_events
```

## 2. Identity and authorization

- **Actor** = a `members.id`, bound to the MCP *session* at `initialize` from the `X-CareLoop-Actor` HTTP header (`src/server.ts`). Tool arguments can never select the actor; a test sends `actor_id`/`reported_by_member_id` arguments and they are ignored.
- **This is synthetic identity, not authentication.** Any local client can send any header. Production would replace it with OAuth bearer tokens (spec 2025-11-25 authorization), mapping the token subject to a member.
- `CARELOOP_DEFAULT_ACTOR` exists only so browser MCP Apps hosts, which cannot set custom headers, can demo locally.
- Authorization runs in the domain layer (`authorize()` in `src/domain/authz.ts`) on every operation. It is not done in MCP code.

| Operation | care_recipient | coordinator | caregiver | viewer |
|---|---|---|---|---|
| `record_care_event` | ✅ | ✅ | ✅ | ❌ |
| `get_household_status`, `get_duty_contact`, `show_care_dashboard` | ✅ | ✅ | ✅ | ✅ |
| `prepare_appointment_request` | ✅ | ✅ | ✅ | ❌ |
| `draft_caregiver_notification` | ✅ | ✅ | ✅ | ❌ |
| `decide_approval` | ✅ (the person being cared for) | ✅ | ❌ | ❌ |

- **Household isolation:** the actor's household must equal the requested `household_id`, or the result is `FORBIDDEN`. Every lookup is also filtered by `household_id`, so ids from another household resolve to `NOT_FOUND` and existence never leaks.

## 3. Idempotency and duplicate suppression

1. **Key-based (all four write tools):** `idempotency_key` is required: 8–128 characters from `[A-Za-z0-9._:-]`. The key is scoped to (actor, tool).
   - Same key and same input (hash of a canonical JSON of the arguments, excluding the key): returns the stored response with `replayed: true`, and nothing is written.
   - Same key with different input: `IDEMPOTENCY_CONFLICT`.
2. **Deterministic ids:** `prefix_ + sha256(actor|tool|key)[0:12]` (`evt_`, `apt_`, `ntf_`, `apv_`, `out_`).
3. **Natural-key dedupe (fresh-key retries):**
   - Appointment requests: an open request with the same subject and the same reason (case-insensitive) is returned with `deduplicated: true`.
   - Drafts: at most one non-rejected draft per (recipient, appointment request), or per (recipient, event) when there is no request.
   - Care events: an identical event (subject, kind, note, schedule) within ±10 minutes is merged. This is a heuristic, marked `ponytail:` in code. Its ceiling: a genuine identical repeat report inside 10 minutes is also merged.
4. **Decisions:** an approval is decided once. A second decision with a new key returns `ALREADY_DECIDED`, and `simulated_outbox.notification_id` is UNIQUE.

## 4. Transactions and failure recovery

Each write runs inside `BEGIN IMMEDIATE … COMMIT`, together with its idempotency record and its `ok`/`deduplicated` audit row. Any exception rolls all of it back, so there is no partial state and no stored key, and a retry with the same key starts clean. A test hook (`faultInjector('before_commit:<tool>')`) proves this for drafts, approvals, and events.

## 5. Medical-safety invariants (enforced by code and tests)

| Invariant | Mechanism |
|---|---|
| No diagnosis, medication, or dose recommendations | All system text comes from fixed templates (`src/domain/safety.ts`). There is no free-form system prose; people's words are quoted and attributed. A test checks template text against advice terms. |
| Missing records are not proof of a missed dose | Status uses exactly `"No report recorded yet today"`. A test asserts that no "missed/overdue/skipped" wording appears. |
| No real patient data | Seed data is fictional and labelled "(synthetic)". |
| No real messages or purchases | `channel = 'simulated'`, `delivery = 'simulated_not_sent'` (CHECK constraints), `real_message_sent: false`. There is no purchasing code path. |
| No booking | Appointment requests are `prepared`/`handed_off` only; responses carry `nothing_booked: true` and an emergency-services notice. |
| Dose-free reference data | Schema has no dose column (tested). |

## 6. Migrations and seed

- Migrations are forward-only and tracked by `PRAGMA user_version`; the current schema version is 1 (`domain_v1`). Each migration runs in a transaction. A PoC-0 database (version 0 with a legacy `events` table) upgrades in place, and the legacy table is left untouched (tested).
- `seedDemoData()` is deterministic and idempotent (`INSERT OR IGNORE` on fixed ids). The server seeds automatically only when the database has no households.
- Seed contents:
  - Rao household (Asia/Kolkata): Ravi (care recipient), Priya (coordinator), Arjun (caregiver), Meera (viewer).
  - Chen household (America/Los_Angeles): Lin (care recipient), Wei (coordinator).
  - Rota for Rao: Mon–Wed Priya, Thu–Sun Arjun.
