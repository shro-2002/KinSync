# Friction Log

Only problems I actually hit are logged here; none are hypothetical. Severity scale: **Blocker**, **High**, **Medium**, **Low**. This log feeds the optional Devpost friction-log field, which can add up to a 10% bonus.

## At a glance (status as of Phase 6A, 2026-10-14)

Status key: **Fixed** (changed in this repo), **Workaround** (in place, root cause elsewhere), **Open** (still affects us or upstream), **Noted** (no action needed). "Who should act" is where the real fix belongs.

| ID | Problem (short) | Severity | Status | Who should act / next step |
|---|---|---|---|---|
| F-01 | MCP TS SDK v2 defaults hide the 2025-11-25 sessionful path | Medium | Workaround (protocol pinned) | Hackathon docs: say which protocol versions count |
| F-02 | npm "certificate has expired" once | Low | Noted (retry worked) | - |
| F-03, F-38 | `devEngines` makes `npx` fail; use `pnpm exec` | Low | Workaround | pnpm/npm: clearer error |
| F-04, F-46 | pnpm 11 blocks esbuild's build script; on a fresh clone `pnpm install` exits 1 | Medium | Fixed (`pnpm-workspace.yaml`: `allowBuilds: { esbuild: false }`) | pnpm: make an ignored, non-essential build a warning |
| F-05 | CLI entry guard silently skipped under tsx | Medium | Fixed | - |
| F-06 | Inspector CLI ignores URL with `--catalog` | Low | Workaround (`MCP_CATALOG_PATH`) | Inspector maintainers |
| F-07 | Alexa+ docs disagree about access | Medium | Open | Amazon: preview banner on add-on pages; it is why the demo is a *simulated* Alexa+ workflow |
| F-08 | Devpost returns 403 to non-browser fetchers | Low | Workaround (browser) | Devpost: text/PDF rules mirror |
| F-09..F-11 | Reference host standalone install/build/sandbox issues | Medium | Workaround (`scripts/setup-basic-host.sh`) | ext-apps: standalone-install docs |
| F-12 | Reference host never advertises the UI capability | Medium | Open | ext-apps / spec |
| F-13 | Reference host sandbox CSP looser than spec default | Low | Open (we rely on our own resource, not host CSP) | ext-apps |
| F-14 | Host dev build duplicates calls | Low | Mitigated (UI tools idempotent / read-only) | ext-apps |
| F-15 | Browser hosts need CORS; undocumented | Medium | Workaround (allowlist) | MCP Apps docs |
| F-16 | View bundle ~600 KiB | Low | Open (acceptable for demo) | Us, if size matters |
| F-17 | Playwright/Chromium build matching | Low | Workaround (documented) | - |
| F-18, F-36 | Browser hosts can't send identity headers; one session = one person | Medium | Workaround (default actor; labeled simulated-actor demo mode) | MCP Apps: per-user auth for views; production needs OAuth |
| F-19, F-23 | SDK schema rejections skip domain audit; no validation hook | Medium | Fixed (`domainValidated`) | SDK: documented validation hook |
| F-20 | zod strips unknown keys | Low | Noted (impersonation args ignored) | - |
| F-21 | Inspector exits 5 on `isError` | Low | Noted | - |
| F-22 | Vitest picked up evidence snapshots | Low | Workaround (renamed) | - |
| F-24 | Unknown tool name is a thrown error | Low | Mitigated (adapter denies first) | - |
| F-25 | Event heuristic merged real reports | High | Fixed | - |
| F-26 | Host-facing tool descriptions unsafe for models | Medium | Fixed (model-facing descriptions) | - |
| F-27 | Claude API defaults vs cost control | Medium | Fixed (no retries) | - |
| F-28 | tsx scripts outside package ran as CommonJS | Low | Workaround | - |
| F-29 | Live-eval allowed multi-case runs | Medium | Fixed | - |
| F-30, F-31 | Local model sends names / empty strings | Medium | Fixed (roster resolution, empty-string normalization) | - |
| F-32 | Output-safety false positive on "no report yet" | Medium | Fixed | - |
| F-33 | Ollama cold load ~17 s | Low | Noted (warm the model before recording) | - |
| F-34 | Local model sends `occurred_at: "now"` | Medium | Open by choice (fails closed) | Prompt tuning |
| F-35, F-41 | Small local model doesn't chain multi-step plans; n=1 handoff success | Medium | Open (deterministic planner is the default) | Larger model / prompt work |
| F-37 | Tool-count assertions changed when tools were added | Low | Noted | - |
| F-39 | Subprocess test flakes under heavy load | Low | Open (passes on re-run) | Us: raise the 5 s timeout if it recurs |
| F-40 | macOS `sed -i` silently no-op in a mutation check | Low | Workaround (Python) | - |
| F-42 | `position: sticky` misbehaves in an auto-sized MCP Apps iframe | Low | Fixed (removed sticky) | ext-apps docs: note on iframe sizing |
| F-43 | Rota-dependent story breaks on some weekdays with a real clock | Medium | Fixed (labeled demo clock) | - |
| F-44 | Evidence logs contained a local home-directory path | Low | Fixed in Phase 6A (13 files sanitized; unmodified originals kept outside the repo) | - |
| F-45 | Name-pattern stop hit wrappers; a restart check was a false positive | Medium | Fixed (exact-PID SIGTERM, SIGTERM handler, new-PID proof) | - |

