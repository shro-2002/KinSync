# Phase 3A Report: Agent integration readiness

- **Date:** 2026-10-11 (IST).
- **Scope respected:** no LLM or paid API calls, no deployment or exposure (server binds 127.0.0.1), synthetic data only, no real notifications, bookings, payments, or medical advice, no product-scope expansion. The server architecture is unchanged; the new code is an agent adapter layer (`src/agent/policy.ts`, `adapter.ts`, `trace.ts`, `planner.ts`) plus one schema wrapper (`src/mcp/schema.ts`).

## 1. PASS/FAIL

| # | Task | Result | Evidence |
|---|---|---|---|
| 1 | Verify Phase 2 behaviour | **PASS**: 79/79, 17/17, typecheck clean before any change | `evidence/phase3a/00-phase2-baseline.txt` |
| 2 | Standardize tool errors, including SDK validation | **PASS**: all 7 tools use `domainValidated()`, so schema failures return `INVALID_INPUT` with `{path,message}` issues. Advertised schemas are unchanged. Non-interceptable cases are documented (unknown tool → thrown `Tool … not found`; transport errors) | Security model §5; tests "standardized tool errors" (4) |
| 3 | Consistent audit coverage, no leaks | **PASS**: invalid, denied (role, household, no or unknown actor), conflict, and error are all audited. A marker in rejected free text never appears in the audit table. Unverified household ids are stored as `null` | tests "audit coverage" (2) |
| 4 | Explicit trust boundary | **PASS** | `AGENT_SECURITY_MODEL.md` §1–2 |
| 5 | Prompt-injection tests | **PASS**: a planted malicious note, plus a planner that *obeys* it: approval attempt blocked (`HUMAN_ONLY_TOOL`, never reaches the server), cross-household dosing note blocked (`VERBATIM_REQUIRED`, household overridden), unknown tool blocked. 0 sends, approval still pending. Envelope keeps the note as data; fake `[SYSTEM]` draft lines neutralized | tests "prompt injection" (4) |
| 6 | App-controlled turn ids and keys | **PASS**: `turn_<id>` from the application; key = `<turn>.<sha256(tool+canonical args)[0:24]>`. Model keys are discarded and none is ever stored. Retrying a turn replays | tests "idempotency keys" (3); golden retry `replayed,replayed,ok,replayed` |
| 7 | Actor bound outside model arguments | **PASS**: session header set by `AgentAdapter.open`; `actor_id`/`reported_by_member_id` arguments have no effect. Synthetic and real identity are separated in the docs | test "identity is fixed…"; security model §4 |
| 8 | Review the 10-minute heuristic | **PASS, behaviour changed**: no longer merges. Every report is stored, and similar ones get `possible_duplicate_of`. Exact retries are handled by turn keys | tests "a new turn with the same words…", updated domain/workflow tests |
| 9 | Agent tool allowlist | **PASS**: 6 model tools. `decide_approval` is human-only. Per-turn budget of 8 calls | tests "allowlist and actor binding" (3) |
| 10 | Golden contract and trace format | **PASS**: `careloop.tool-trace/v1` and `careloop.golden/medication-appointment/v1`. The deterministic planner passes with 0 violations. The evaluator rejects 5 tampered traces | `AGENT_TOOL_CONTRACT.md` §5–6; `evidence/phase3a/golden-trace.json` |
| 11 | Preserve existing protocol, authorization, MCP Apps, and browser tests | **PASS**: 101/101. `conformance.test.ts` is byte-identical since PoC-1. Scenario 17/17, browser render 11/11 in the official MCP Apps host, curl security unchanged (200/403/400/400/200/404) | `vitest-full.txt`, `scenario-console.txt`, `render/`, `curl-security-rerun.txt` |
| 12 | Regression tests for the new boundaries | **PASS**: 22 new tests. 5 deliberate mutations (human-only check, verbatim check, model key pass-through, household override, SDK validation bypass) each caught; suite restored to 101/101 | `test/agent-security.test.ts`, `evidence/phase3a/mutation-checks.txt` |

