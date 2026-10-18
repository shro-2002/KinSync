# Phase 3B Report: Real LLM integration (offline-verified)

- **Date:** 2026-10-11 (IST).
- **Real API calls made:** **none.** All LLM behaviour was tested with mocked model responses and an injected fake SDK client. The live path exists, but it is gated and was not run (see `LLM_EVALUATION_PLAN.md`).
- **Scope respected:** no deployment, publishing, commits, or pushes. MCP protocol 2025-11-25, transport, Origin, session, and CORS behaviour are unchanged (`conformance.test.ts` is byte-identical since PoC-1).

## 1. What was built

| Piece | File | Notes |
|---|---|---|
| Provider-neutral contract | `src/agent/model.ts` | `ModelPlanner.plan(request) → { text, toolCalls, stop, usage, model, providerContent }`, conversation types, limits, price table, cost estimator |
| Multi-step loop | `src/agent/runner.ts` | user → model proposes → adapter enforces + executes → untrusted envelope back → model decides → final reply → output safety. Budgets, no retries, per-turn JSONL usage log (no utterances or payloads) |
| Output safety | `src/agent/output-safety.ts` | Blocks dosage, medication advice, and diagnosis; fabricated sends, bookings, or purchases; claims not confirmed by tool results; ids not seen this turn. Repairs a missing approval notice. Otherwise replaces the reply with a fact-only summary built from the trace |
| Deterministic planner | `DeterministicModelPlanner` (`src/agent/planner.ts`) | Free and offline. Same golden sequence; its reply is built from confirmed results |
| Anthropic planner | `src/agent/anthropic-planner.ts` | `@anthropic-ai/sdk` 0.133.0 (pinned, MIT). Default model `claude-opus-5-5`, configurable. `maxRetries: 0`, 60 s timeout, non-streaming, `tool_choice: auto`, `output_config.effort` (default `medium`). Prompt caching on the static system block and the last tool. Full assistant content is replayed unchanged (thinking blocks stay valid). `refusal` and `max_tokens` are handled. Constructed only when explicitly used |
| Model-facing tool text | `MODEL_TOOL_DESCRIPTIONS` (`src/agent/policy.ts`) | **New:** the model no longer sees MCP descriptions that mention idempotency keys or `decide_approval` (found by a test, see F-26) |
| Live evaluation | `scripts/live-eval.ts` (`pnpm eval:live -- --live`) | Requires `--live` **and** credentials in env. Prints a worst-case cost cap first. Never prints the key |
| Offline demo | `scripts/offline-turn.ts` (`pnpm agent:offline`) | Full loop with the deterministic planner → `evidence/phase3b/offline-turn.json` |

The adapter (allowlist, actor and household binding, turn-derived keys, verbatim rule, envelopes, 8-call budget) is unchanged and is the only path to tools.

## 2. Tests

**127 passed / 0 failed** (Phase 3A: 101; +26 new in `test/llm-runner.test.ts`). Typecheck clean.

| Required scenario (mocked model) | Result |
|---|---|
| Successful multi-tool workflow: golden contract, verbatim note stored, approval pending, usage summed ($0.032 estimated for the mocked tokens) | ✅ |
| Malicious tool requests (`decide_approval`, `send_sms`, `delete_household`) refused before the server | ✅ |
| Prompt injection via a stored note: obeying model contained; its "approved and sent… take 2 extra tablets" reply replaced | ✅ |
| Model hallucinating completed actions with no tool calls: replaced with "I wasn't able to complete that. Nothing was changed." | ✅ |
| Tool failure: `INVALID_INPUT` returned as an `is_error` envelope; the false "recorded" claim replaced; an honest failure reply passes | ✅ |
| Limits: 6 iterations, 8 tool calls (mid-batch, no extra model call), input-token budget, per-call output cap, truncated output | ✅ (5 tests) |
| Duplicate tool calls in one turn replay (1 row written) | ✅ |
| Provider error: one attempt, no retry, no tools, factual fallback. Refusal ends the turn | ✅ (2 tests) |
| Output-safety unit rules (3 unsafe and 3 safe phrasings), approval-notice repair, foreign-id detection | ✅ |
| `AnthropicPlanner` request shape via injected client: model, `max_tokens`, `tool_choice auto`, no `decide_approval`, cache breakpoints, session context, provider content replayed unchanged, tool results as envelopes | ✅ (2 tests) |
| Live gate: refuses without `--live` (even with a key set, key not printed); refuses with `--live` but no credentials | ✅ (2 tests) |