---

### F-01: MCP TypeScript SDK v2 defaults look "modern" (2026-07-28); the 2025-11-25 path is easy to miss
- **Tool:** `@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/client` 2.3.1
- **Task:** Build a Streamable HTTP server that the hackathon rules accept (spec 2025-11-25).
- **Steps:** Read the SDK `examples/README.md` and the `tools/` example.
- **Expected:** A clear single path for "serve spec 2025-11-25".
- **Actual:** The SDK is "dual-era". The canonical example uses `createMcpHandler`, which serves 2026-07-28 traffic per request and 2025 traffic statelessly. The 2025 handshake is opt-in on the client (`versionNegotiation: { mode: 'legacy' }`, which the `.d.ts` documents as the default). Sessionful 2025 serving appears only in the `standalone-get` and `sse-polling` examples. The hackathon rules say only "2025-11-25 or later, once confirmed".
- **Severity:** Medium. It could cause a Stage 1 failure if someone ships modern-only traffic.
- **Workaround:** Followed the `standalone-get` pattern (`NodeStreamableHTTPServerTransport` + `createMcpExpressApp`) and set `supportedProtocolVersions: ['2025-11-25']` on `McpServer`.
- **Suggestion:** Hackathon resources should state explicitly that 2026-07-28 traffic does or does not count, and link a "2025-11-25 sessionful server" quickstart.

### F-02: npm registry fetch failed with "certificate has expired" during install
- **Tool:** pnpm 11 against registry.npmjs.org
- **Task:** `pnpm add -D typescript tsx vitest @types/express @types/node`
- **Expected:** Clean install.
- **Actual:** `ECONNRESET` retries, then `ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/obug: certificate has expired`. A `curl -I` to the same URL a minute later returned HTTP/2 200.
- **Severity:** Low (transient).
- **Workaround:** Re-ran the same command; it succeeded.
- **Suggestion:** None for Amazon. Recorded for reproducibility.

### F-03: `pnpm init` adds `devEngines.packageManager`, which breaks `npx`
- **Tool:** pnpm 11 and npm 11.16
- **Task:** `npx tsx -e …` to smoke-test tsx.
- **Actual:** `npm error EBADDEVENGINES Invalid name "pnpm" does not match "npm" for "packageManager"`.
- **Severity:** Low.
- **Workaround:** Use `pnpm exec` and `pnpm <script>`.

### F-04: pnpm 11 blocks esbuild's build script (`ERR_PNPM_IGNORED_BUILDS`)
- **Task:** Install `tsx` and `vitest`.
- **Actual:** pnpm printed `Ignored build scripts: esbuild@0.28.2` and exited with an error-styled message.
- **Severity:** Low. tsx and vitest still work, because the platform binary comes from an optional dependency.
- **Workaround:** None needed. I did not run `pnpm approve-builds`.

### F-05: The CLI entry-point guard silently did nothing under tsx
- **Task:** Run `src/client.ts` as both a library and a CLI.
- **Actual:** The `import.meta.url === \`file://${process.argv[1]}\`` guard never matched under `tsx`. In a test, argv was `/tmp/argv.ts` while the URL was `file:///private/tmp/argv.ts`. The client exited 0 and printed nothing.
- **Severity:** Medium (silent no-op).
- **Workaround:** Moved the CLI into its own entry file (`src/cli.ts`) with no guard.