**Totals:** 101 tests passed, 0 failed (Phase 2: 79; Phase 3A: +22). Typecheck clean. `pnpm golden` passes.

**Phase 2 tests changed (2, intentional):** "fresh-key retries…" in `domain.test.ts` and "duplicate calls with fresh keys…" in `workflow.test.ts`. Both now expect the event to be **stored and flagged** instead of merged. Appointment and notification dedupe expectations are unchanged.

## 2. Changes to tool contracts

See `AGENT_TOOL_CONTRACT.md` §4. In summary:
1. Schema-invalid input returns the domain error envelope (`INVALID_INPUT` + issues) instead of SDK plain text.
2. `record_care_event` never merges. It adds `possible_duplicate_of` (`deduplicated` is now always `false` for events).
3. Rejections for a missing or unknown actor are audited.
4. Draft quotes collapse whitespace.

No tools were added or removed on the MCP wire. Protocol negotiation, transport, Origin, session, and CORS behaviour are unchanged.

## 3. Security limitations (from `AGENT_SECURITY_MODEL.md` §6)

1. **Synthetic identity.** The header is unauthenticated; real use requires OAuth per MCP 2025-11-25 authorization.
2. **Adapter-only rules.** The allowlist, verbatim, key, and household rules live in the adapter. A client that talks to the MCP server directly bypasses them, though server-side authorization, validation, approval gating, and simulated-only side effects still hold. Production would need an agent-scoped credential so agent traffic must pass through the adapter.
3. **Verbatim check is substring-based.** It blocks *added* words, not selective quoting.
4. **Model replies to the user are not filtered yet.** Controls cover tool calls, not speech.
5. **Unknown-tool errors are thrown** by the SDK rather than returned as `isError`. This is unreachable through the adapter.
6. **No rate limiting or cost budget** beyond 8 calls per turn.
7. **Household notes are family-visible** to any member's agent session by design.

## 4. Ready for real LLM integration?

**Yes, conditionally: ready for a local, synthetic-data, adapter-mediated LLM integration. Not ready for real users or real health data.**

Ready because:
- The model can only propose.
- It cannot approve, send, book, buy, choose its identity or household, mint keys, or put words in a person's mouth.
- Injected notes are handled as data, and a fully compliant malicious planner is contained.
- There is a reproducible golden contract to grade any model against.

Not ready for real users because of limitations 1, 2, and 4.

## 5. Recommended minimum-cost integration approach (proposal, untested)

1. **Swap the planner, nothing else.** Implement `Planner` with a tool-use LLM call. Pass `SYSTEM_POLICY`, `listModelTools()` schemas, and the envelope messages; map the model's `tool_use` blocks to `ModelToolCall`. The adapter, trace, and golden evaluator stay as they are.
2. **Small, fast model first.** Use the cheapest current Claude model with tool use (Haiku-class). Escalate only if the golden pass rate is poor. If the AWS Builder mini-challenge matters, call it through Amazon Bedrock (Converse API), provided your account has model access; otherwise use the Anthropic API directly. **Check current model ids and pricing at integration time; nothing was called or priced here.**
3. **Keep calls minimal and cacheable.**
   - About 5 tool calls per turn.
   - Mark the static prefix (system policy plus tool schemas) for prompt caching.
   - Cap max output tokens per step.
   - The adapter's 8-call budget bounds the worst case.
4. **$0 CI.**
   - Record model responses once per golden case into fixtures, and replay them in `pnpm test` (a planner backed by fixtures).
   - Run live model calls only in an explicit `pnpm eval:live`, against the golden contract plus the injection scenarios.
   - Gate on `evaluateTrace(...).pass`.
5. **Add output filtering before any demo with spoken replies** (limitation 4). Start with the same template-only approach: speak from tool results through fixed phrasings where possible.
6. **Use the claude-api reference at implementation time** for SDK usage, tool-use loop shape, and caching parameters.

Stopping here for review.
