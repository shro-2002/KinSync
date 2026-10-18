# PoC-1 Report: MCP Apps integration

- **Date:** 2026-10-11 (IST); evidence timestamps are UTC.
- **Timebox:** 4 h max. Actual active effort was about 1.5 h.
- **Fallback used:** **No.** A genuine MCP App rendered in the official reference host, so the structured-data fallback was not needed.
- **Verdict:** **GO for MCP Apps.** Conditions and risks are in §7.

Scope respected: no LLM, no paid APIs, no deployment, no publishing, no git commits, synthetic data only. Existing protocol and security tests were not weakened (§5).

## 1. What I inspected

| Source | Finding |
|---|---|
| `modelcontextprotocol/ext-apps` `specification/2026-01-26/apps.mdx` (SEP-1865) | Extension ID `io.modelcontextprotocol/ui`. A UI resource MUST use the `ui://` scheme and the MIME type `text/html;profile=mcp-app`, and MUST be a complete HTML5 document in `text` or `blob`. A tool links to it through `_meta.ui.resourceUri`; the flat `_meta["ui/resourceUri"]` key is deprecated. The host MUST fetch the resource with `resources/read`. A web host MUST use a sandbox proxy on a *different origin* (`allow-scripts allow-same-origin`). The view handshakes with `ui/initialize`, then receives `ui/notifications/tool-input` and `ui/notifications/tool-result`. If `ui.csp` is omitted, the host MUST apply a restrictive CSP (`connect-src 'none'`). Servers SHOULD check the client's `io.modelcontextprotocol/ui` capability and SHOULD provide a text-only fallback. |
| `@modelcontextprotocol/ext-apps@2.0.3` (MIT) | Server helpers `registerAppTool`, `registerAppResource`, and `RESOURCE_MIME_TYPE` (`= "text/html;profile=mcp-app"`) come from `/server`. The view class `App` (`connect`, `ontoolresult`, `callServerTool`, `readServerResource`, `autoResize`) comes from the main entry. The host side (`AppBridge`, `PostMessageTransport`, `getToolUiResourceUri`) comes from `/app-bridge`. Peer deps: client/server `^2.0.0`, zod `^4.2.0`. |
| `examples/basic-server-vanillajs` | The canonical pattern: `registerAppTool(..., { _meta: { ui: { resourceUri } } })` plus `registerAppResource(...)` that returns a single-file bundled HTML. It registers **unconditionally** (no capability check). |
| `examples/basic-host` @ `82221c0c8ce7661efa6771c9d461511b1650495f` | The official reference host (React, `AppBridge`). The host page is on `:8080`; the sandbox proxy is on `:8081` with CSP set by HTTP header. It discovers the UI with `getToolUiResourceUri(tool)` and then `client.readResource({ uri })`. |

## 2. What was built

| Piece | File | Notes |
|---|---|---|
| App tool `show_care_dashboard` | `src/server.ts` | `registerAppTool`, `_meta.ui.resourceUri = ui://careloop/dashboard.html`, read-only. It returns `structuredContent` (household, generatedAt, total, counts, events) plus a text `content` fallback. |
| UI resource | `src/server.ts` | `registerAppResource`, MIME type `RESOURCE_MIME_TYPE`. Serves `dist/ui/dashboard.html` and returns an explicit error if the UI has not been built. |
| View | `src/ui/dashboard.{html,ts}` | ext-apps `App`. It renders from `ontoolresult`; Refresh calls `app.callServerTool`, which goes through the host. It renders with `textContent` only (no HTML injection) and does no direct network calls. Accessible: `role="status"`, `aria-live`, `scope` on table headers, focus ring. |
| Bundler | `scripts/build-ui.ts` | esbuild produces a single-file HTML (no vite). |
| CORS allowlist | `src/server.ts` | Opt-in through `CARELOOP_CORS_ORIGINS`. It runs *after* Origin validation, exposes `mcp-session-id`, and is off by default. |
| Host | `hosts/ext-apps` (gitignored), `scripts/setup-basic-host.sh` | The official basic-host at a pinned SHA, with **upstream source unmodified**. The setup script was verified from a clean directory. |
| Automated render check | `scripts/verify-render.ts` (`pnpm verify:render`) | Playwright 1.61.0 with the cached Chromium. It starts the server and host, drives the browser, and asserts. |

The core MCP protocol stays pinned to **2025-11-25**. The MCP Apps spec version (2026-01-26) versions the *extension*, not the core protocol.

