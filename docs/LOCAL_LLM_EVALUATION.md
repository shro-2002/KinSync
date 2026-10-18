# Local LLM Evaluation — Zero-Cost Path (Phase 3D investigation)

**Status: investigation only. No code changed. No model downloaded. No paid API touched.**

## 1. Hardware

```
Model: Mac16,13 (MacBook, Apple M4)
Chip: Apple M4 — 10 cores (4 performance + 6 efficiency)
Memory: 24 GB unified
Disk free: 95 GB
macOS: 26.5.2
```

24 GB unified memory (shared CPU/GPU) is the binding constraint. Apple Silicon runs quantized GGUF models via Metal; a comfortable ceiling for an interactive, single-model workload on 24 GB is roughly an **8B-parameter model at Q4**, leaving headroom for macOS, the MCP server (Node), and the browser.

## 2. Runtime already present — no install needed

| Runtime | Found | Detail |
|---|---|---|
| Ollama | ✅ `/usr/local/bin/ollama`, v0.32.1, daemon already running as `/Applications/Ollama.app/.../ollama serve` | REST API on `127.0.0.1:11434`, OpenAI-style `tools` param on `/api/chat` |
| llama.cpp (`llama-server`/`llama-cli`) | ❌ not found | — |
| LM Studio | ❌ not in `/Applications` | — |
| MLX / `mlx-lm` | ❌ not installed | — |

**Models already on disk (zero-download):**

| Model | Size | Params | Context | Ollama "tools" capability |
|---|---|---|---|---|
| `llama3.1:latest` | 4.9 GB (Q4_K_M) | 8.0B | 131,072 | ✅ **yes** — listed under `Capabilities: tools` |
| `phi3:latest` | 2.2 GB (Q4_0) | 3.8B | 131,072 | ❌ `Capabilities: completion` only |
| `gemma3:270m` | 291 MB (Q8_0) | 0.27B | 32,768 | ❌ `Capabilities: completion` only |

Only `llama3.1:8b` is Ollama-certified for structured tool calling. `phi3` and `gemma3:270m` could be prompted to emit JSON, but without native support that's materially less reliable and out of scope for "smallest practical integration" — reliability matters more than size here.

## 3. Live probe against CareLoop's actual tool shapes (local, free, no code change)

Sent real `record_care_event` / `prepare_appointment_request` / `get_duty_contact` / `get_household_status` schemas (copied from `MODEL_TOOL_DESCRIPTIONS` and the zod input schemas) to `llama3.1` via `POST /api/chat`, using the Phase 3B golden utterance and the Scenario-B status question.

### Golden utterance ("I took my morning medicines. Can you help me get a doctor's appointment? My knee has been hurting for a few days.")

- **Cold call** (model not yet resident): 26.98 s wall-clock total — 16.40 s model load, 4.5 s prompt eval (374 input tokens), 6.0 s generation (68 output tokens).
- **Tool selection:** correctly called **two** tools in parallel on the first turn:
  - `record_care_event({kind: "medication", note: "I took my morning medicines."})`
  - `prepare_appointment_request({reason_as_reported: "My knee has been hurting for a few days.", preferred_window: "this_week"})`
- **Verbatim fidelity:** both `note` and `reason_as_reported` matched the user's words exactly (would pass `isVerbatimFrom`, the adapter's punctuation-insensitive check).
- Did not yet call `get_duty_contact` / `draft_caregiver_notification` — correct behavior for one turn; those come once the loop feeds back the `appointment_request.id`.

### Status question ("What's happening in our household today? Just tell me, don't change anything.") — 3 warm runs

| Run | Wall-clock | Model load | Generation | Tool called |
|---|---|---|---|---|
| 1 | 4.20 s | 0.21 s | 1.23 s | `get_household_status` only |
| 2 | 2.01 s | 0.12 s | 1.77 s | `get_household_status` only |
| 3 | 1.49 s | 0.15 s | 1.21 s | `get_household_status` only |

All three runs picked the correct **read-only** tool and called nothing else — a real (if small-sample) signal that Scenario B's "the model must not write" requirement is satisfiable locally.

**Resident footprint while loaded:** `ollama ps` → `llama3.1:latest 5.3 GB, 100% GPU` (full Metal offload, no CPU fallback needed on this M4). Model stays resident for a 4-minute idle window after last use (Ollama default `keep_alive`), so a multi-call agent turn or a short demo session pays the ~16 s cold-load cost once, not per call.

## 4. Compatibility with `ModelPlanner` / `AgentAdapter`

The provider-neutral interface built in Phase 3B (`src/agent/model.ts`) is a clean fit — no interface change needed, same shape `AnthropicPlanner` already implements:

