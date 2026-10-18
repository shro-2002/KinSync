# PoC-0 Report: MCP over Streamable HTTP at protocol 2025-11-25

- **Date:** 2026-10-10 (IST evening; timestamps in evidence are UTC)
- **Verdict:** **PASS.** Every required criterion passes. Two items are not done, and both are explicitly out of scope or SHOULD-level (see §4).
- **Scope respected:** no UI, agent, voice, MCP Apps, purchasing, AWS, LLM calls, or paid services. No deploy, publish, or submit. No custom protocol handler; everything runs through official SDK classes. Synthetic data only.

## 1. Environment and versions (verified)

| Item | Version |
|---|---|
| Node.js | 26.3.0 (`node:sqlite` built in; no native SQLite dependency) |
| pnpm | 11 |
| `@modelcontextprotocol/server` | 2.3.1 (Apache-2.0) |
| `@modelcontextprotocol/client` | 2.3.1 (Apache-2.0) |
| `@modelcontextprotocol/node` | 2.1.1 |
| `@modelcontextprotocol/express` | 2.0.2 |
| `@modelcontextprotocol/inspector` | 2.10.1 (via `npx`, not a project dependency) |
| express / zod | 5.3.0 / 4.6.5 |
| typescript / tsx / vitest | 7.0.2 / 4.23.15 / 5.0.3 |

All versions are pinned exactly in `package.json`, and `pnpm-lock.yaml` is present.

## 2. SDK inspection findings (step 1)

Source: the `modelcontextprotocol/typescript-sdk` main branch, read via `gh api`.

1. The v2 packages are `server`, `client`, `core`, `middleware`, and `server-legacy`, plus the framework adapters `@modelcontextprotocol/node`, `express`, and `hono`. Exports verified locally: `server` → `. ./stdio ./validators/*`; `client` → the same; `node`/`express` → `.`.
2. **v2 is "dual-era".** The *modern* era is 2026-07-28. The *legacy* era is the 2025 `initialize` handshake. `packages/core/src/constants.ts` has `LATEST_PROTOCOL_VERSION = '2025-11-25'`. The examples README says to "Add `-- --legacy` to the client command for the 2025-era handshake."
3. **Client:** `versionNegotiation.mode` defaults to `'legacy'` per the `.d.ts` (`@default 'legacy'`). It is set explicitly in `src/client.ts`.
4. **Server pattern chosen:** the official "sessionful 2025" pattern from `examples/standalone-get/server.ts`: one `McpServer` plus one `NodeStreamableHTTPServerTransport` per session, behind `createMcpExpressApp()`. I avoided `createMcpHandler` because it serves 2026-07-28 by default.
5. **Pin:** `new McpServer(info, { supportedProtocolVersions: ['2025-11-25'] })`.
6. **Origin:** `createMcpExpressApp()` binds to 127.0.0.1 and enables Host and Origin validation by default. A present non-localhost `Origin` gets 403; an absent `Origin` passes (from the `.d.ts` docs, then verified by test).

## 3. Acceptance criteria

| # | Criterion | Spec basis (2025-11-25) | Result | Evidence |
|---|---|---|---|---|
| AC1 | TS project initialized with a root MIT LICENSE and README | — | **PASS** | `LICENSE`, `README.md` |
| AC2 | Exactly one MCP tool, `log_event({kind, note})`, storing synthetic events in SQLite | — | **PASS** | `tools/list` → `["log_event"]`: e2e test 1, `03-client-log.txt`, `06-inspector-cli.txt` |
| AC3 | Input validated at the boundary (bad `kind` or empty `note` rejected, nothing stored) | — | **PASS** | e2e test "rejects invalid log_event input" |
| AC4 | Independent client: initialize, list tools, call `log_event` | — | **PASS** | `03-client-log.txt` (pid 42456, session `0492bbaf…`) |
| AC5 | A fresh client process reads the persisted event after a **server restart** | — | **PASS** | `02-server.log` (server pids 42406 → 42514), `04-client-find-fresh-process.txt` (client pid 42562, new session `ad99db53…`, `found` = NONCE-E1); e2e test "persists events to disk" |
| AC6 | Negotiated protocol version is `2025-11-25` | lifecycle: version negotiation | **PASS** | `negotiatedProtocolVersion` in 03/04; curl A shows `"protocolVersion":"2025-11-25"`; conformance test |
| AC7 | Server counter-offers a supported version when asked for an unsupported one | lifecycle: server MUST respond with another version it supports | **PASS** | conformance test: request `2099-01-01` gets `2025-11-25` |
| AC8 | Client sends `MCP-Protocol-Version: 2025-11-25` on all post-init requests | transports: client MUST | **PASS** | `wire` array in 03 (all five post-init requests); e2e test 2 |
| AC9 | Client sends `Accept: application/json, text/event-stream` on POST | client MUST | **PASS** | `wire` in 03 |
| AC10 | POST of a request returns `application/json` or `text/event-stream` | server MUST | **PASS** | observed `text/event-stream`; conformance test |
| AC11 | An accepted notification returns 202 with no body | server MUST | **PASS** | `wire[1]` status 202; conformance test |
| AC12 | GET returns `text/event-stream` or 405 | server MUST | **PASS** | observed 200 + `text/event-stream` (`wire[2]`); conformance test |
| AC13 | Invalid `MCP-Protocol-Version` gets 400 | server MUST | **PASS** | curl D → `400 Bad Request`; conformance test |
| AC14 | A present, invalid `Origin` gets 403 | server MUST | **PASS** | curl B → `403 Forbidden`; conformance test |
| AC15 | Localhost bind | server SHOULD | **PASS** | URL `127.0.0.1`; conformance test |
| AC16 | Session ID is visible ASCII 0x21–0x7E (conditional: only if one is assigned) | MUST if assigned | **PASS** (session assigned: yes, UUID) | conformance test (observed `true`) |
| AC17 | Non-init request without a session ID gets 400 (conditional: server requires sessions) | SHOULD | **PASS** | curl C → 400; conformance test |
| AC18 | After DELETE, the same session ID gets 404 (conditional: DELETE not 405) | MUST | **PASS** (DELETE was 200) | curl E: `DELETE -> 200`, `reuse -> 404`; conformance test |
| AC19 | MCP Inspector can list, call, and read | — | **PASS** (CLI mode) | `06-inspector-cli.txt`: three calls, exit 0, NONCE-I1 round-trips |
| AC20 | Automated tests | — | **PASS**: 20/20 | `01-vitest.txt` |
| AC21 | Typecheck clean | — | **PASS** | `pnpm typecheck` (tsc 7, strict) |
| AC22 | Friction log of real issues | — | **PASS** | `docs/FRICTION_LOG.md` (8 entries) |

