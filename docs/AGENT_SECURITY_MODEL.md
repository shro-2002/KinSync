# CareLoop Agent Security Model (Phase 3A)

Scope: how an **untrusted** LLM tool-calling client will be connected to CareLoop. No LLM is integrated yet. Every control below is code-enforced and regression-tested (`test/agent-security.test.ts`, 22 tests). None of it relies on prompt wording.

## 1. Trust zones

| Zone | Examples | Trust | Who controls it | May it carry instructions? |
|---|---|---|---|---|
| **Application** | Turn id, session actor, household id, idempotency keys, tool allowlist, `SYSTEM_POLICY` | Trusted | CareLoop code (`src/agent/policy.ts`, `adapter.ts`) | Yes, and it is the **only** zone that can |
| **Raw user input** | The utterance of the current speaker | Untrusted, but authoritative for *the speaker's own words* | The person speaking | No. It is the source for verbatim fields only |
| **Household records** | `care_events.note`, `reason_as_reported`, `extra_note`, member names | Untrusted. Any household member can write them | Any writer-role member, possibly malicious | **Never** |
| **Tool outputs** | Everything returned by `tools/call` | Untrusted data | Server output, which embeds household records | **Never** |
| **Model output** | Tool names and arguments the model proposes | Untrusted proposal | The LLM | No. Every call passes adapter policy first |
| **Human approval channel** | `decide_approval` | Trusted decision | A care recipient or coordinator, outside the model | n/a. It is excluded from the model entirely |

Data flows only **down** the trust order. Tool outputs reach the model as JSON *data*, inside
`{"trust":"untrusted_data","source":"careloop","tool":…,"payload":…}` (`envelope()`).
They are never concatenated into the system policy. `SYSTEM_POLICY` is a constant that takes no parameters, and a test verifies that household text cannot appear in it.

## 2. Controls (enforcement point → test)

| # | Control | Enforced in | Regression test |
|---|---|---|---|
| C1 | Tool allowlist: 6 tools. `decide_approval` is `HUMAN_ONLY_TOOL`; anything else is `TOOL_NOT_ALLOWED` | `AgentAdapter.execute` | "model sees six tools…", "a model that obeys the injected note…" |
| C2 | Per-turn call budget (8) | `AgentAdapter.runTurn` | "a looping model is cut off…" |
| C3 | Actor bound to the MCP session (`X-CareLoop-Actor`, set by the app when it opens the adapter). Actor-like arguments are ignored | `AgentAdapter.open` → `server.ts` → `CareService.resolveSessionActor` | "identity is fixed by the application session…" |
| C4 | `household_id` is application-controlled: the model's value is discarded and overridden. The server still authorizes independently | `AgentAdapter.execute` + `authorize()` | "model-supplied household_id is overridden…" |
| C5 | Idempotency keys are derived by the app from `(turn id, tool, effective args)`. Model-supplied keys are discarded and never reach the server | `deriveIdempotencyKey` | "derivation is deterministic…", "model-supplied idempotency keys are discarded…" |
| C6 | Verbatim provenance: `note`, `reason_as_reported`, `provider_label`, and `extra_note` must appear in the current utterance, or the call is `VERBATIM_REQUIRED` | `isVerbatimFrom` in `AgentAdapter.execute` | Malicious planner trace (paraphrased dosing text is blocked); golden "paraphrased note" |
| C7 | Untrusted-data envelope for all tool output | `envelope()` | "tool output reaches the model only as JSON data…" |
| C8 | Draft quoting collapses whitespace, so stored text cannot fake template lines such as `[SYSTEM] …` | `quote()` in `safety.ts` | "stored text cannot fake extra lines…" |
| C9 | One error contract: domain-validated schemas make SDK-level input failures return `{"error":{"code":"INVALID_INPUT",…}}` | `domainValidated()` (`src/mcp/schema.ts`) | "schema-invalid input now returns the domain error contract…" |
| C10 | Audit coverage for every rejected operation (invalid, denied, conflict, error, no or unknown actor). Details hold codes and paths, never free text. The household column holds only verified ids | `CareService.audit` / `resolveSessionActor` | "sessions without an actor are audited…", "audit details never contain rejected free text…" |
| C11 | Server-side authorization: household, role, and record scoping. Unchanged from Phase 2; it is the last line of defence, independent of the adapter | `authorize()`, `Queries` | Phase 2 suites (`domain`, `workflow`) |
| C12 | No real side effects: drafts are approval-gated, the outbox is `simulated_not_sent`, nothing is booked or purchased | DB CHECK constraints | Phase 2 suites |

Five deliberate mutations of C1, C4, C5, C6, and C9 each made at least one test fail (`evidence/phase3a/mutation-checks.txt`).

## 3. Prompt-injection position

- **Assumption:** the model *will* sometimes follow instructions embedded in notes. The tests simulate exactly that: a planner that obeys every instruction it reads.
- The obedient planner tries to approve all pending approvals, write into another household with dosing advice, and call an unknown `send_sms`. All three are blocked before reaching the server; `decide_approval` never even appears in the audit log. The approval stays pending, nothing is sent, and the trace fails the golden contract.
- **What remains possible:** a model can still *read* injected text and *say* something misleading to the user. Output-side controls (the response policy and a safety check on spoken replies) belong to the LLM integration phase. See limitation L3.

## 4. Identity: synthetic now, real later

| | Now (Phase 3A) | Required for any real use |
|---|---|---|
| Who is acting | `X-CareLoop-Actor` header naming a seeded member id. **Unauthenticated**, and any local client can send any id | OAuth 2.1 bearer token per the MCP 2025-11-25 authorization spec. The token subject maps to a member server-side |
| Exposure | Server binds to `127.0.0.1` only; Origin validation; CORS off by default | Same, plus TLS and token validation |
| Browser hosts | `CARELOOP_DEFAULT_ACTOR` (demo only, unset by default) | Host-side OAuth |

The adapter API (`AgentAdapter.open({ actorMemberId, householdId })`) already places identity on the application side. Swapping the header for a token changes the transport, not the model contract.

## 5. Errors that cannot be standardized without changing SDK internals

| Case | Observed behaviour | Why it can't be intercepted |
|---|---|---|
| Unknown tool name | Client receives a thrown protocol error: `Tool delete_household not found` | No handler exists to run. The adapter never forwards non-allowlisted names, so a model never sees this path |
| Malformed JSON-RPC, bad protocol version header, session errors | HTTP 400/403/404 from the transport (Phase 0 conformance) | These happen before any tool layer runs; the transport is spec-defined |
| `maxToolInputElements` (if configured) | SDK `InvalidParams` | Checked before validation. CareLoop does not set it |
| Output-schema validation failure (dashboard) | SDK protocol error | Would indicate a server bug, not user input; covered by tests |

## 6. Limitations

- **L1:** Identity is synthetic (§4).
- **L2:** Verbatim checking is substring-based after normalization. A model can still choose *which* part of the utterance to quote, and can split or reorder within it. It cannot add words.
- **L3:** Spoken or written model replies to the user are not yet filtered. Controls cover tool calls only.
- **L4:** `get_household_status` returns all household notes to any member's agent session, by design (family-visible). There is no per-note confidentiality.
- **L5:** The adapter is the enforcement point for model-specific rules (C1, C2, C4–C6). A client that talks to the MCP server *directly* bypasses those rules but still faces C9–C12. Real deployment needs the server to accept agent traffic only through the adapter, for example with an agent-scoped token.
- **L6:** Rate limiting and cost budgets are not implemented beyond the per-turn call cap.