### F-06: MCP Inspector CLI with `--catalog <new file>` ignores the positional server URL
- **Tool:** `@modelcontextprotocol/inspector` 2.10.1 (`--cli`)
- **Task:** Run Inspector without writing to `~/.mcp-inspector`.
- **Steps:** `npx -y @modelcontextprotocol/inspector@2.10.1 --cli --catalog <scratch>/inspector-catalog.json http://127.0.0.1:3333/mcp --method tools/list`
- **Expected:** It connects to the URL, as it does without `--catalog`.
- **Actual:** `{"error":{"code":"error","message":"No servers found in config file"}}`, exit 1, for all three methods.
- **Severity:** Medium (confusing error, and the docs suggest the flag is equivalent to the env var).
- **Workaround:** Set `MCP_CATALOG_PATH=<scratch>/inspector-catalog2.json` and drop `--catalog`. All calls then succeeded. Note: the earlier `--help` invocations had already created `~/.mcp-inspector/storage`.
- **Suggestion:** Treat a positional target as authoritative even when `--catalog` is passed, or say so in the help text.

### F-07: Alexa+ docs disagree about access (research phase)
- **Tool:** Alexa+ MCP Toolkit docs vs. the hackathon FAQ.
- **Actual:** The toolkit overview page says only "available in the United States". The hackathon FAQ says the toolkit, CLI, and Web Simulator are "select partners only". The FAQ itself admits individual setup pages omit this.
- **Severity:** Medium. A participant could lose hours trying to onboard.
- **Suggestion:** Add a preview/partner-only banner to every add-on page.

### F-08: Devpost pages return HTTP 403 to non-browser fetchers (research phase)
- **Actual:** All four official hackathon URLs returned `403 Forbidden` to an HTTP fetch tool. They had to be read in a real browser.
- **Severity:** Low.
- **Suggestion:** Publish the rules as a plain-text or PDF mirror so agentic tools can cite them.

---

## PoC-1 (MCP Apps), 2026-10-11

### F-09: basic-host does not type-check when installed on its own: `@types/cors` is missing
- **Tool:** ext-apps `examples/basic-host` at commit `82221c0`
- **Task:** Install only `examples/basic-host` (sparse checkout) and run `npm run build`.
- **Actual:** `serve.ts(14,18): error TS7016: Could not find a declaration file for module 'cors'`. Upstream gets `@types/cors` from the monorepo root.
- **Severity:** Medium. The docs say to clone the whole monorepo, which builds every example.
- **Workaround:** `npm install --no-save @types/cors@2.8.19` (in `scripts/setup-basic-host.sh`). Upstream source is unchanged.

### F-10: The basic-host build script needs `cross-env`, which is not a dependency of basic-host
- **Actual:** `/bin/sh: cross-env: command not found`, then vite exited 127 (×2).
- **Severity:** Low.
- **Workaround:** Ran the same commands directly: `INPUT=index.html npx vite build`, then `INPUT=sandbox.html npx vite build`.

### F-11: The sandbox server returned 404 because the clone lived under a dot-directory
- **Task:** Run basic-host from `<project>/.hosts/ext-apps/...`.
- **Actual:** `GET http://localhost:8081/sandbox.html` returned `404`, but with the sandbox's CSP headers set. That looked like a CSP or routing fault. The real cause: Express `res.sendFile` defaults to `dotfiles: 'ignore'` and refuses any absolute path containing a `.` segment.
- **Severity:** Medium. The failure is silent and the clue is misleading.
- **Workaround:** Moved the clone to `hosts/`. The setup script refuses dot-directory destinations.
- **Suggestion:** Pass `{ dotfiles: 'allow' }` to `sendFile` upstream, or note this in the README.

### F-12: The spec says servers SHOULD gate UI tools on the client's `io.modelcontextprotocol/ui` capability, but the reference host never advertises it
- **Observed:** The basic-host `initialize` sends `capabilities.extensions = null` (`evidence/poc1/13-verify-render-console.txt`). Spec §Capability Negotiation: "Servers SHOULD check client capabilities before registering UI-enabled tools." The official `basic-server-vanillajs` example also registers unconditionally.
- **Impact:** A server that follows the SHOULD would hide its App from the official reference host.
- **Severity:** Medium (spec and reference implementation disagree).
- **Decision for PoC-1:** Register unconditionally, like the official example. The text-only fallback exists through `content`. Revisit if Alexa+ documents capability advertisement.

### F-13: The reference host's sandbox CSP is looser than the spec's restrictive default
- **Observed:** basic-host `serve.ts` builds `default-src 'self' 'unsafe-inline'`, `script-src … 'unsafe-eval'`, and `connect-src 'self'` when the resource declares no `ui.csp`. Spec §Content Requirements says the host MUST then use `default-src 'none'` … `connect-src 'none'`.
- **Impact:** Our "no direct network path" property can't rely on this host's CSP. It rests on the resource declaring no `connectDomains` and embedding no server address, which is tested.
- **Severity:** Low for us. A reference-host conformance gap.

