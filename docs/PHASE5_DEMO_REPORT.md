# Phase 5 Report: KinSync Judge-Ready Demo Polish

**Date:** 2026-10-14  **Verdict:** ready to **record**; ready to **submit** once the items in §7 are done (none are code changes to the product).

No commits, pushes, deployments, video uploads or paid API calls were made. Spend: $0.

## 1. What changed

**Dashboard (visual quality, accessibility).** `src/ui/dashboard.html` and `src/ui/handoff-view.ts` were redesigned; every control still calls a real MCP tool and re-renders from the server's answer.
- A four-stage lifecycle on every card: **Requested -> Awaiting approval -> Awaiting recipient acceptance -> Completed**, each stage with a text state ("Done / In progress / Not yet / Stopped"), not colour alone. Rejected and declined handoffs show a stopped stage.
- Plain-language badges ("Awaiting approval", "Completed agreement"); the raw state codes (`PENDING_APPROVAL -> PENDING_ACCEPTANCE`) appear in a per-card audit table with timestamps.
- Person cards whose wording follows the outcome: "Responsible now / Proposed to take over" while open, "Was responsible / Now responsible for this task (accepted)" once completed, "Still responsible / Was proposed" if rejected or declined. Nothing says someone took over before they accepted.
- A prominent amber **Simulated identity** bar ("Demo only, not authentication"), with an explanation that the server re-checks every click.
- Summary row (on duty today, open handoffs, completed agreements), scope chips ("Simulated Alexa+ workflow (not native Alexa+)", "MCP Apps view", "Synthetic data").
- Responsive: the lifecycle stacks vertically and buttons go full width under 600 px. 44 px minimum touch targets, 3 px focus ring on everything focusable, a `role=status` live region for server results, `aria-describedby` from disabled buttons to the visible reason, light and dark themes. All original element ids were kept, so the earlier render checks still apply.

**Demo experience.** `pnpm demo` (`scripts/demo.ts`) is the single start command: a fresh synthetic database, the MCP server, the official MCP Apps reference host, and Ravi's request, with the utterance, the planner type, each tool call and its result, and KinSync's reply printed in the terminal. `--keep` restarts on the same database; `--planner ollama` is the clearly labelled EXPERIMENTAL local-LLM path with no fallback; `--smoke` is a non-interactive self-check. Preflight gives a clear message for a missing reference host, missing `bun`, busy ports, or an unreachable Ollama. A **demo clock** starts at Monday 2026-10-12 09:30 Asia/Kolkata and runs in real time, so the rota always puts Priya on duty whatever day you record (F-43). Its anchor persists, so timestamps stay monotonic across `--keep` restarts. SIGINT and SIGTERM both shut down the server, database and reference-host child cleanly.

**Submission readiness.** README rewritten judge-first (60-second story, honest scope, quick start, architecture diagram, who-decides table, verify commands, build history). New `.env.example` (documentation only; `.gitignore` now un-ignores it). Friction log gained an at-a-glance status table with "who should act", plus F-42 to F-45. New `docs/DEMO_SCRIPT.md` (2:50 storyboard).

**Checks.** `scripts/verify-handoff-ui.ts` now follows the demo story (Priya approves in her own session, Arjun accepts via the simulated switcher), adds keyboard-only steps, and captures desktop and narrow screenshots. New `scripts/verify-demo-run.ts` drives an already-running `pnpm demo` exactly as a presenter would.

No backend, authorization, approval, idempotency or audit code was changed in this phase.

## 2. Test results (final run)