## 3. Required PASS/FAIL

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | **Genuine MCP Apps resource registration** | **PASS** | Official `registerAppTool` and `registerAppResource`. Tests: `_meta.ui.resourceUri` read with the official `getToolUiResourceUri` helper; the URI starts with `ui://`; the MIME type is exactly `text/html;profile=mcp-app`; the body is a full HTML5 document containing the `ui/initialize` handshake. MCP Inspector 2.10.1 `--app-info` reports `{"hasApp":true,"resourceUri":"ui://careloop/dashboard.html","resourceMimeType":"text/html;profile=mcp-app"}` and `hasApp:false` for `log_event`. Evidence: `31-vitest-full.txt`, `20-inspector-app-info.txt`. |
| 2 | **Resource discovery over MCP** | **PASS** | The browser host's own wire traffic (captured by Playwright) shows `initialize` → `tools/list` → `resources/list` → `tools/call show_care_dashboard` → `resources/read ui://careloop/dashboard.html`. No local HTML import: the host is a separate upstream project that only knows the server URL. Evidence: `12-verify-render.json` (`sentMethods`), plus the manual DevTools capture of the `resources/read` response body (MIME type and HTML). |
| 3 | **Rendering in a compatible host** | **PASS** | Official ext-apps `basic-host`. The view runs inside the sandbox proxy iframe (`:8081`, a different origin from the host page `:8080`), as the spec requires for web hosts. Evidence: `01-rendered-initial.jpg` (manual), `10-verify-initial.png` (automated). Check: "view rendered inside a sandbox iframe". |
| 4 | **Real data displayed** | **PASS** | The view shows the exact rows inserted into SQLite, delivered by the host through `ui/notifications/tool-result` (the status line reads "via host tool-result notification"). Automated check: "view shows the events stored in SQLite". |
| 5 | **Data updates reflected** | **PASS, pull-based** | An independent MCP client (separate session) calls `log_event`. The view's Refresh goes app → host → `tools/call` on the server, and the new row appears with total 2→3 and a new `symptom` count. Evidence: `02-rendered-after-log-event-refresh.jpg`, `11-verify-after-refresh.png`; checks "new log_event visible after view Refresh" and "refresh went app -> host -> tools/call". **No live push:** the update needs a refresh (see §7). |
| 6 | **PoC-0 regression suite** | **PASS** | 31/31 (the 20 PoC-0 tests plus 11 new). One deliberate expectation change (§5). The PoC-0 curl security script was re-run against the PoC-1 server with CORS enabled and gave identical results. Evidence: `31-vitest-full.txt`, `32-curl-security-rerun.txt`, `30-typecheck.txt`. |
| 7 | **Security behavior** | **PASS, with noted gaps** | Foreign Origin still gets **403**, including preflights and including when that origin is wrongly added to the CORS list (the test proves CORS cannot widen access). CORS is granted only to allowlisted origins; there are no CORS headers by default. The view embeds no server address and declares no CSP `connectDomains`. Session, protocol-version, and DELETE behavior are unchanged. Gaps: no authentication (as in PoC-0), and the reference host's CSP is looser than the spec (§6). |

Extra observed checks (automated):

| Check | Result |
|---|---|
| Browser host requested protocol `2025-11-25` in `initialize` | PASS (observed, not inferred) |
| Browser host sent `MCP-Protocol-Version: 2025-11-25` on every post-init request | PASS |

`pnpm verify:render` result: **8/8 checks passed** (`13-verify-render-console.txt`).

## 4. Tests added

`test/mcp-apps.test.ts` (11 tests):

- **Registration and discovery:** resource URI from the official helper; `resources/list` contains the URI; `resources/read` MIME type and HTML5 document; no direct network path (no `connectDomains`, no server address).
- **Data flow:** `log_event` is reflected in the next `show_care_dashboard` call; the session is still at 2025-11-25.
- **CORS security:** allowlisted preflight; exposed `mcp-session-id`; a non-allowlisted localhost origin gets no grant; a foreign origin gets 403 even if mistakenly allowlisted; no allowlist means no headers.

`scripts/verify-render.ts`: the browser end-to-end check (8 assertions). It is not part of `pnpm test` because it needs the external host; run it with `pnpm verify:render`.

## 5. Changes to existing PoC-0 tests (exact)