### F-14: basic-host issues duplicate calls and floods notifications in its dev build
- **Observed:** Every page load sends `tools/call show_care_dashboard` and `resources/read ui://…` twice (likely React StrictMode double-mount in a `NODE_ENV=development` build). The browser console shows about 100 `ui/notifications/host-context-changed` messages within seconds.
- **Severity:** Low. It is harmless for a read-only tool, but a non-idempotent UI tool would run twice.
- **Mitigation for later:** Keep UI-linked tools read-only or idempotent.

### F-15: Browser MCP Apps hosts need CORS on the MCP server, and the docs don't say so
- **Observed:** The basic-host page (`http://localhost:8080`) calls the MCP server cross-origin. `createMcpExpressApp` validates `Origin` but sets no CORS headers, and the MCP Apps testing guide doesn't mention CORS.
- **Workaround:** Added an explicit allowlist middleware (`CARELOOP_CORS_ORIGINS`). It runs after Origin validation and exposes `mcp-session-id`. The default is no CORS at all.
- **Severity:** Medium (blocks first render with an opaque browser error).

### F-16: The MCP App view bundle is 589 KiB minified
- **Observed:** `@modelcontextprotocol/ext-apps` (main entry) bundles zod and SDK core into the view. A 100-line dashboard ships 589 KiB of inline JS.
- **Severity:** Low (a performance budget concern for device surfaces).
- **Next:** Evaluate `@modelcontextprotocol/ext-apps/app-with-deps` vs. the main entry, and tree-shaking, before the build phase.

### F-17: Matching a Playwright version to an already-cached Chromium build took guesswork
- **Task:** Add a browser render test without downloading browsers.
- **Actual:** I had to read `browsers.json` per version on unpkg to find that `playwright@1.61.0` ↔ `chromium-1228`.
- **Severity:** Low.

---

## Phase 2 (domain and workflow), 2026-10-11

### F-18: Browser MCP Apps hosts cannot send custom headers, so per-session identity needs a server-side default
- **Observed:** The reference `basic-host` connects with a plain `StreamableHTTPClientTransport` and offers no way to add `X-CareLoop-Actor` (or `Authorization`). A session from the browser host therefore has no actor.
- **Workaround:** `CARELOOP_DEFAULT_ACTOR` (local demos only; unset by default). `verify-render` runs the host session as the coordinator.
- **Severity:** Medium. Real identity in MCP Apps hosts depends on host-side OAuth support.

### F-19: Inputs rejected by the SDK's schema check never reach the domain layer, so they are not audited and have a different error shape
- **Observed (probe):** `record_care_event` with `kind: "dosage_change"` returns `isError: true` with the text `Input validation error: Invalid arguments for tool record_care_event: …`. The audit log stays empty, and the error has no stable `code`. Domain-level validation failures, by contrast, return `{"error":{"code":"INVALID_INPUT",…}}` and are audited as `invalid`.
- **Impact:** A future LLM sees two error formats, and schema-level rejections leave no audit trail.
- **Severity:** Medium.
- **Next:** Either keep strict inputSchemas (best for the LLM) and accept the gap, or normalize SDK validation errors to the domain error shape.

### F-20: zod objects strip unknown keys, so impersonation arguments are ignored rather than rejected
- **Observed:** `actor_id` / `reported_by_member_id` passed to `record_care_event` are silently dropped. Identity comes only from the session, so this is safe, but the caller gets no signal.
- **Severity:** Low.
- **Option:** `z.strictObject` to reject unknown keys, at the cost of brittleness with future LLM argument drift.

### F-21: MCP Inspector CLI exits with code 5 when a tool returns `isError: true`
- **Observed:** `exit=5` for `FORBIDDEN` and `UNAUTHENTICATED_SESSION` results (`evidence/phase2/inspector-cli.txt`). `--help` doesn't mention this. It's useful for scripting, but it surprised me.
- **Severity:** Low.

### F-22: Vitest ran test-file snapshots placed under `evidence/`
- **Observed:** Copies saved as `evidence/phase2/tests-before/*.test.ts` were collected and executed (and failed on imports). Vitest's default include is project-wide.
- **Workaround:** Renamed the snapshots to `*.ts.before`.
- **Severity:** Low (self-inflicted, but easy to hit).

