# Phase 4 Report: KinSync Persistent Care Handoff

**Date:** 2026-10-14  **Product:** KinSync, built from the existing CareLoop codebase (repository, package, module names, database file and Git history unchanged)
**Verdict: GO for final demo polish** (basis and the non-blocking caveats are in §8 and §9).

## 1. What was built

One end-to-end workflow, persisted in SQLite and enforced server-side:

1. A household member says they need help with a care task (voice-turn stand-in: a rule-based planner).
2. KinSync reads today's **duty contact** from the family rota (existing `dutyContact`).
3. It prepares a **proposed handoff** to another authorized household member (coordinator or caregiver, resolved against the real roster; never free text) and stores it as `PENDING_APPROVAL`.
4. A **human** (care recipient or coordinator, never the proposed recipient) approves or rejects it.
5. After approval, **the proposed recipient, and only they, must separately accept or decline**.
6. Only approval **and** acceptance mark it `COMPLETED`. Every transition is persisted, timestamped, household-scoped and audited.

```
PENDING_APPROVAL ──approve──▶ PENDING_ACCEPTANCE ──accept──▶ COMPLETED
       │                              │
     reject                        decline
       ▼                              ▼
   REJECTED                       DECLINED          (all three end states are terminal)
```

The state machine is a single table in `src/domain/handoff-state.ts`; every other pair is `INVALID_TRANSITION`. A completed handoff **records a family agreement; it does not move the duty rota, send anything, or claim anyone arrived or gave care.** There are no timers, auto-reassignment, escalation or notification delivery (none were invented).

## 2. Decisions made (no approval stop was needed)

| Decision | Choice | Why |
|---|---|---|
| Storage | Additive migration v2: `handoffs` (current state, `version`) and `handoff_transitions` (one row per move). Existing v1 databases upgrade in place. | No destructive migration. History is derived from transitions, so there is one source of truth. |
| Reuse | New logic runs inside the existing `CareService.mutate` | Gives atomic write + idempotency key + audit row + crash rollback for free. |
| Approver | Same roles as `decide_approval` (care recipient, coordinator), **minus the proposed recipient** | Approval and acceptance must be distinct acts by distinct people. |
| Recipient | Must be a coordinator/caregiver, not the duty contact, not the requester; named recipient resolved by id or exact name inside the household only. If none is named and exactly one candidate exists, it is used and labeled `only_eligible_member`; otherwise the server asks (`recipient_required`). | "Authorized household member, not arbitrary free text" and "clarify rather than invent". |
| Simulated actor | Optional `simulated_actor_id` on the **two human tools only**; honored only if the server runs with `CARELOOP_SIMULATED_ACTORS=1` **and** the session has no `X-CareLoop-Actor` header; target must be in the session actor's own household; recorded as `simulated` in the transition row and audit detail. | A browser host has one MCP session, so one dashboard cannot otherwise show three people (friction F-36). It is a labeled demo mode, not authentication. |
| Model tools | Allowlist gains only `propose_handoff` and `get_handoffs`. `decide_handoff` and `respond_to_handoff` are in `HUMAN_ONLY_TOOLS`. | Spec: "only the tools necessary for proposing and viewing"; human decisions stay outside the model. |

## 3. Files

**Added:** `src/domain/handoff-state.ts`, `src/domain/handoffs.ts`, `src/agent/handoff-planner.ts`, `src/ui/handoff-view.ts`, `test/handoff.test.ts` (35 tests), `test/handoff-mcp.test.ts` (19 tests), `scripts/handoff-demo.ts`, `scripts/verify-handoff-ui.ts`, `scripts/handoff-ollama.ts`, `docs/PHASE4_HANDOFF_REPORT.md`, `evidence/phase4/`.

**Modified (additive):** `src/domain/{types,errors,migrations,authz,inputs,queries,service}.ts`, `src/mcp/{tools,dashboard}.ts`, `src/server.ts`, `src/main.ts`, `src/agent/{policy,adapter,runner,output-safety,planner,trace}.ts`, `src/ui/dashboard.{ts,html}`, `package.json` (3 scripts), `README.md`, `docs/FRICTION_LOG.md`.
**Existing tests edited (2 assertions, documented as F-37):** `test/helpers.ts` `EXPECTED_TOOLS` and the tool-list assertion in `test/agent-security.test.ts`; `HarnessOptions` gained one optional field. Seven existing MCP tools and their schemas are unchanged; the dashboard output only gained fields (`handoffs`, `simulation`).

## 4. Test and regression results