One expectation changed, in two places. The tool-set assertion moved from `['log_event']` to the shared constant `EXPECTED_TOOLS = ['log_event', 'show_care_dashboard']`:
- `test/e2e.test.ts`: test renamed from "…exposes exactly one tool" to "…exposes exactly the expected tools".
- `test/conformance.test.ts`: in "POST of a JSON-RPC request returns application/json or text/event-stream (MUST)", only the secondary tool-name sanity line changed. The content-type MUST assertion is untouched.

Before the change, the unchanged suite produced exactly those 2 failures and 18 passes; every protocol and security assertion passed (`00-poc0-suite-before-expectation-update.txt`). The assertion is still exact equality (`toEqual`). No protocol, version, Origin, session, or header assertion was modified. `test/helpers.ts` gained an optional `corsOrigins` parameter; the default `[]` preserves PoC-0 behavior.

## 6. Observations and risks (details in FRICTION_LOG F-09 … F-17)

1. **Spec vs. reference host on capability negotiation (F-12).** The spec says servers SHOULD gate UI tools on the client advertising `io.modelcontextprotocol/ui`. The reference host sends `capabilities.extensions = null`. Following the SHOULD would hide the App from the official host, so PoC-1 registers unconditionally, like the official example, with a text fallback.
2. **Reference-host CSP is looser than the spec default (F-13).** basic-host allows `'unsafe-eval'` and `connect-src 'self'`. Our security does not depend on host CSP.
3. **Duplicate calls in basic-host's dev build (F-14).** `tools/call` and `resources/read` each run twice per load. UI-linked tools must stay idempotent.
4. **CORS is required for browser hosts (F-15)**, and the docs don't mention it.
5. **Bundle size is 589 KiB (F-16).** It works, but a device-facing view should be slimmer.
6. **Updates are pull-based.** The view reflects new data only on Refresh or a re-call. Live push would need `notifications/resources/updated` or a host-driven re-call.
7. **The Alexa+ link is unverified.** Alexa+ says it supports MCP Apps (docs, research phase), but no participant can test on Alexa+ (FAQ). Rendering is proven only in the reference host.

## 7. Verdict: **GO for MCP Apps**

The integration is real, discovered over MCP, rendered in the official compatible host, data-driven, and regression-safe. The fallback is not needed.

Conditions to carry into the build:
1. Keep UI tools read-only or idempotent (F-14).
2. Decide the capability-gating policy explicitly before submission (F-12). Recommended: keep it unconditional, and document why in the README so judges see it was deliberate.
3. Trim the view bundle (F-16) before the final demo.
4. Demo story: say "rendered in the official MCP Apps reference host", not "in Alexa+".

## 8. Reproduce

```bash
pnpm install
pnpm typecheck && pnpm test                 # 31 passed
scripts/setup-basic-host.sh                 # official basic-host @ 82221c0 → hosts/ext-apps
pnpm verify:render                          # 8/8; writes evidence/poc1/10..13
# Inspector app probe (server running):
MCP_CATALOG_PATH=/tmp/insp.json npx -y @modelcontextprotocol/inspector@2.10.1 --cli http://127.0.0.1:3333/mcp --method tools/list --app-info
```

## 9. Evidence index (`evidence/poc1/`)

| File | Content |
|---|---|
| `00-poc0-suite-before-expectation-update.txt` | Unchanged PoC-0 suite against the PoC-1 server: 2 expected tool-list failures, 18 passes |
| `01-rendered-initial.jpg`, `02-rendered-after-log-event-refresh.jpg` | Manual run in the browser pane |
| `10-verify-initial.png`, `11-verify-after-refresh.png` | Automated Playwright screenshots |
| `12-verify-render.json` | Check results and every JSON-RPC method, URI, protocol version, and header the host sent |
| `13-verify-render-console.txt` | `pnpm verify:render` console output (8/8, plus the INFO line on extensions) |
| `20-inspector-app-info.txt` | MCP Inspector `--app-info` probes |
| `30-typecheck.txt`, `31-vitest-full.txt` | Typecheck and the full 31-test run |
| `32-curl-security-rerun.txt` | PoC-0 curl security script plus CORS preflights, re-run on the PoC-1 server |

## 10. Side effects outside the repo

- The npm cache was populated for basic-host deps, and npx downloaded Inspector 2.10.1.
- A verification copy of basic-host was left in the session scratchpad (a safety hook blocked deleting it). It is outside the project.
- No git commits, pushes, deploys, or publishes.