---

## Phase 3A (agent readiness), 2026-10-11

### F-23: The MCP TypeScript SDK has no documented hook for custom tool-input validation errors
- **Observed:** `McpServer.validateToolInput` throws `ProtocolError(InvalidParams, "Input validation error: …")`, which the SDK turns into plain-text `isError`. No option customizes it.
- **Workaround (no SDK changes):** the SDK reads only the public Standard Schema interface. `domainValidated()` keeps `~standard.jsonSchema` (identical `tools/list`) and passes `~standard.validate` through, so the domain validates and returns a coded error. Verified by tests and a mutation check.
- **Severity:** Medium. It relies on SDK behaviour, so re-verify on SDK upgrades.

### F-24: An unknown tool name is a thrown protocol error, not an `isError` result
- **Observed:** `callTool({ name: 'delete_household' })` throws `Tool delete_household not found`. That is inconsistent with all other tool failures.
- **Mitigation:** The adapter never forwards non-allowlisted names; it returns `POLICY_DENIED` itself.
- **Severity:** Low.

### F-25: The Phase 2 ten-minute event heuristic silently merged legitimate reports
- **Found in review:** two genuine identical reports ("I ate rice") within 10 minutes became one record, with no signal to anyone.
- **Fix:** Every report is now stored, and similar reports carry `possible_duplicate_of`. Exact retries are covered by turn-derived idempotency keys. Two Phase 2 tests were updated to the new rule.
- **Severity:** Medium (silent data loss in a care log).

---

## Phase 3B (LLM integration, offline-verified), 2026-10-11

### F-26: MCP tool descriptions written for hosts are unsafe as LLM-facing text
- **Found by test:** the model-facing tool list still carried server descriptions mentioning "Retry with the same idempotency_key" and "nothing is sent until decide_approval approves it". Both name concepts the model must never act on.
- **Fix:** the adapter now sends explicit `MODEL_TOOL_DESCRIPTIONS` (agent policy) instead of server descriptions. A test asserts the model sees no `idempotency_key`, `decide_approval`, or `household_id`. A mutation check confirms the test catches regressions.
- **Severity:** Medium (a prompt-steering risk toward forbidden actions).

### F-27: The Claude API reference's defaults conflict with strict cost control
- **Observed:** the reference recommends enabling server-side refusal fallbacks by default and notes that the SDK retries twice by default. Both can spend money without an explicit decision, which conflicts with "no automatic retries that could create unexpected costs".
- **Resolution:** `maxRetries: 0` and fallbacks off; both are documented in the evaluation plan. The default model stays `claude-opus-5-5`; switching to Haiku 5.5 is a single env var.
- **Severity:** Low (a policy choice, now explicit).

