# Phase 2 Report: Core domain model and agentic workflow foundation

- **Date:** 2026-10-11 (IST); evidence timestamps are UTC.
- **Scope respected:** no LLM calls, no AWS, no paid APIs, no deployment, no push or publish, no git commits, no real messaging or purchasing, synthetic data only. MCP protocol negotiation is unchanged (pinned to `2025-11-25`; the conformance test file is byte-identical to PoC-1). No large frontend; the dashboard view gained three small sections.
- **Result:** **79/79 tests**, **17/17 scenario checks**, **11/11 browser render checks**, typecheck clean, and 5/5 deliberate mutations detected.

## 1. Tests: passed and failed

| Requested area | Where | Tests | Result |
|---|---|---|---|
| Happy path | `domain.test.ts` › happy path (2); `workflow.test.ts` › happy path (1) | 3 | ✅ PASS |
| Duplicate calls | `domain.test.ts` › idempotency (5); `workflow.test.ts` › same-key and fresh-key retries (2) | 7 | ✅ PASS |
| Invalid inputs | `domain.test.ts` › invalid inputs (8 table cases + 3); `workflow.test.ts` (1); `e2e.test.ts` (1) | 13 | ✅ PASS |
| Cross-household access denial | `domain.test.ts` › household and role (4, incl. no existence leak); `workflow.test.ts` › cross-household, impersonation by argument, no or unknown actor (3) | 7 | ✅ PASS |
| Rejected approvals | `domain.test.ts` (1); `workflow.test.ts` (1) | 2 | ✅ PASS |
| State persistence | `workflow.test.ts` › restart mid-workflow (1); `e2e.test.ts` › persists across restart (1) | 2 | ✅ PASS |
| Failure recovery | `domain.test.ts` › crash in draft and in approval (2); `workflow.test.ts` › crash over MCP (1) | 3 | ✅ PASS |
| Medical safety | `domain.test.ts` › safety (5) + no dose column (1) | 6 | ✅ PASS |
| Migrations and seed | `domain.test.ts` (3) | 3 | ✅ PASS |
| Duty rota and time zones | `domain.test.ts` (2) | 2 | ✅ PASS |
| MCP Apps dashboard with domain state | `workflow.test.ts` › read-only + content, annotations (2) | 2 | ✅ PASS |
| Existing MCP protocol and UI regressions | `conformance.test.ts` (15, **unchanged**), `mcp-apps.test.ts` (11), `e2e.test.ts` (5) | 31 | ✅ PASS |
| **Total** | 5 files | **79** | **79 passed, 0 failed** |

Totals by file: domain 36, conformance 15, workflow 12, mcp-apps 11, e2e 5 (`evidence/phase2/vitest-full.txt`). The area rows above overlap slightly, so they sum to more than 79.

**Mutation checks** (`evidence/phase2/mutation-checks.txt`). Each change was applied, the suite run, and the change reverted:

| Mutation | Tests failing |
|---|---|
| household check removed | 2 |
| role check removed | 2 |
| idempotency lookup disabled | 4 |
| "no report" phrase changed to "Missed dose" | 2 |
| approval re-decision allowed | 1 |

The restored suite passes 79/79.

**Changes to earlier tests** (exact diff: `evidence/phase2/poc-test-changes.diff`). `log_event` and the `careloop://events/recent` resource were **removed**: they had no actor, no household scope, and no idempotency, so they would have bypassed authorization. Three PoC-0 e2e tests, one PoC-1 MCP Apps test, and `verify-render.ts` now call `record_care_event` with a synthetic actor. Their intent is unchanged: store and return, reject invalid input without storing, persist across a restart, and show a new event after a dashboard refresh. `EXPECTED_TOOLS` is now the seven-tool set. **No protocol, Origin, session, header, or CORS assertion changed**, and `conformance.test.ts` has no diff.

## 2. MCP tools implemented (exact)

| Tool | Kind | Inputs (snake_case) | Notes |
|---|---|---|---|
| `record_care_event` | write, idempotent | `household_id`, `idempotency_key`, `kind`, `note`, `subject_member_id?`, `medication_schedule_id?`, `occurred_at?` | Note stored verbatim. Same report within 10 min is merged (heuristic). |
| `get_household_status` | read | `household_id` | Members, duty contact, medication reference with neutral wording, recent events, open requests, pending approvals (with draft preview), simulated send count, safety notice. |
| `prepare_appointment_request` | write, idempotent | `household_id`, `idempotency_key`, `reason_as_reported`, `preferred_window`, `provider_label?`, `related_event_id?`, `subject_member_id?` | `nothing_booked: true` and an emergency notice. Same open reason is deduplicated. |
| `get_duty_contact` | read | `household_id`, `date?` | Rota by local weekday, falling back to the coordinator. |
| `draft_caregiver_notification` | write, idempotent | `household_id`, `idempotency_key`, `appointment_request_id?`, `related_event_id?`, `recipient_member_id?`, `extra_note?` | Templated body plus a **pending approval**. One live draft per recipient per request. |
| `decide_approval` | write, idempotent | `household_id`, `idempotency_key`, `approval_id`, `decision` (`approve`/`reject`), `reason?` | Care recipient or coordinator only. Decided once. Approve writes one `simulated_not_sent` outbox row. |
| `show_care_dashboard` | read, **MCP App** | `household_id?` | Unchanged `ui://careloop/dashboard.html` link. Now includes domain state; verified read-only. |