**Mutation checks** (`evidence/phase3b/mutation-checks.txt`). Each boundary was disabled in turn, the suite run, and the change reverted; every one was caught:

| Boundary disabled | Tests failing |
|---|---|
| output safety | 7 |
| iteration cap | 1 |
| automatic retry added | 1 |
| server descriptions leaked to the model | 1 |
| token budget | 1 |

The restored suite passes 127/127.

**Regression of earlier phases:**
- `pnpm golden`: pass, 0 violations.
- `pnpm scenario`: 17/17.
- Browser render in the official MCP Apps host: 11/11.
- `pnpm agent:offline`: golden pass, reply `passed`.

## 3. Costs: estimated vs measured

| | Estimate | Measured |
|---|---|---|
| Golden turn, `claude-opus-5-5` | ≈ $0.08–0.18 (hard cap $0.40) | **$0.00, not run** |
| Golden turn, `claude-haiku-5-5` | ≈ $0.002–0.005 (hard cap $0.01) | **$0.00, not run** |
| Default live eval (2 cases, Opus 5.5) | ≈ $0.15–0.35 (cap $0.80) | **$0.00, not run** |
| Development and tests in this phase | $0 | $0 (mocks only) |

The estimates use list prices from the bundled Claude API reference (cached 2026-10-06). Thinking tokens on Opus 5.5 count as output and are the main uncertainty.

## 4. Safety and tool-calling behaviour

- **The model only proposes.** Approval, sending, booking, and purchasing are impossible from the model path: `decide_approval` is human-only, the outbox is simulated by schema, and nothing books or buys.
- **The person's words are preserved:** verbatim fields must appear in the utterance (adapter) and are stored unchanged (tested end to end).
- **Replies cannot claim what tools did not confirm.** Pending approvals are always disclosed (repair). Medical advice and diagnosis replace the whole reply.
- **No cross-household data:** the server scopes every result. The reply checker also rejects ids not present in this turn's results.
- **Errors fail closed:** provider error, refusal, truncation, or exhausted budgets all end the turn with a fact-only reply and no retry.

## 5. Limitations

1. **The live model's behaviour is unmeasured.** Pass rates, real token use, and cache hit rate are unknown until the approved live eval.
2. **Output safety is pattern-based.** It is conservative: safe sentences like "thanks for taking your medicines" may be replaced. Paraphrased advice that avoids the patterns could pass. Names of people in other households are not checked; the server never returns them, so only a model *inventing* one could leak a name.
3. **Synthetic identity** and **adapter-only model rules** (Phase 3A limitations 1–2) still apply.
4. **No streaming** yet. Voice latency will be the sum of up to 6 sequential model calls.
5. The pricing table covers only Opus 5.5 and Haiku 5.5; other models report a cost of `null`.

## 6. Readiness

| For | Ready? | Why / next |
|---|---|---|
| **Live LLM evaluation** | **Yes, pending your approval and credentials.** | Run `LLM_EVALUATION_PLAN.md` §2; the expected spend is below $1. |
| **UI integration** (dashboard + chat panel) | **Conditionally yes.** | The reply text, pending approvals, and trace are structured. The dashboard already shows pending approvals. The human approval UI still needs to be built (calling `decide_approval` with the approver's own session). |
| **Voice integration** | **Not yet.** | Needs: (a) a live eval pass; (b) streaming or a "working on it" cue for latency; (c) speech-to-text that supplies the exact transcript as the utterance (the verbatim rule depends on it); (d) a spoken-confirmation step for the human approval path. |
