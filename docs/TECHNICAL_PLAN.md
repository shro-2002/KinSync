# Technical Plan: CareLoop (working title)

Legend: **[V]** verified · **[A]** assumption · **[U]** untested. **Nothing is installed or built yet.**

## 1. Architecture

```
 Browser "simulated Alexa+-style" host (Path B)            Self-hosted MCP server (Path A)
 ┌───────────────────────────────────────────┐   HTTP POST/GET /mcp   ┌──────────────────────────────┐
 │ Web Speech STT ─► host agent loop (LLM) ──┼──────────────────────►│ Streamable HTTP, 2025-11-25  │
 │      ▲            │ tools/list, tools/call │  MCP-Protocol-Version │ Origin check, session id     │
 │ Web Speech TTS ◄──┘                        │  MCP-Session-Id       │ tools: log_event, get_status,│
 │ MCP Apps iframe ◄── ui:// care dashboard   │◄──────────────────────│  check_adherence, plan_refill│
 │ Protocol inspector panel (shows JSON-RPC)  │                       │  draft_message, notify_duty, │
 └───────────────────────────────────────────┘                        │  confirm_cart (simulated)    │
                                                                      │ SQLite household ledger      │
                                                                      └──────────────────────────────┘
```

- **The server is the product.** It is a real Alexa+-compatible add-on surface: 2025-11-25, Streamable HTTP, and MCP Apps, all of which Alexa+ supports [V] S12.
- **The web host proves it.** It is a real MCP client, as the FAQ explicitly allows [V] S3. It shows the raw JSON-RPC in a side panel so Stage 1 reviewers can see `initialize`, `tools/list`, and `tools/call` [A].
- **Tool design follows the Alexa+ MCP design guide** [V excerpt] S13 S14: one customer intent per tool, minimal input schemas, explicit structured errors, and data-shaped responses (Alexa generates the speech from returned data).
- **Purchasing is simulated** with two steps: `prepare_refill_cart` then `confirm_cart`, gated on explicit confirmation. No real payments. [A]

## 2. Minimal runnable MCP server (target shape, untested)

- Package: `@modelcontextprotocol/server` 2.x + `@modelcontextprotocol/express` (or `/node`) for Streamable HTTP [V packages exist S10] [U exact API].
- Endpoint `POST|GET|DELETE /mcp` on `127.0.0.1:3333`, with an allowlisted Origin.
- One tool to start: `log_event({kind, note})` returns `{ok, event_id, summary}`.
- Check before writing code: v2 package API names, using the repo README and examples (the docs-lookup step). The fallback is `@modelcontextprotocol/sdk` 1.32.1 (`McpServer` + `StreamableHTTPServerTransport`) [U whether 1.32.1 negotiates 2025-11-25; read the constants first].

## 3. Real MCP client

- Phase 1: Node script using `@modelcontextprotocol/client` `StreamableHTTPClientTransport`. It runs `initialize`, `tools/list`, and `tools/call` and prints the negotiated `protocolVersion`.
- Phase 2: the same client in the browser, which needs CORS plus Origin allowlisting on the server.
- Independent cross-check: `@modelcontextprotocol/inspector` 2.10.1 pointed at `/mcp` [V package exists].

## 4. Smallest proof-of-concept experiment (PoC-0, about 2 hours)

**Hypothesis:** a v2 TS SDK server and client negotiate `2025-11-25` over Streamable HTTP locally, and a raw `curl` from a forbidden Origin is rejected.

**Pass criteria (all observable):**
1. The client prints `protocolVersion: "2025-11-25"` and lists one tool.
2. `tools/call log_event` returns structured content, and a second call in a new process reads the persisted row (proves state across sessions).
3. `curl -H 'Origin: https://evil.example' -X POST /mcp …` returns `403`.
4. `curl` without the `MCP-Session-Id` header after init returns `400` (if sessions are enabled).
5. The Inspector connects and lists the tool.

**Fail means:** drop to SDK 1.32.1 and repeat. If 2025-11-25 still isn't negotiated, write a thin spec-conformant handler by hand (JSON response mode only, which the spec permits [V] S5).

PoC-1 (Day 2–3): register one `ui://` MCP Apps resource and render it in a minimal host iframe. If that fails within half a day, fall back to cards rendered by the web host from `structuredContent`.

## 5. Build plan (about 13 days)

| Days | Milestone | Exit check |
|---|---|---|
| D1 (Oct 11) | PoC-0; repo and LICENSE; start the friction log | 5 pass criteria |
| D2–3 | Domain model + 6–7 tools + SQLite + tests | `vitest` green; Inspector calls every tool |
| D3–4 | PoC-1 MCP Apps card; browser MCP client + JSON-RPC panel | The card renders in the host |
| D5–6 | Host agent loop (Bedrock or Anthropic) + Web Speech; deterministic mock-host mode | The demo script runs end to end, both modes |
| D7 | Agent Skill (`skills/careloop/SKILL.md`) + optional Bedrock/Strands docs for AWS Builder | Skill loads in an agent client |
| D8 | Open-source spin-off repo `mcp-voice-host` (MIT) | Separate public repo |
| D9–10 | Polish, error paths, README, architecture diagram, judge run instructions (`pnpm i && pnpm demo`) | Fresh clone runs in under 5 minutes |
| D11 | Record and edit the video (≤ 2:45) | Public on YouTube |
| D12 | Devpost text, product feedback, friction log, feature requests; add reviewer invites if private | Draft saved |
| D13 (Oct 23 by 08:00 PT) | Submit with a 4-hour buffer | Confirmation email |

## 6. Credentials and costs to settle (needs your decision)

- LLM provider: **Bedrock** (qualifies for AWS Builder; needs AWS creds and model access; `aws` CLI missing) **or the Anthropic API** (simpler; no AWS mini). [A]
- No other paid services. ngrok is optional. No hosting is required [V] S3.

## 7. Top risks

1. **Spec-version negotiation drift.** The SDKs now know 2026-07-28 [V] S9. A misnegotiated version could fail Stage 1. Mitigation: pin the version and show it on screen.
2. **MCP Apps rendering in a custom host** [U]. Mitigation: timeboxed PoC-1 with a fallback.
3. **Health framing.** Mitigation: logistics only, synthetic data, a disclaimer.
4. **Solo time.** Mitigation: freeze scope on D6; mock-host mode guarantees a working demo.