The actor is never a tool argument. It comes from `X-CareLoop-Actor` at session initialize. Write tools are annotated `idempotentHint: true, readOnlyHint: false`; read tools are annotated `readOnlyHint: true` (tested). Domain errors return `isError: true` with `{"error":{"code","message","details?"}}`. Codes: `UNAUTHENTICATED_SESSION`, `UNKNOWN_ACTOR`, `FORBIDDEN`, `NOT_FOUND`, `INVALID_INPUT`, `IDEMPOTENCY_CONFLICT`, `ALREADY_DECIDED`, `NO_DUTY_CONTACT`.

## 3. End-to-end workflow evidence

`pnpm scenario` runs everything over MCP against a fresh seeded database with a fixed clock (Mon 2026-10-12, 09:30 IST). It writes `evidence/phase2/scenario-transcript.json` (17/17 checks):

| Phase | What happened | Check |
|---|---|---|
| A | Ravi's session ran record → prepare → duty contact → draft → status, then stopped with `awaiting_approval` | duty contact is Priya; no send before approval; protocol 2025-11-25 |
| B | Same turn retried | all 3 writes `replayed`; same ids; row counts identical |
| C | Wei (Chen household) tried to approve | `FORBIDDEN` |
| D | Arjun (caregiver) tried to approve | `FORBIDDEN` (role) |
| E | Priya approved; repeated the same key; then a new key | approved; `simulated_not_sent`; replay; `ALREADY_DECIDED`; exactly 1 outbox row |
| F | Final status | no pending approvals; request handed off; morning schedule "Report recorded today (1)", evening "No report recorded yet today" |

The audit trail in the transcript shows `ok` ×3 → `replayed` ×3 → `denied` ×2 → `ok` → `replayed` → `conflict`.

Generated draft (verbatim from the transcript):

```
[CareLoop draft - simulated, not sent] Hi Priya, Ravi asked for help through CareLoop.
Appointment help requested for Ravi with Family physician (synthetic), this week. Reason in their own words: "My knee has been hurting for a few days and I would like to see the doctor".
Latest medication report (2026-10-12 09:30, from Ravi): "I took my morning medicines".
Please check in with the family. This is a coordination message, not medical advice.
```

Other evidence (`evidence/phase2/`):

| File | Content |
|---|---|
| `render/` | Official ext-apps basic-host; 11/11 checks including duty contact, neutral medication wording, pending approval listed, refresh round-trip, protocol 2025-11-25 observed. Screenshots: `10-verify-initial.png`, `11-verify-after-refresh.png`. |
| `inspector-cli.txt` | MCP Inspector 2.10.1: 7 tools, `hasApp` only for the dashboard; actor header works (Priya gets Thursday → Arjun); Wei gets `FORBIDDEN`; no header gets `UNAUTHENTICATED_SESSION` |
| `curl-security-rerun.txt` | PoC-0 security script against the Phase 2 server: 403 foreign Origin, 400 missing session, 400 bad protocol header, 404 after DELETE |
| `vitest-full.txt`, `typecheck.txt`, `mutation-checks.txt`, `poc-test-changes.diff` | Suite, typecheck, mutation results, exact test edits |

## 4. Remaining limitations

1. **Identity is synthetic.** The `X-CareLoop-Actor` header is trusted as-is, so any local client can claim any member. OAuth (MCP authorization) is not implemented. Browser hosts need `CARELOOP_DEFAULT_ACTOR` (F-18).
2. **SDK schema rejections bypass the domain** (F-19). They are not audited and use a different error shape (plain text, no `code`).
3. **The event dedupe is a heuristic** (identical report within ±10 min). A genuine repeat inside the window is merged.
4. **Updates reach the dashboard by pull** (refresh or re-call), not push.
5. **One proposed-action type** (`send_notification`). Appointment requests aren't separately approvable; they become `handed_off` with the notification.
6. **No real channels**: no SMS, email, Alexa notification, booking, or purchasing. The outbox is simulated by schema constraint.
7. **No i18n or locale formatting**; times are `YYYY-MM-DD HH:MM` in the household time zone.
8. **Single-process SQLite.** WAL plus `BEGIN IMMEDIATE` is fine locally; it is not a multi-instance design.
9. `service.ts` is 338 lines, slightly above the 300-line house guideline. The read model was already split out to `status.ts`.
10. **The planner is deterministic.** No natural-language understanding yet; the scenario input is fixed.

## 5. Verdict: **CONDITIONAL GO for LLM integration**

The tool surface is ready for a planner: small, typed, idempotent, authorization-enforced server-side, approval-gated, auditable, and proven over real MCP. An LLM can only *propose*. It cannot send, book, approve on behalf of others, or choose who it is acting as.

Conditions before or while wiring an LLM:
1. **Verbatim provenance.** `note`, `reason_as_reported`, and `extra_note` are quoted *as the person's words*. The LLM must pass the user's transcript text, not a paraphrase that could add advice. Store the raw utterance alongside, or have the voice layer supply those fields.
2. **Prompt-injection hygiene.** Notes are user-controlled and are echoed back in `get_household_status`. Treat tool output as data in the system prompt, and keep approval strictly human (already enforced: `decide_approval` requires an approver role, and the LLM session acts as the parent).
3. **Normalize SDK validation errors** to the domain error shape (F-19), so the model sees one error contract and every rejection is audited.
4. **Derive idempotency keys from the conversation turn id**, not from model output, so retries replay instead of relying on heuristic dedupe.
5. **Keep the LLM's session actor equal to the speaker.** Never give the model a coordinator session.
6. **Cost and safety budget.** Run the LLM through a mock-able interface with the existing deterministic scenario as a golden test. The LLM plan must produce the same five tool calls and stop at `awaiting_approval`.

Stopping here for review.
