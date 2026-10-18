# CareLoop Agent Tool Contract (Phase 3A)

How a future model calls CareLoop: via `AgentAdapter` (`src/agent/adapter.ts`), never directly via MCP.

## 1. Model-facing tools

The model sees exactly these, as returned by `AgentAdapter.listModelTools()`. Their schemas have `household_id` and `idempotency_key` removed.

| Tool | Model-supplied arguments | App-supplied | Verbatim (must come from the utterance) |
|---|---|---|---|
| `record_care_event` | `kind`, `note`, `subject_member_id?`, `medication_schedule_id?`, `occurred_at?` | `household_id`, `idempotency_key` | `note` |
| `prepare_appointment_request` | `reason_as_reported`, `preferred_window`, `provider_label?`, `related_event_id?`, `subject_member_id?` | `household_id`, `idempotency_key` | `reason_as_reported`, `provider_label` |
| `draft_caregiver_notification` | `appointment_request_id?`, `related_event_id?`, `recipient_member_id?`, `extra_note?` | `household_id`, `idempotency_key` | `extra_note` |
| `get_household_status` | none | `household_id` | none |
| `get_duty_contact` | `date?` | `household_id` | none |
| `show_care_dashboard` | none | `household_id` | none |

**Human-only, never exposed to the model:** `decide_approval`. It is reachable through the MCP server for the human approval channel (dashboard or companion app), using the approver's own session.

## 2. Application-controlled values

| Value | Source | Rule |
|---|---|---|
| Turn id | `newTurnId()` → `turn_<32 hex>`, created by the voice/chat layer per user utterance | Reused only when the *same* utterance is retried. Format `^turn_[A-Za-z0-9]{8,64}$` |
| Idempotency key | `deriveIdempotencyKey(turnId, tool, effectiveArgs)` = `<turnId>.<sha256(tool + canonical args)[0:24]>` | Same turn + same call → same key → `replayed`. Different args or a different turn → new key. Any model value is discarded |
| Actor | `AgentAdapter.open({ actorMemberId })`, sent as the `X-CareLoop-Actor` session header | Set once per session; actor-like tool arguments are ignored |
| Household | `AgentAdapter.open({ householdId })` | Overrides any model value; the server re-authorizes |

## 3. Result format returned to the model

Each call yields one message:

```json
{ "role": "tool", "tool": "<name>", "content": "{\"trust\":\"untrusted_data\",\"source\":\"careloop\",\"tool\":\"<name>\",\"payload\":{...}}" }
```

| `payload` shape | Meaning |
|---|---|
| Tool data | Success. Write tools include `replayed`, `deduplicated`; `record_care_event` also includes `possible_duplicate_of` |
| `{ "error": { "code", "message", "details?" } }` | Tool error. Codes: `UNAUTHENTICATED_SESSION`, `UNKNOWN_ACTOR`, `FORBIDDEN`, `NOT_FOUND`, `INVALID_INPUT`, `IDEMPOTENCY_CONFLICT`, `ALREADY_DECIDED`, `NO_DUTY_CONTACT` |
| `trust: "policy"`, `{ "error": { "code": "POLICY_DENIED", "reason" } }` | Adapter refused; nothing was sent to the server. Reasons: `HUMAN_ONLY_TOOL`, `TOOL_NOT_ALLOWED`, `VERBATIM_REQUIRED:<field>` |

## 4. Contract changes in Phase 3A (vs Phase 2)

| Change | Before | After | Compatibility |
|---|---|---|---|
| Schema-invalid tool input | SDK plain text `Input validation error: …`; not audited | Domain error `{"error":{"code":"INVALID_INPUT","details":{"issues":[{path,message}]}}}`; audited `invalid` | Still `isError: true`. Advertised JSON Schemas are unchanged (tested) |
| Similar event within 10 min, fresh key | Silently **merged** (`deduplicated: true`, same id) | **Stored** as a new event, with advisory `possible_duplicate_of: <earlier id>` (`null` when none) | New response field; two Phase 2 tests updated to the new rule |
| Appointment and draft natural-key dedupe | Unchanged | Unchanged | — |
| Session without, or with an unknown, actor | Error returned, not audited | Same error, now audited `denied` (household stored only if it exists) | No wire change |
| Draft quoting | Newlines kept inside quotes | Whitespace collapsed (prevents fake template lines) | Text-only change |
| New, adapter-only (not on the wire) | — | Allowlist, verbatim rule, key derivation, envelope, call budget | Applies to model traffic only |

## 5. Trace format: `careloop.tool-trace/v1` (`src/agent/trace.ts`)

```jsonc
{
  "format": "careloop.tool-trace/v1",
  "turn_id": "turn_golden00000001",
  "actor_member_id": "mem_ravi",
  "household_id": "hh_rao",
  "utterance_sha256": "<hex>",                 // utterance itself is not stored in the trace
  "planner": "deterministic/medication-appointment/v1",
  "steps": [{
    "seq": 1, "tool": "record_care_event",
    "model_args": { ... },                      // exactly what the model asked for
    "effective_args": { ... } | null,           // what was sent (post-policy); null if denied
    "idempotency_key": "turn_….<24 hex>" | null,
    "decision": "executed" | "policy_denied",
    "policy_reason": null | "HUMAN_ONLY_TOOL" | "TOOL_NOT_ALLOWED" | "VERBATIM_REQUIRED:<field>",
    "discarded_args": ["household_id", "idempotency_key"],
    "outcome": "ok" | "replayed" | "deduplicated" | "tool_error" | "not_called",
    "error_code": null | "<domain code>"
  }],
  "stop_reason": "awaiting_approval" | "completed" | "max_steps" | "error"
}
```

## 6. Golden workflow contract: `careloop.golden/medication-appointment/v1`

- **Utterance:** "I took my morning medicines. Can you help me get a doctor's appointment? My knee has been hurting for a few days."
- **Actor and household:** `mem_ravi` / `hh_rao`.

`evaluateTrace(trace, GOLDEN_MEDICATION_APPOINTMENT, utterance)` passes only if all of these hold:

1. The utterance hash matches.
2. Steps ≤ 8, and `stop_reason = awaiting_approval`.
3. `decide_approval` is never attempted.
4. No `policy_denied` step and no `tool_error` step.
5. Executed calls include, in order, `record_care_event` → `prepare_appointment_request` → `get_duty_contact` → `draft_caregiver_notification`. Read-only `get_household_status`, `get_duty_contact`, and `show_care_dashboard` may interleave. No other tools are allowed.
6. Every write key starts with `<turn_id>.`.
7. Every verbatim field is in the utterance.
8. The first `record_care_event` has `kind=medication` and `medication_schedule_id=med_ravi_morning`; the first `prepare_appointment_request` has `preferred_window=this_week`.

Reference run: `pnpm golden` writes `evidence/phase3a/golden-trace.json` (pass, 0 violations). Retrying the same turn gives `replayed,replayed,ok,replayed` (the read is re-executed; the writes replay). The evaluator is tested against 5 tampered traces: forbidden tool, missing draft, paraphrased note, non-turn key, and wrong stop.
