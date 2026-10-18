# KinSync Submission Checklist (Alexa+ track)

**Deadline:** 2026-10-23 12:00 PDT = **2026-10-24 00:30 IST**. Judging runs 2026-11-09 to 2026-11-20. The requirements below are from [RULES_AUDIT.md](RULES_AUDIT.md); re-check the live Devpost page before submitting.

Legend: [x] done and verified in this repo · [ ] needs you (account access, identity or a decision).

## 0. Before the first commit (Phase 6A preflight results)

- [x] Publishable file set reviewed: 256 files, about 9.2 MB, largest 260 KB (a screenshot). `git add -n -A` lists them; nothing is staged.
- [x] No databases, `.env` files, private keys or real credentials in the set. The only key-like strings are fake `sk-ant-test-...` values in tests.
- [x] Machine paths removed from 13 evidence logs (`<repo>`, `<tmp>` placeholders). Unmodified originals and a checksum manifest are kept **outside** the repo in `../KinSync-private-originals/`.
- [x] `.gitignore` covers `node_modules/`, `data/`, `*.db`, `hosts/`, `dist/`, `.env*` (except `.env.example`) and local Claude settings.
- [x] Clean-clone reproducibility: a fresh copy of exactly the publishable files ran install (exit 0), typecheck, 221/221 tests, the reference-host setup, `pnpm demo`, and a restart (`evidence/phase6/clean-clone/`).
- [ ] **Set your git identity** before committing. It becomes public on GitHub. The GitHub no-reply address keeps your personal email private:
  `git config user.name "<your name or handle>"` and `git config user.email "<id>+<username>@users.noreply.github.com"`.
- [ ] Approve the first commit (proposed message below).

## 1. GitHub

- [ ] Create the repository on **GitHub** (GitLab is not accepted), push `main`.
- [ ] Make it **public**. Confirm the **About** sidebar shows **MIT License** (the `LICENSE` file is at the root; GitHub detects it after the push).
- [ ] About description: "Family care handoffs that need a human yes: MCP server (2025-11-25) + MCP Apps dashboard, simulated Alexa+ workflow." Topics: `mcp`, `mcp-apps`, `alexa`, `caregiving`, `typescript`, `sqlite`.
- [ ] Spot-check on github.com: README renders (tables, diagrams), `docs/` links resolve, screenshots in `evidence/phase6/clean-clone/` open.
- [ ] If you choose to keep it **private** instead, share it with `testing@devpost.com` and `chris-trag, knmeiss, giolaq, anishamalde, mosesroth, emersonsklar` **at submit time** (invites expire after 7 days).

## 2. Video (YouTube or Vimeo)

- [ ] Record from [DEMO_SCRIPT.md](DEMO_SCRIPT.md); final length **2:45 or less** (must be under 3:00).
- [ ] English voiceover or captions; no music, or royalty-free only; no Alexa/Echo logos or trade dress.
- [ ] It shows the project **working**, and it says "simulated Alexa+ workflow" (the simulated path requires the video to show the simulated experience clearly).
- [ ] Upload as **Public** (not unlisted or private). Watch it once logged out to confirm.

## 3. Devpost form

- [ ] Project name **KinSync**, tagline "Family care handoffs that need a human yes."
- [ ] Track: **Alexa+**. Mini-challenges: only those you actually enter (see §5).
- [ ] Description: use README "For judges" plus Architecture. State plainly: self-hosted MCP server (spec 2025-11-25, Streamable HTTP), MCP Apps UI, simulated Alexa+ workflow (not native), synthetic data, no messaging/booking/dispatch, deterministic default planner with an experimental local LLM option.
- [ ] Repo URL and video URL.
- [ ] **Product feedback for every tool used** (required). Draft from the friction log:
  - MCP TypeScript SDK v2 (server, client, Node and Express transports): F-01, F-19/F-23, F-24.
  - MCP Apps / `@modelcontextprotocol/ext-apps` and the basic-host reference host: F-09..F-15, F-18/F-36, F-42.
  - MCP Inspector: F-06, F-21.
  - Ollama with `llama3.1` (local, experimental): F-30..F-35, F-41.
  - Anthropic SDK: integrated behind an opt-in gate, **never called** (no paid usage). Say so rather than reviewing what was not used.
  - Supporting tools (optional to mention): pnpm (F-03, F-04/F-46), Playwright (F-17), Vitest (F-22), Node `node:sqlite`.
  - For each tool: what you used it for, what worked, what needs work, onboarding, and whether you'd use it again.
- [ ] **Friction log** (optional, up to +10%): link [docs/FRICTION_LOG.md](FRICTION_LOG.md). The at-a-glance table is the summary; every entry has task, observed vs. expected, severity, workaround and suggestion.
- [ ] Feature requests (optional): Critical = per-user auth for MCP Apps views (F-36); Important = a documented SDK validation hook (F-23), and the reference host advertising the UI capability (F-12); Nice-to-have = sticky/fixed guidance for views (F-42).

## 4. Reviewer access (through 2026-11-20)

- [x] No accounts, keys, paid services or cloud resources needed; it runs locally: `pnpm install`, `scripts/setup-basic-host.sh`, `pnpm demo` (README Quick start).
- [x] Requirements are stated: Node >= 22.13, pnpm 11, git, npm, bun, and Chromium (only for automated checks).
- [ ] Keep the GitHub repo and the video public and unchanged in substance until judging ends (2026-11-20).
- [ ] Say in the Devpost "testing" field: "Runs locally; no credentials required. All data synthetic."

## 5. Your decisions

- [ ] **Eligibility:** confirm residency and that you have no Sponsor or Devpost affiliation (the rules say this is yours to check).
- [ ] **Open Source mini-challenge:** enter only with a *separate*, new contribution (for example an upstream ext-apps docs PR for F-11/F-42). KinSync itself is the primary submission and does not count twice.
- [ ] **AWS Builder mini-challenge:** not applicable. No AWS services are used.

## Proposed first commit

```
feat: KinSync care-handoff MCP server and MCP Apps demo (built on CareLoop)

Self-hosted MCP server (spec 2025-11-25, Streamable HTTP) with household-scoped
SQLite domain, human-only approval and recipient acceptance for care handoffs,
an MCP Apps dashboard for the official ext-apps reference host, a one-command
local demo, tests, evidence, and the developer friction log. Simulated Alexa+
workflow; all data synthetic.
```