### F-28: Default npm/pnpm workspace layout runs `tsx` scripts outside the package as CommonJS
- **Observed (earlier probe in this phase's prep):** a probe script in the scratch directory failed with "Top-level await is currently not supported with the cjs output format", because it sat outside the ESM `package.json`. Renaming it to `.mts` fixed it.
- **Severity:** Low.

---

## Phase 3C (live-eval preflight), 2026-10-11

### F-29: Original live-eval CLI allowed multi-case execution and a silent model default
- **Found in review (your Phase 3C task #6):** `--cases golden,injection` ran two paid calls per invocation, and an unset `--model` silently fell through to Opus with no signal distinguishing "you chose Opus" from "nothing was specified".
- **Fix:** `src/agent/live-eval-args.ts` — pure, unit-tested arg parser. `--case` (singular) is required, rejects comma-lists and unknown names. `modelExplicit` distinguishes an explicit `--model`/`CARELOOP_LLM_MODEL` from the implicit default, surfaced in the startup log line (`model=X (explicit)` vs `(default)`).
- **Severity:** Medium (cost-control gap: one invocation could trigger 2 paid calls without a second confirmation).

---

## Phase 3D (zero-cost local Ollama), 2026-10-13

### F-30: llama3.1:8b invents a human-readable id instead of the real member id
- **Observed (real, Scenario A):** asked to record a medication report, the model sent `subject_member_id: "Ravi"` instead of the real id `mem_ravi`. The server's id schema (`^[a-z0-9_]+$`) rejected it (`INVALID_INPUT`), so nothing was recorded.
- **Severity:** Medium — blocks the golden workflow outright on this model.
- **Likely fix (untested):** tighten the tool description / add an explicit id-format example, or default-omit `subject_member_id` more aggressively in the prompt guidance so an 8B model doesn't feel obligated to fill it in.

### F-31: Same model sends empty-string placeholders for optional fields it isn't using
- **Observed (real, Scenario A):** `provider_label: ""` on `prepare_appointment_request`. The adapter's verbatim-provenance rule correctly denied it (empty string is not "the user's words"), but the real issue is the model filling every schema property rather than omitting unused optional ones — common 8B-class tool-calling behavior, not seen with Claude Opus in Phase 3B/3C mocked tests.
- **Severity:** Medium.
- **Mitigation applied:** none yet — the adapter's existing verbatim check already fails closed here, so no unsafe write occurred; this is a workflow-completion gap, not a security gap.

### F-32: Output-safety `medical_advice` pattern false-positives on a safe local-model reply
- **Observed (real, Scenario B):** the model's accurate, safe reply *"No one has reported taking morning medicines yet today"* was replaced by the fallback text because "taking ... medicines" matched the `DOSAGE_DIRECTIVE` regex's 50-character proximity window, even though the sentence reports an absence, not an instruction.
- **Severity:** Medium (degrades real, safe answers; was previously only a theoretical limitation noted in Phase 3B).
- **Fix needed (not yet applied):** narrow `DOSAGE_DIRECTIVE` to require an actual directive verb-object relationship, or special-case "no report"/"not reported" phrasing before the proximity match.

### F-33: Ollama cold-load dominates single-call wall-clock latency
- **Observed:** 16.68s of Scenario A's 19.82s total was the one-time model load into GPU memory (confirmed in Phase 3D's own probe and here again); subsequent calls in the same run were 1.3–5.2s. Not a defect, just a UX fact worth planning around for a live voice demo (first utterance of a session pays this cost).
- **Severity:** Low.

---

## Phase 3E (local LLM reliability remediation), 2026-10-13

### F-30/F-31 fix applied: member-reference resolution and empty-string normalization
- **Root cause (general, not the one observed string):** `llama3.1:8b` routinely (a) names a member by display name instead of calling `get_household_status` first, and (b) fills every optional schema property rather than omitting unused ones, sending `""` instead of nothing.
- **Fix:** `CareService.subjectOrDefault` now resolves `subject_member_id` against the real household roster — an exact `member_id`, or failing that an exact case-insensitive display name (`src/domain/service.ts`, `resolveMember`). An unmatched reference is still `NOT_FOUND`; nothing is fabricated or guessed across households (tested: a real name from a *different* household, e.g. "Lin" in `hh_rao`, still fails). Separately, `AgentAdapter.execute` now drops any empty-string argument before validation/verbatim checks run (`src/agent/adapter.ts`), since no field in this system's schemas ever treats `""` as meaningful — this is a general normalization, not a special case for `provider_label` alone.
- **Verified (real local inference, fresh synthetic DB, no retries):** 3 real runs of the golden request (the original utterance run twice, plus 2 paraphrases) all showed `record_care_event` and, in 2 of 3, `prepare_appointment_request` complete with `outcome: "ok"` using a bare display name (`"Ravi"`) and/or an empty-string field — both previously hard failures. See `evidence/phase3e/local/run1..4`.
- **Severity:** was Medium (blocked the workflow); now mitigated at the root cause, not patched to the one observed string.

### F-32 fix applied: output-safety no longer flags factual "no report yet" status language
- **Fix:** `output-safety.ts` now exempts a sentence from the `medical_advice`/`diagnosis` checks only when it is both negated (`NEGATION`, extended to catch "nobody"/"no one") **and** about reporting (`REPORT_STATUS`: report/reported/recorded/logged) — not a blanket negation bypass, so a real directive that happens to contain "not" (e.g. "Don't skip taking your evening tablets.") is still caught (regression-tested).
- **Verified:** the exact originally-observed sentence, 3 paraphrases, and the adversarial negated-but-real-advice sentence are all now covered by `test/llm-runner.test.ts`'s `output safety unit rules` suite (7 safe-phrasing cases + 1 still-flagged case). Scenario B's real local run this phase passed with `action: "passed"` and zero violations (`evidence/phase3e/local/scenario-B.json`).
- **Severity:** was Medium; fixed and regression-tested.

### F-34: `llama3.1:8b` sends a non-ISO literal for a datetime field ("occurred_at": "now")
- **Observed (real, golden run 2):** the model sent `occurred_at: "now"` instead of omitting the optional field or using a real ISO-8601 timestamp. `z.iso.datetime({ offset: true })` correctly rejected it (`INVALID_INPUT`); the call failed closed, no event was recorded with a wrong timestamp.
- **Severity:** Medium — blocks that specific run's `record_care_event`, but is a narrow, model-specific quirk.
- **Not fixed:** adding a special case that accepts the literal string `"now"` would be overfitting to one observed output per this phase's explicit instruction. The server validation is already correct and safe; the general fix (clearer tool-level guidance to omit `occurred_at` rather than guess at a value) is a prompt-tuning task for a future phase, not a code change.

### F-35: the model does not reliably chain the full 4-tool golden workflow in one turn
- **Observed (real, golden runs 1, 3, 4):** even when `record_care_event` and `prepare_appointment_request` both succeeded, the model stopped (`stop: "completed"`, 2 model iterations) without calling `get_duty_contact` or `draft_caregiver_notification`, and without the `medication_schedule_id` that only `get_household_status` would have supplied. This is why the golden evaluator still reports `pass: false` on every real local run this phase, even though the two previously-blocking defects (F-30/F-31) are fixed.
- **Severity:** Medium — this is the model's own task-completion depth, not a security or validation gap; the output-safety layer correctly intercepted every resulting unconfirmed claim (e.g. "a doctor visit request... has been drafted" when `draft_caregiver_notification` was never called) and replaced it with a fact-based summary (`evidence/phase3e/local/run3-paraphrase1.json`, `run4-paraphrase2.json`).
- **Suggestion:** a model this small is not yet reliable as the *sole* driver of a multi-step workflow without either a stronger system prompt restating remaining steps each turn, or a larger local model. Not attempted this phase (would be a prompt/architecture change beyond the scope of "fix the two observed failure causes").

---

## Phase 4 (KinSync care handoff), 2026-10-14

### F-36: A browser MCP Apps host cannot act as different people, so "who is clicking" needed a design
- **Observed:** a sandboxed MCP App view only reaches the server through the host's one MCP session, whose identity is fixed at `initialize` (F-18). The handoff needs three different humans (approver, recipient, others) to act from one dashboard.
- **Decision:** a demo-only `simulated_actor_id` argument on the two human tools, honored only when the server runs with `CARELOOP_SIMULATED_ACTORS=1` **and** the session has no `X-CareLoop-Actor` header, only for members of the session actor's own household, and recorded as `simulated` in the transition row and audit detail. Header-bound sessions (the AI adapter, independent clients) can never switch identity.
- **Why this is the limit:** it is still impersonation inside a trusted demo. The real fix is per-user OAuth bearer tokens at the host, which the MCP Apps spec does not yet give a view a way to select between.
- **Severity:** Medium (honest-labeling issue, not a production path).

### F-37: Hard-coded tool counts in existing tests had to change when the allowlist grew
- `EXPECTED_TOOLS` (`test/helpers.ts`) and the "model sees six tools" assertion in `test/agent-security.test.ts` encode the tool list. Adding `propose_handoff` and `get_handoffs` to the model allowlist (and four tools to the server) was a deliberate, additive change, but it is the only edit made to existing assertions. Human-only tools remain absent from the model's list.
- **Severity:** Low.

### F-38: `npx vitest` fails under `devEngines.packageManager = pnpm` (F-03 again)
- Use `pnpm exec vitest run <file>`; `npx` aborts with EBADDEVENGINES. Cost one wasted call this phase.

### F-39: An existing subprocess test (5 s timeout) flakes when the machine is loaded
- `test/llm-runner.test.ts` "refuses a comma-separated case list" spawns `tsx scripts/live-eval.ts`. With the load average near 12 (a local Ollama model had just been used) it exceeded 5 s once; in isolation the same subprocess takes ~1.5 s and the file passed twice. The full suite passed 221/221 on re-run. First run kept as `evidence/phase4/vitest-full-run1-load-flake.txt`. Not changed (not part of this phase); raise the timeout if it recurs.
- **Severity:** Low.

### F-40: `sed -i` on macOS silently did nothing in a mutation check
- A first attempt at mutation-testing the new guards reported "all tests pass" because BSD `sed -i` needs a backup-extension argument and errored. Redone with Python string replacement: 5/5 mutations were caught (recipient check removed, human tools not human-only, recipient may self-approve, state machine allows reject after approve, simulation honored when disabled).
- **Lesson:** a green run after a mutation is only meaningful if the mutation applied; check the tool's exit status.

### F-41: One real local-model run of the handoff request (`llama3.1`, `pnpm handoff:ollama`)
- Called `propose_handoff` with `proposed_recipient` = Arjun, no human-decision tool, golden contract passed, one `PENDING_APPROVAL` row. Its free-text reply began "No, nothing has been sent or arranged yet", an odd answer to a statement, though safe. **n = 1**: this is not evidence of reliability (see F-35).

---

## Phase 5 (judge-ready demo polish), 2026-10-14

### F-42: `position: sticky` misbehaves inside an auto-sized MCP Apps iframe
- **Observed:** the redesigned dashboard made the "SIMULATED identity" bar sticky so it stayed on screen while recording. The reference host sizes the view iframe to its content, so the sticky bar stuck partway down a full-page narrow (390 px) capture and covered the header and summary cards (seen in the first Phase 5 narrow capture; the evidence file was regenerated after the fix).
- **Fix:** removed `sticky`; the bar stays prominent through a dashed amber border and a "Simulated identity" tag, and it sits directly under the header.
- **Suggestion:** the ext-apps docs could say how views are sized and that sticky/fixed elements are unreliable inside them.
- **Severity:** Low.

### F-43: A rota-dependent demo story breaks on some weekdays with a real clock
- **Observed:** the synthetic rota puts Priya on duty Monday to Wednesday and Arjun Thursday to Sunday. Recorded on a Thursday, "Can Arjun take over from Priya?" would produce a different (still valid, but confusing) proposal, and Priya could no longer approve it because she would be the proposed recipient.
- **Fix:** `pnpm demo` uses a demo clock that starts at Monday 2026-10-12 09:30 Asia/Kolkata and runs in real time. Its anchor is kept in `data/kinsync-demo.clock`, so timestamps stay monotonic across `--keep` restarts. The startup banner states this. Tests and the browser check already use a fixed Monday clock.
- **Severity:** Medium (would have broken a live recording).

### F-44: Older evidence logs contain a local home-directory path
- **Observed (submission audit):** vitest output in `evidence/*/vitest-full.txt` (including Phase 4 and 5) and `evidence/01-vitest.txt` includes the absolute working-directory path, which contains the local username. No secrets were found (the only key-like strings are the fake `sk-ant-test-...` values in tests).
- **Action before publishing:** replace the path prefix in those text files, or regenerate them from a neutral directory. Not done yet because publishing is out of scope for this phase.
- **Severity:** Low (privacy hygiene).

### F-45: Stopping a background `pnpm demo` by name pattern hit the wrappers, not the server
- **Observed:** while collecting restart evidence, a name-pattern signal reached the `sh -c` and `tsx` wrapper processes but not the inner node process serving port 3333. The "restart" then silently checked the *still-running original* instance (the `--keep` run had correctly refused with "port 3333 is in use"). That check was discarded and is not counted.
- **Fix:** restart evidence now identifies the exact PID listening on 3333, confirms its command line is `scripts/demo.ts` and that it holds `data/kinsync-demo.db`, sends SIGTERM to that PID only, and verifies all three ports are free before restarting. `scripts/demo.ts` now handles SIGTERM as well as SIGINT, so the reference host child is never orphaned. A real terminal Ctrl+C was never affected (it signals the whole process group).
- **Lesson:** a restart test must prove the process actually changed (new PID), not just that the endpoint answers.
- **Severity:** Medium (would have produced false evidence).

---

## Phase 6A (submission preflight), 2026-10-14

### F-46: On a fresh clone, `pnpm install` exits 1 because esbuild's build script is ignored
- **Observed:** a clean copy of exactly the files proposed for the first commit, installed with `pnpm install --frozen-lockfile --offline` (pnpm 11.28.5), printed `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: esbuild@0.28.2` and **exited 1**, even though every package was installed and esbuild worked. F-04 had recorded "none needed" because the original working copy never re-hit the check; a judge following the README would see a failed command.
- **Fix:** `pnpm-workspace.yaml` declares `allowBuilds: { esbuild: false }`: install scripts still never run (esbuild only validates its binary in postinstall), and install exits 0. `pnpm.ignoredBuiltDependencies` in `package.json` is **not** read by pnpm 11. The lockfile is unchanged.
- **Verified:** fresh clean copy: install exit 0, typecheck clean, 221/221 tests, reference host built from scratch with `scripts/setup-basic-host.sh` (39 s), `pnpm demo` fresh run plus exact-PID restart, all passing (`evidence/phase6/clean-clone/`).
- **Suggestion:** pnpm could warn rather than fail for a dependency whose build script is not needed, or name the exact setting to add.
- **Severity:** Medium (first command a judge runs).