| Check | Result | Evidence |
|---|---|---|
| Typecheck (`tsc --noEmit`) | clean | `evidence/phase4/typecheck.txt` |
| Full suite | **221/221** (167 existing + 54 new) | `evidence/phase4/vitest-full.txt` |
| Scenario checks (existing) | **17/17** | `evidence/phase4/scenario-console.txt` |
| Golden trace (existing medication/appointment) | pass, 0 violations | `evidence/phase4/golden-console.txt` |
| Agent offline (existing) | golden = true | `evidence/phase4/agent-offline-console.txt` |
| MCP Apps browser checks (existing) | **11/11** | `evidence/phase4/render-console.txt` |
| New: handoff browser checks (reference host, Chromium) | **21/21** | `evidence/phase4/handoff-ui-console.txt`, `evidence/phase4/browser/*.png` + `25-verify-handoff-ui.json` |
| New: handoff demo over MCP | **14/14** | `evidence/phase4/handoff-demo-console.txt`, `evidence/phase4/handoff-demo.json` |

**One flake, disclosed:** the first full run had 1 failure, a pre-existing 5 s subprocess test timing out while the machine's load average was ~12 (F-39). It passed in isolation twice and the full suite passed 221/221 on re-run; the failing run is kept as `vitest-full-run1-load-flake.txt`.

**The new tests are not vacuous:** five deliberate mutations were each caught (recipient identity check removed; human tools dropped from `HUMAN_ONLY_TOOLS`; recipient allowed to approve their own handoff; state machine allowing `reject` after `approve`; simulation honored when disabled). A first mutation attempt silently did nothing because of BSD `sed`, which is why it was redone and why F-40 exists.

Coverage of what the brief asked for, by test: lifecycle, rejection, decline (`handoff.test.ts` *lifecycle*); unauthorized approve/accept, wrong recipient, cross-household (*authorization*, and the MCP "wrong people" test); duplicates and idempotent retries, idempotency conflict, double-click replay (*duplicates*); invalid transitions (table-driven over all 25 status/event pairs, plus real attempts); concurrent updates (two connections racing approve vs reject, a stale-read compare-and-set loss, and a crash-before-commit rollback); persistence after restart (domain, MCP, and browser); audit correctness (exact actor/target/outcome rows and transitions agree); model cannot invoke human-only operations (adapter denial, an obedient compromised planner, identity-like arguments discarded); browser interaction and UI persistence (`verify-handoff-ui.ts`).

## 5. Working end-to-end demonstration

`pnpm handoff:demo` (no browser, no simulation, a real header-bound session per human), abridged from `evidence/phase4/handoff-demo.json`:

1. Ravi: *"I need help getting to my clinic visit on Thursday. Can Arjun take over from Priya?"* The planner calls `get_household_status` then `propose_handoff`; reply: *"I've prepared a proposal for Arjun to take over this task. A person needs to approve it, and Arjun needs to accept it, before anything changes. Nothing has been sent or arranged."* State: `PENDING_APPROVAL`, owner Priya, proposed Arjun.
2. A compromised model tries `decide_handoff` and `respond_to_handoff`: both `policy_denied: HUMAN_ONLY_TOOL`, never reach the server.
3. Meera (viewer) approve: `FORBIDDEN`. Arjun (the recipient) approve: `FORBIDDEN`. Arjun accept before approval: `INVALID_TRANSITION`.
4. Priya (coordinator) approves: `PENDING_ACCEPTANCE`. Same key again: `replayed`, no second transition. Priya accepts for Arjun: `FORBIDDEN`.
5. Arjun accepts: `COMPLETED`. A later reject: `INVALID_TRANSITION`.
6. Server restart on the same DB: still `COMPLETED`, 3-entry history; outbox and drafts empty; audit shows the denials and exactly three successful handoff writes.