How the conditional rules were tested: each test branches on what the server actually did (was a session assigned? was DELETE answered with 405?) and asserts the rule that applies to that branch. It records the branch taken (`[observed] …` lines in `01-vitest.txt`) instead of hardcoding a status code.

## 4. Not done, or not proven

| Item | Status | Why / next step |
|---|---|---|
| Authentication | **NOT DONE** (spec: servers SHOULD implement it) | Out of PoC-0 scope. Required before any non-localhost exposure. |
| Inspector **web UI** | Not run | The CLI mode of the same Inspector release was used. The web UI needs an interactive browser session; offered as an optional extra. |
| Inspector's negotiated version | **Inferred**, not observed | The CLI doesn't print it. The server supports only `2025-11-25`, and a session can only be created through `initialize`, so any successful Inspector session must have negotiated `2025-11-25`. |
| Absent `Origin` accepted | SDK default; the spec is silent | Fine for CLI and server clients. Browser clients always send `Origin`, so the allowlist governs them. |
| Unknown, never-issued session ID → 404 | Informative only | The spec defines 404 only for *terminated* sessions. Observed 404 is acceptable. |

## 5. Deviations from plan

- **CLI split:** the client CLI moved from `src/client.ts` to `src/cli.ts` after the tsx entry-guard bug (FRICTION F-05). The architecture is unchanged.
- **Read path is an MCP resource**, `careloop://events/recent`, not a second tool. This keeps "one tool" literal while letting a fresh process read through MCP instead of reading the DB file directly.
- No other deviations. There was no fallback to SDK 1.x and no custom handler.

## 6. Reproduce

```bash
pnpm install
pnpm typecheck
pnpm test --reporter=verbose                       # → 20 passed

pnpm server &                                      # terminal 1
pnpm client log medication "synthetic: took morning pills NONCE-X"
kill %1 && pnpm server &                           # restart server
pnpm client find NONCE-X                           # fresh process; exit 0 and "found" populated

# Spec checks by hand (server running)
U=http://127.0.0.1:3333/mcp
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
curl -si -X POST $U -H 'origin: https://evil.example' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$INIT"   # 403

# Inspector
MCP_CATALOG_PATH=/tmp/inspector.json npx -y @modelcontextprotocol/inspector@2.10.1 --cli $U --method tools/list
```

The full curl script is `evidence/05-curl-headers.sh` (re-run on the same date: same status codes); its output is `evidence/05-curl-headers.txt`.

## 7. Side effects outside the repo

- `~/.mcp-inspector/storage` was created by the Inspector's first `--help` run (FRICTION F-06). It is safe to delete.
- The pnpm store and npx cache were populated. Nothing was published, deployed, or pushed. The git repo is initialized locally with **no commits**.

## 8. Implications for the build

1. Keep the sessionful 2025 pattern and the version pin. Show `MCP-Protocol-Version: 2025-11-25` in the demo's protocol panel.
2. The browser host will need its origin allowlisted. `createMcpExpressApp({ allowedOrigins })` exists; untested.
3. MCP Apps (PoC-1) is the next unknown. Inspector 2.10.1 has `--app-info` and `--advertise-apps` flags that can help verify `ui://` resources headlessly. [U]
