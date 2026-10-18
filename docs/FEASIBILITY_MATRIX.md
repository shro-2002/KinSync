# Feasibility Matrix

Legend: **[V]** verified · **[A]** assumption · **[U]** untested

## Component feasibility (recommended stack, CareLoop)

| Component | Option chosen | Public? | Cost | Credentials | Confidence | Tag |
|---|---|---|---|---|---|---|
| MCP server | TypeScript, `@modelcontextprotocol/server` 2.3.1 + Express Streamable HTTP | Yes | Free | None | High | [V] package exists S10; [U] API untested |
| Protocol version | Pin `2025-11-25` | Yes | — | — | High | [V] TS SDK latest = 2025-11-25 S8 |
| MCP Apps UI cards | `@modelcontextprotocol/ext-apps` 2.0.3 (`ui://` resources) | Yes | Free | None | Medium | [V] package S10; [U] that a custom web host renders it |
| Web simulator, MCP client | Browser or Node using `@modelcontextprotocol/client` 2.3.1 | Yes | Free | None | High | [U] |
| Voice in/out | Browser Web Speech API (STT and TTS) | Native | Free | None | Medium: Chrome only; STT quality varies | [A] |
| Host LLM (tool-calling loop) | Amazon Bedrock (Claude) via Strands or the Converse API, **or** the Anthropic API | Yes | Pay per token, about $1–5 for the build [A] | AWS account + Bedrock model access, or `ANTHROPIC_API_KEY` | Medium | [U] whether the user's AWS account has Bedrock access |
| Deterministic fallback | Scripted "mock host" that replays the demo without an LLM | — | Free | None | High | [A] protects judges' ability to run it |
| State | SQLite file (`better-sqlite3` or `node:sqlite`) | Yes | Free | None | High | [A] |
| Hosting | Not required. Local run is enough [V] S3. Optional ngrok or Lambda | Yes | Free tier | ngrok token already installed [V] | High | [V] |
| Agent Skill | `SKILL.md` folder (agentskills.io format) wrapping the workflow | Yes | Free | None | Medium | [U] how judges perceive it |
| AWS Builder mini | Bedrock (and optionally DynamoDB or Lambda), documented | Yes | Credits **exhausted** [V] | AWS creds; `aws` CLI **missing** locally [V] | Medium | — |
| Open Source mini | Separate MIT repo: `mcp-voice-host` (browser voice MCP client), or a PR upstream | Yes | Free | GitHub (logged in) [V] | High | [A] |

## Local toolchain (verified 2026-10-10)

| Tool | Status |
|---|---|
| node 26.3.0, npm 11.16.0, pnpm 11.9.0 | ✅ present (ext-apps needs Node ≥ 20 [V] S7) |
| python3 3.13.5, uv 0.11.21 | ✅ present (not needed for the TS path) |
| git 2.52.0, gh 2.95.0 (authenticated) | ✅ |
| docker 29.5.3 | ⚠️ installed, daemon **not running** |
| ngrok 3.39.8 | ✅ |
| aws CLI, sam | ❌ missing: needed only for the AWS Builder mini |
| Bedrock model access | ❓ unknown |
| Anthropic API key | ❓ unknown |

## Idea-level feasibility (13 days, solo)

| Idea | Core build days | Hard dependency | Biggest unknown | Verdict |
|---|---|---|---|---|
| CareLoop | 7–8 | LLM tool-calling host | Making multi-user voice clear in 3 minutes | **Go** |
| Pantry Pilot | 6 | LLM host | Novelty score | Backup |
| HomeLedger | 7 | Receipt extraction | Demo drama | Backup 2 |
| Paperwork navigator | 9+ | Realistic documents and data | Credibility with synthetic data | No |
| Errand Relay | 8 | Maps and routing APIs | Differentiation | No |

## Costs and permissions summary

- **Must-have spend:** $0. Use the mock-host fallback with no LLM. [A]
- **Likely spend:** less than $10 in LLM tokens for development and recording. [A]
- **Account actions needed from you, not from me:** decide on Bedrock vs. the Anthropic API; enable Bedrock model access in the AWS console if you choose AWS; create the public GitHub repo; upload the YouTube video. No purchases are required.