`pnpm verify:handoff-ui` repeats this through the dashboard (screenshots `20`..`24`): switch to Arjun, the Approve button is disabled with a reason; the script **re-enables it in the DOM and clicks anyway**, and the **server** answers `FORBIDDEN` (audited, state unchanged). Switch to Ravi (care recipient), Approve works (stored as a *simulated* approval through Priya's session); as Priya, a forced Accept is refused; as Arjun, Accept completes; restart + reload shows the history with timestamps.

## 6. Security and authorization evidence

| Threat | Control (all enforced in code) | Proof |
|---|---|---|
| Model approves/accepts for a human | Not in the model's tool list; `HUMAN_ONLY_TOOLS` denial before any server call; `simulated_actor_id` is an application-controlled argument the adapter discards | `handoff-mcp.test.ts` *cannot take human decisions* (3 tests); demo step 2; mutation M2 |
| Model-supplied actor | Actor comes from the session header; tool arguments never set identity | existing 3A tests + `resolveSessionActor` tests |
| Simulated actor abused | Needs server flag **and** header-less session **and** same household; role/identity still checked; labeled in row and audit | `handoff.test.ts` *simulated actor* (4); `handoff-mcp.test.ts` (3); mutation M5; UI forced-click checks |
| Wrong human acts | Role gate (`authz.ts`) + exact-identity rules in `handoffs.ts` (recipient cannot approve; only the named recipient accepts) | *authorization* (5) + MCP wrong-people test; mutations M1, M3 |
| Cross-household | Every query takes `household_id`; other-household ids are `NOT_FOUND`; simulated target must be in the session household; unknown vs other-household simulated ids give the same reason | *is household-scoped*, simulated-actor tests |
| Skip a step / replay / race | State machine; idempotency keys; `BEGIN IMMEDIATE`; compare-and-set on `status` + `version` | state-machine table, race test, stale-read test; mutation M4 |
| Half-written state | One transaction with the idempotency record and audit row | crash-before-commit test |
| Model claims a human decision or that someone arrived | Output safety: decision words (approved/accepted/declined/rejected/completed) allowed only if a tool result in the turn shows that status; "arrived / on their way / provided care / took over" always flagged | `output safety for handoffs` (6 tests) |
| Medical advice | Handoff text is stored verbatim and never interpreted; existing output-safety rules unchanged | existing suite |
| Real side effects | None exist: no SMS, calls, bookings, dispatch; outbox and drafts stay empty | demo step 6, UI check |

## 7. What is genuinely agentic, and what is deterministic (judge-facing)

- **Deterministic, by design (this is where trust lives):** the state machine, authorization, recipient eligibility, idempotency, audit, the dashboard's "who may act" lists, and output safety. None of it involves a model, and none of it can be talked around.
- **The default planner is rule-based, not an LLM.** `DeterministicHandoffPlanner` matches a few English patterns, reads the roster, and proposes. It is reproducible and free, and it is **not autonomous LLM planning**; we do not claim it is. When it cannot tell what is asked or who should take over, it asks and writes nothing.
- **Where an LLM genuinely participates:** only in the explicit experimental `--provider ollama` path (`pnpm handoff:ollama`), where a local model chooses the tool call and arguments through the same `AgentAdapter` policy. One real run (single sample, no retries, `evidence/phase4/ollama-run.json`) proposed the handoff to Arjun and made no human-decision call. That is **one data point, not a reliability claim**; Phase 3E already showed this model class does not reliably chain multi-step plans. A paid Claude path exists (opt-in, never run).
- **Human, always:** approve/reject and accept/decline. The AI can propose and read; it cannot decide.

## 8. Limitations and risks

- **The simulated actor is impersonation inside a trusted demo.** With `CARELOOP_SIMULATED_ACTORS=1`, a header-less browser session can act as any member of its household. It is labeled, audited and scoped, but it is not authentication; production needs per-user OAuth (F-36). Default is off.
- **Not native Alexa+.** The "voice turn" is a rule-based planner on text, and the UI runs in the MCP Apps reference host. No speech, no real Alexa skill.
- **A completed handoff does not change the duty rota** and nothing is notified; it records an agreement. A real product needs rota update, reminders and escalation, deliberately not invented here.
- **Natural-language coverage is narrow:** regex intent patterns and exact first-name matching in English; one recipient only; a requester cannot propose themselves; task dedupe is exact (case-insensitive) text.
- **Concurrency is tested with two SQLite connections, sequentially, plus a compare-and-set unit test**, not a parallel stress test. SQLite's writer lock plus the CAS is the actual guarantee.
- **UI:** semantic `<button>`s, a live status region, text (not color alone) for state, light/dark; but no axe/screen-reader run, no narrow-viewport check, and the chosen simulated actor resets on page reload.
- **Local model:** n = 1 (above).
- **One pre-existing timing flake** under load (F-39).
- **Git:** nothing committed or pushed (the repository has no commits yet). An existing `data/careloop.db` at schema v1 will upgrade itself to v2 the next time the server starts; the migration is additive.

## 9. Verdict: GO for final demo polish

Everything the brief required works and is verified in three independent ways (unit/integration tests with mutation checks, an MCP demo, and a real-browser run through the reference host), the original golden scenario, 17/17 scenarios and 11/11 browser checks are intact, and the only edits to existing assertions are the two tool-list ones. The risks in §8 are honest-labeling and polish items, not blockers: for the demo, run with `CARELOOP_SIMULATED_ACTORS=1` and say "simulated" out loud. Suggested polish order: (1) rehearse the screen flow in `evidence/phase4/browser/`; (2) decide whether the pitch needs the rota to update on completion; (3) raise the 5 s test timeout if F-39 recurs.