| `PlannerResponse` field | Ollama `/api/chat` source | Notes |
|---|---|---|
| `toolCalls[].id` | `message.tool_calls[].id` | Present (`call_xxxxxxxx`), usable as-is |
| `toolCalls[].name` / `.arguments` | `function.name` / `function.arguments` | Arguments arrive as parsed JSON (not a string to re-parse), unlike Anthropic's `input` |
| `text` | `message.content` | Empty string when a tool call is made, same as Anthropic |
| `stop` | `done_reason` | Maps: `"stop"` → `end_turn`/`tool_use` (disambiguate by presence of `tool_calls`), `"length"` → `max_tokens`. **No `refusal` concept** — Ollama/Llama 3.1 has no structured refusal signal; a safety decline would just come back as plain text, so `checkFinalReply`'s pattern rules become the *only* safety net, not a secondary one |
| `usage.inputTokens` / `.outputTokens` | `prompt_eval_count` / `eval_count` | Direct mapping |
| `usage.cacheReadInputTokens` / `.cacheCreationInputTokens` | — | Always `0` — Ollama has no prompt-caching concept; `estimateCostUsd` should treat an Ollama model as a hardcoded `$0`, not `null` (current `PRICES_PER_MTOK` lookup-miss semantics), to avoid an evaluator reading "no price entry" as "unknown cost" rather than "free" |
| `providerContent` | n/a | Ollama is stateless role/content turns, no thinking-block binding to preserve — `providerContent` can be omitted entirely (unlike the Anthropic planner, which must replay it) |

This would be a new `src/agent/ollama-planner.ts`, structurally parallel to `anthropic-planner.ts` (~80–100 lines): build the `tools` array from `ModelTool[]`, POST to `http://127.0.0.1:11434/api/chat`, map the response. **No change to `AgentAdapter`, `runner.ts`, `output-safety.ts`, the allowlist, verbatim rule, or idempotency-key derivation** — all of that is planner-agnostic by design and already proved itself against a real (if different-vendor) tool-calling model in the probe above.

## 5. Recommended integration (smallest practical, not yet built)

1. **Model:** `llama3.1:8b` (already on disk, zero download). Do not reach for `phi3`/`gemma3` — they lack Ollama tool-calling support and would need prompt-based JSON extraction, a materially less reliable and larger integration than a certified-tools model already present.
2. **New file only:** `src/agent/ollama-planner.ts` implementing `ModelPlanner`, same constructor shape as `AnthropicPlanner` (`{ model?, baseUrl? }`), no SDK dependency — plain `fetch` to the local daemon (already how `connect()` talks to the MCP server, so no new dependency class is introduced).
3. **Wire into `scripts/live-eval.ts`** (or a new `scripts/local-eval.ts`) as a **third planner choice**, selected by `--provider ollama` — keep the existing `--live` paid-API gate untouched; a local-model run needs a *different*, unconditional-but-explicit flag since it costs no money and shouldn't be gated behind "this spends money," but should still require `--provider ollama` explicitly rather than becoming a new silent default.
4. **Deterministic fallback — already built, reuse unchanged:** `DeterministicModelPlanner` (Phase 3B) implements the exact same `ModelPlanner` interface. Recommend:
   - For the **hackathon demo video**: use `DeterministicModelPlanner` as primary (100% reliable, 0 latency variance, 0 cost) — it already passes the golden contract 17/17.
   - Offer `OllamaPlanner` as a **"real local LLM" bonus demonstration** layered on top, not a replacement: same adapter, same safety boundary, same golden evaluator, run live on stage with no API key and no spend. If a tool call comes back malformed (free-text instead of structured, or `done_reason: "length"` mid-call), the existing `runner.ts` failure paths (`output_truncated`, `provider_error`-style handling) already degrade safely to the fact-only `summarizeFromTrace` reply — no new fallback logic is required beyond what `runner.ts` already has for any misbehaving planner.
5. **Do not treat this as a drop-in Claude replacement.** 8B-class local reliability is good but not frontier-grade; keep `AnthropicPlanner` as the "real" evaluated path (Phase 3C, still pending your approval) and `OllamaPlanner` as a parallel, always-available, zero-cost option — both implementing the same interface, selected at the call site.

## 6. Expected latency, reliability, cost (profile from the probe, not a full eval)

| | Observed |
|---|---|
| Cold start (first call after idle) | ~17 s model load + ~10 s prompt+gen for a 2-tool-call turn ≈ **~27 s** |
| Warm, single read-only tool call | **1.5–4.2 s** wall-clock |
| Tool selection correctness (5/5 probe calls) | 5/5 picked a sensible tool; 3/3 status-question calls stayed read-only |
| Verbatim fidelity | Exact match on both probed write fields |
| Resident memory | 5.3 GB, 100% GPU (Metal), no CPU fallback |
| Cost | **$0** — fully local, no network egress, no API key |
| Known 8B-class risk (not yet observed here, flagging from general knowledge of this model class, not measured) | Occasional malformed/missing tool call on more complex multi-step prompts, weaker instruction-following than Opus/Sonnet under adversarial (prompt-injection) pressure — Scenario C-equivalent local testing is recommended before relying on it for the injection case specifically |

## 7. What was *not* done

- No model downloaded (all three models used were already on disk from a prior, unrelated session).
- No code written to `src/` or `scripts/` — this document is the only artifact.
- No `OllamaPlanner` implemented.
- No full golden-contract or injection-scenario run against Ollama — only 2 ad hoc probe prompts (5 total tool-call observations). A real `OllamaPlanner` + offline mock tests + the same golden/injection evaluation Phase 3B ran against the mocked Anthropic client would be the next step, entirely free.

---

**Stopping here for your approval before writing `src/agent/ollama-planner.ts` or any other code.**