| Check | Result | Evidence (`evidence/phase5/`) |
|---|---|---|
| Typecheck | clean | `typecheck.txt` |
| Full test suite | **221/221** | `vitest-full.txt` |
| Scenario checks | **17/17** | `scenario-console.txt` |
| Golden trace + agent offline | pass, 0 violations; golden=true | `golden-console.txt`, `agent-offline-console.txt` |
| MCP Apps render checks | **11/11** (re-run after the last UI change) | `render-console.txt`, `render/` |
| Handoff browser checks (keyboard, wrong-actor forced clicks, restart) | **22/22** (re-run after the last UI change) | `handoff-ui-console.txt`, `browser/` |
| Handoff MCP demo | **14/14** | `handoff-demo-console.txt` |
| `pnpm demo` fresh run, driven in Chromium | 3/3 | `demo-run/run.json`, `demo-console.txt`, `30-*`..`32-*` |
| `pnpm demo -- --keep` restart, fresh browser | 1/1 + server check | `demo-run/after-restart.json`, `after-restart-server-check.json`, `40-*` |
| `pnpm demo --smoke` (fresh, then `--keep`) | PASS, PASS | run during development (console output in this phase's transcript) |

No failures in the final run. An earlier "restart" check was a **false positive** and is not counted (next section).

## 3. Restart verification (and the discarded false positive)

**Discarded:** a first attempt stopped the demo with a name-pattern signal that hit only the `sh`/`tsx` wrappers. The original server kept running, the `--keep` run correctly refused ("port 3333 is in use"), and the browser check then passed against the *original* instance. That result is void (F-45).

**Redone, with exact PIDs:**
1. `pnpm demo` (fresh) -> Ravi's turn proposed the handoff; the browser flow (Refresh, Priya approves, Arjun accepts) passed.
2. The listener on :3333 was **PID 62768**. Its command line was `.../tsx ... scripts/demo.ts`, it held `data/kinsync-demo.db` open, and its children were the reference host (`bun`, PID 63174, listening on :8080). SIGTERM was sent to **62768 only**; it exited in 1 s, `bun` exited with it, and ports 3333 and 8080 were free.
3. Baseline read from the stopped database (`before-restart-db.json`): one handoff `COMPLETED`, version 3; transitions at 04:00:03.865Z (propose, Ravi), 04:00:37.252Z (approve, Priya, session), 04:00:37.919Z (accept, Arjun, simulated); clock anchor 1791995282768.
4. `pnpm demo -- --keep` started a **new PID 65949** (`scripts/demo.ts -- --keep`), printed "KEPT from the last run", and reported demo time 04:01:27Z with the anchor unchanged.
5. A **fresh browser** loaded the dashboard: Completed agreement with a 3-entry audit trail (`40-after-restart-*.png`). An independent MCP session confirmed the same handoff id and status, the identical three transition timestamps, `generatedAt` 04:01:53Z later than the last pre-restart transition (clock continuity), and Priya still on duty.
6. SIGTERM to the confirmed PID 65949; it exited in 1 s; ports 3333, 8080 and 8081 were free.

## 4. Keyboard accessibility (basic check, automated in `verify-handoff-ui.ts`)

- Tab from Refresh reaches the identity selector; the focused element shows a visible focus ring (`:focus-visible`, outline at least 2 px).
- As Priya, Tab reaches **Approve** (focus ring visible) and **Enter** approves; the state is verified in SQLite.
- As Arjun, Tab reaches **Accept** and **Space** accepts.
- A disabled button points to a visible text reason through `aria-describedby`.

**Not covered:** no screen-reader run (VoiceOver/NVDA), no axe audit, and the selector's *value* is changed with Playwright's `selectOption` rather than arrow keys (native selects behave differently per OS in headless Chromium). Disabled buttons are not focusable, by design; their reason is visible text.

## 5. Screenshots (final UI)

Desktop is 1280 px wide; narrow is 390 px.
- `browser/20-pending-approval-desktop.png`, `browser/20-pending-approval-narrow.png`: Awaiting approval.
- `browser/21-wrong-actor-refused.png`: Arjun's forced approve refused by the server.
- `browser/22-pending-acceptance.png`, `browser/23-completed-desktop.png`, `browser/24-after-restart-{desktop,narrow}.png`: these use the fixed test clock, so all timestamps are identical.
- `demo-run/30..32-*-{desktop,narrow}.png`, `demo-run/40-after-restart-*.png`: the real `pnpm demo` with real-time demo-clock timestamps. **Superseded by `evidence/phase6/clean-clone/` (Phase 6A), which shows the corrected labels.** These were captured **before** the final "Now responsible for this task (accepted)" wording fix, so the completed card still reads "Responsible now (on duty): Priya". The `browser/` captures show the corrected wording.

## 6. Submission audit

| Item | Status |
|---|---|
| README | Judge-first rewrite; honest scope (simulated Alexa+, not native; synthetic; no messaging or booking); quick start; architecture; verify commands |
| Installation | Node >= 22.13 (`engines`), pnpm 11, git, npm, **bun** (reference host), Chromium for checks; one-time `scripts/setup-basic-host.sh` |
| Environment | `.env.example` lists every variable; none are needed for the demo; `ANTHROPIC_API_KEY` is marked paid, optional and never used by the demo or tests |
| License | MIT, `LICENSE` present |
| `.gitignore` | Ignores `node_modules/`, `data/` and `*.db` (incl. the demo DB and clock file), `hosts/`, `dist/`, `.env`, `.env.*` (except `.env.example`), `.claude/settings.local.json`; `.remember/` ignores itself |
| Secrets | Pattern scan (Anthropic, AWS, GitHub, Slack, private keys): only fake `sk-ant-test-...` strings in tests |
| Personal data | Synthetic people only. **Open:** evidence vitest logs contain the local home-directory path (F-44) |
| Paid/cloud dependencies | None on any default path |

## 7. Remaining issues

1. **F-44:** scrub the local path from evidence text files before the repository goes public.
2. **Git:** the repository still has no commits; everything is untracked. Committing (and pushing) needs your approval.
3. **The video is not recorded yet.** Follow `docs/DEMO_SCRIPT.md`. The first `pnpm demo` start took about 30 s on a loaded machine (UI build plus tsx cold start), so start it before the take.
4. The reference host's own chrome shows the server id `careloop:show_care_dashboard`. That is by design (identifiers unchanged), but worth one sentence of narration or a crop.
5. The `demo-run/` screenshots predate the final completed-card wording fix (§5). Re-capture them with `pnpm demo` + `scripts/verify-demo-run.ts` if you want them in the submission.
6. Carried over: the simulated identity is demo-only (production needs per-user auth); no screen-reader or axe audit; the local-LLM path is experimental (n = 1 success); one load-sensitive pre-existing test (F-39); a completed handoff records an agreement and does not update the rota or notify anyone.

## 8. Readiness

- **Recording: ready.** `pnpm demo` reproducibly produces the full story from a fresh synthetic database. It survives a verified restart, needs no accounts, keys or network services, and the UI labels simulation and scope everywhere it matters.
- **Submission: ready after §7 items 1 to 3** (path scrub, approved commit, recorded video). None require product code changes.
