# Submission Copy — Devpost Description & Revised Narration

**Date:** 2026-10-18 · **Status: draft copy, not yet submitted.** At the time of writing the demo video has not been uploaded and no Devpost submission has been made. This file is the prepared text, not a record of what was submitted.

Every claim below is grounded in shipped, passing code. **No uniqueness claims are made** — other entries in this hackathon implement comparable propose/approve/accept patterns. This copy describes what KinSync does, not what others do not.

---

## 1. Devpost description

### Tagline
**Care handoffs with no silent transfer of responsibility.**

### Inspiration
When a family shares care for someone, the failure is rarely the task itself. It is the handover — two people each believing the other has it on Thursday. Amazon discontinued Alexa Together, so the obvious place this would have lived went away. KinSync is a small, careful attempt at the specific moment where responsibility changes hands.

### What it does
Someone being cared for says they need help with a task. KinSync proposes moving that task to another household member — resolved against the real family roster, never free text. Nothing moves yet.

A human approves it. **It still has not moved**: the original person is still responsible, and the dashboard says so. Only when the named recipient separately accepts does responsibility actually transfer, and it is recorded as a family agreement with a timestamped history.

If the approver rejects, or the recipient declines, the server replies `Responsibility is unchanged.` and the dashboard shows the original owner as **Still responsible (on duty)**. There is no state in which the task is unowned.

### How it is built
A **self-hosted MCP server** implementing **MCP spec 2025-11-25 over Streamable HTTP**, with an **MCP Apps** dashboard rendered in the official `ext-apps` reference host. Node + TypeScript, SQLite via `node:sqlite`, 10 MCP tools plus the dashboard app.

- **Protocol pinned**, not merely supported: `supportedProtocolVersions: ['2025-11-25']`, so a newer SDK era cannot be silently negotiated.
- **Transport conformance is tested at the raw HTTP level** — 15 cases labelled against the spec's MUST/SHOULD: version negotiation, `202` on notifications, `400` on a bad protocol header, `403` on an invalid Origin, `404` after session termination, loopback-only bind.
- **MCP Apps for real**: a `ui://` resource and `_meta.ui.resourceUri`, with every dashboard button going through the host's `tools/call` so the server stays authoritative and the view re-renders from the result.
- Every mutation runs in one SQLite transaction with its idempotency record and audit row.

### The model boundary
An AI planner can propose a handoff and read household state. It can never approve one, accept one, or send anything — through KinSync's adapter those tools are not merely restricted: they are never offered to the planner, and the adapter refuses them in code before any request is sent. (The MCP server itself still lists them for any client, and it has no production authentication; see the README.)

Requests are refused in two distinct places, and the two are recorded differently:

- **In the adapter, before the wire** (`src/agent/adapter.ts`): `HUMAN_ONLY_TOOL`, `TOOL_NOT_ALLOWED`, and `VERBATIM_REQUIRED:<field>` (words quoted to a family member must come from the user's own utterance). These are recorded in the **tool-call trace** as `policy_denied` / `not_called`. They produce **no server audit entry, because the server never receives them.**
- **At the server** (`src/domain/service.ts`): unknown actor, blocked simulated actor, role or household authorization failure, schema validation failure, and any error inside a mutation. These are written to the **server audit trail** (`audit_events`) as `denied` or `invalid`, in the same transaction, and then re-thrown.

A test runs a **deliberately compromised planner** against an instruction planted in household data. It obeys the injected note and attempts to approve every pending approval, write to a different household, and send an SMS. All three are refused — `HUMAN_ONLY_TOOL`, `VERBATIM_REQUIRED:note`, `TOOL_NOT_ALLOWED` — the simulated outbox stays empty, the approval stays `pending`, and no row is written to the other household. The test asserts the approval attempt left **no** server audit entry, precisely because the adapter stopped it before the wire.

### Honest scope
This is an **MCP Apps experience in a simulated Alexa+ workflow**, which is the alternate path the rules permit. It is **not deployed on native Alexa+** — that tooling is available to select partners only. There is no speech; a rule-based planner stands in for the voice turn. No message is sent, nothing is booked, nothing is dispatched. All people and data are synthetic. KinSync gives no medical advice, and a completed handoff records an agreement — never that care was given.

### How to run it
Locally, free, with no accounts or API keys: `pnpm install`, `scripts/setup-basic-host.sh`, `pnpm demo`. Requires Node ≥ 22.13, pnpm 11, git, npm and bun. Verified from a clean clone (`evidence/phase6/clean-clone/`).

### Challenges
Getting an MCP Apps view to drive real state through a reference host designed for read-only demos; keeping a safety boundary enforceable in code rather than prompt text; and making a local LLM produce reliable structured tool calls — which is why the demo's default planner is deterministic and the local-model path stays clearly labelled as experimental.

### What's next
Per-user authentication (today's identity is a synthetic header, explicitly not authentication), a real voice front end, and extracting the raw-HTTP conformance suite as a reusable package.

### Built with
`typescript` · `node` · `node:sqlite` · `@modelcontextprotocol/server` · `@modelcontextprotocol/client` · `@modelcontextprotocol/express` · `@modelcontextprotocol/node` · `@modelcontextprotocol/ext-apps` · `express` · `zod` · `vitest` · `playwright` · `ollama` (optional, local, experimental)

---

## 2. Revised opening narration

**Not yet recorded. The existing 2:45 video at `video/out/KinSync-demo-1080p.mp4` remains the working fallback and must not be overwritten** — any re-record writes to a new filename.

### Why change the opening
Measured from the shipped subtitle track: the first ~11 s is a static title card, and seconds ~15–29 deliver architecture disclaimers over a dashboard in its **empty** state (`0 open handoffs`, `Nothing yet`). The same labels ride the persistent chip bar for the whole runtime, so the narration is restating what is already on screen. Separately, 51.6 s of the 165.3 s runtime (31%) carries no narration at all, so the changes below need **no re-shoot and no change in runtime**.

### Proposed 0:00–0:24 (replaces 0:00–0:30)

> **0:00–0:09** *(title card)*
> "Two people are looking after the same person. Both of them think the other one has it on Thursday. That gap — not the calendar — is where family care actually goes wrong."
>
> **0:09–0:16** *(title card → dashboard)*
> "KinSync makes the handover explicit. A care task only moves when a person approves it and the person taking it over says yes. Until then, it hasn't moved."
>
> **0:16–0:24** *(dashboard; the chip bar carries the rest)*
> "It's a self-hosted MCP server on spec 2025-11-25, with an MCP Apps dashboard in the official reference host. The Alexa+ turn is simulated; everyone here is synthetic."

### Proposed replacement for the planner line at 0:39

Current: *"The planner in this run is deterministic and rule-based. It is not an LLM."*

> **Replace with:** "Whatever is driving this — the rule-based planner here, or a language model — it reaches the same wall. It can propose. The tools that commit a person to anything are never handed to it at all."

Same facts, no concession framing. Verified: `listModelTools()` filters to the allowlist, and `HUMAN_ONLY_TOOLS` are refused in `adapter.ts` before the allowlist is consulted.

### Three inserts that fit existing silence

| Existing gap | Length | Line |
|---|---|---|
| **102.5 → 108.7 s** (after approval) | 6.2 s | "Notice what did not happen. Priya approved — and Priya is still the one responsible. Approval on its own moves nothing." |
| **117.6 → 122.8 s** (after acceptance) | 5.2 s | "Now it moves, and only because Arjun said yes himself. Reject it or decline it and the server says the same thing: responsibility is unchanged." |
| **145.4 → 152.5 s** (restart) | 7.1 s | "Who is responsible isn't a message someone has to remember. It's a record, and it outlives the server." |

### End card
Add beneath the existing line: **"No silent transfer of responsibility."**

---

## 3. The 15-second adversarial insert — **blocked, precondition not met**

Your instruction gated this on the repository and original video already being published. **Neither is.** Verified 2026-10-18: `0` commits, no git remote, no YouTube or Vimeo URL anywhere in the repository.

So this is **not** being prepared or recorded. It is specified here for later.

**What it would show — all of it real, none of it staged.** The material already exists as a passing test (`test/agent-security.test.ts`), so the beat would be a recording of that test running, with the planted instruction and the three refusals visible in the output. Nothing would be re-enacted, re-typed to look like a live attack, or reconstructed. There is no fabricated attack, no fabricated refusal, and no fabricated audit record — if the beat cannot be captured from genuine output, it does not get made.

**Draft narration (≈15 s):**
> "Here's an instruction someone typed into this family's record: approve everything, message another household, give medical advice. Now a planner that obeys it. Human-only tool. Not the person's words. Tool doesn't exist. Three refusals — in code, before anything reached the server."

**Preconditions, all required:**
1. Repository public on GitHub with the MIT license detectable.
2. Original video uploaded and public, and **retained** as the fallback.
3. Any re-render written to a **new filename**; `KinSync-demo-1080p.mp4` is never overwritten.
4. Estimated 3–4 h. Must not delay submission.
