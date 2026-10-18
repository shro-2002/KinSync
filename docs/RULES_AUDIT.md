# Rules Audit: Alexa+ Track

Legend: **[V]** verified from the official text (source ID from SOURCES.md) · **[A]** assumption or interpretation · **[U]** untested claim

## 1. Key dates

| Item | Value | Tag |
|---|---|---|
| Submission window | 2026-08-31 10:15 PT → **2026-10-23 12:00 PT** | [V] S2 §1 |
| Deadline in IST | 2026-10-24 00:30 IST (PDT is UTC−7) | [A] arithmetic |
| Days left from 2026-10-10 | about 13 | [A] |
| Judging | 2026-11-09 → 2026-11-20 | [V] S2 §1 |
| Winners | about 2026-12-03 | [V] S2 §1 |

## 2. Mandatory Alexa+ requirements

There are two compliant paths [V] S1, S2:

- **Path A (real MCP):** "A working Agent Skill or a self-hosted MCP server, implementing MCP spec version 2025-11-25 (or a later version, once confirmed) over Streamable HTTP." The repo must show the technology "at runtime in your code — imported and actually called… not just named in the README."
- **Path B (simulated):** "a simulated Alexa+ experience instead — built using any AI or agentic tool… This alternate path is exempt from the runtime-technology-hook requirement… the code repository must still include the simulation's source code, and the demo video must clearly show the simulated experience."

The FAQ adds [V] S3: "A web page that acts as an actual MCP client (sending initialize, tools-list, and tools-call requests over Streamable HTTP) satisfies the requirement… there's no way for any participant to connect a self-hosted MCP server to a real Alexa+ device or developer console."

**Recommended:** do both. Build a real Path A server and demo it through a Path B web client that is a genuine MCP client. That passes both readings of the Stage 1 pass/fail gate. [A]

### Spec-version detail

- The rules require **2025-11-25 minimum** [V] S2. Alexa+ itself targets 2025-11-25 [V] S12.
- A newer revision, **2026-07-28**, exists in the Python SDK's known versions [V] S9. The rules accept a later version only "once confirmed", which has not happened. Pin negotiation to `2025-11-25` and show `MCP-Protocol-Version: 2025-11-25` on screen in the demo. [A]
- The TS SDK sets `LATEST_PROTOCOL_VERSION = '2025-11-25'` [V] S8. The Python SDK may default to the newer revision [U].

### Streamable HTTP MUSTs that judges could check [V] S5

- One MCP endpoint (for example `/mcp`) that supports POST and GET. GET may return 405 if you offer no SSE stream.
- A POST that carries a request returns either `application/json` or `text/event-stream`. Notifications and responses get `202`.
- Validate `Origin`: an invalid origin gets `403`. Bind to 127.0.0.1 when running locally. Authentication is a SHOULD.
- If you issue `MCP-Session-Id`, later requests without it get `400`, and a terminated session gets `404`.
- An invalid `MCP-Protocol-Version` header gets `400`.

## 3. Submission artifacts checklist [V] S1, S2

- [ ] Text description of features and functionality
- [ ] **GitHub** repo (GitLab is not accepted [V] S3) with all source, assets, and setup/run instructions
- [ ] Repo is **public with an OSI license detectable in the About section**, or private and shared with `testing@devpost.com` plus `chris-trag, knmeiss, giolaq, anishamalde, mosesroth, emersonsklar`. Invites expire after 7 days, so send them at submit time.
- [ ] Demo video **under 3:00** on YouTube or Vimeo, **public**, English, shows the project working, and contains no unlicensed third-party marks or music
- [ ] Product feedback for **every** tool, API, and SDK: what you used it for, what worked, what needs work, onboarding, and whether you would build with it again. Describe AWS usage here if entering AWS Builder.
- [ ] Track and mini-challenge selection
- [ ] Open Source mini: contribution URL, repo URL, GitHub username, and a what/how/why description
- [ ] Optional but worth up to **+10%**: friction log (task, steps, expected vs. actual, severity, workaround, suggestion)
- [ ] Optional: feature requests rated Critical, Important, or Nice-to-have
- [ ] Testing access: project free and unrestricted for judges through 2026-11-20. Include credentials if anything is gated.

## 4. Judging [V] S2 §6

- **Stage 1:** pass/fail. Does the project fit the theme and reasonably apply the required APIs and SDKs? The friction-log bonus is assessed here.
- **Stage 2:** four criteria, equally weighted: Tech Implementation, Design, Potential Impact, Quality of the Idea. Ties go to the earlier criterion first, so **Tech Implementation breaks ties**.
- The rubric names Alexa+ ideas it treats as *obvious*: "single-turn Q&A bot, basic MCP wrapper around an existing API."
- It names Alexa+ ideas it treats as *creative*: "agentic workflow that orchestrates across services autonomously, context-aware add-on that maintains state across sessions, purchasing capabilities, media support (cards, carousels, etc), MCP Apps, Agent Skills."
- Judging "may utilize… automated AI-driven analysis". A clear README and a clear repo structure therefore matter. [V] text, [A] implication.
- Judges may judge from the video and description alone. Treat the video as the product. [V]

## 5. Public vs. partner-only tools

| Tool | Status | Tag |
|---|---|---|
| Alexa+ Category SDK, MCP Toolkit, `alexa-ai` CLI, Web Simulator | **Select partners only. Participants cannot get access.** | [V] S3 |
| Connecting a self-hosted MCP server to a real Alexa device or console | Not possible for participants | [V] S3 |
| MCP spec, official TS and Python SDKs, MCP Inspector | Public, open source | [V] S5, S10, S11 |
| MCP Apps extension (`@modelcontextprotocol/ext-apps`) | Public; Alexa+ supports it [V] S12 | [V] S7 |
| Agent Skills (agentskills.io format) | Public | [V] S7 |
| Amazon Devices Builder Tools MCP | Public, but aimed at Fire OS and Vega | [V] S4 |
| AWS promotional credits ($150) | **Exhausted as of 2026-10-07** | [V] S2, S4 |
| Bedrock, AgentCore, Strands | Public, pay-as-you-go | [A] |

## 6. Hard disqualification risks

| Risk | Mitigation |
|---|---|
| Repo not on GitHub, private repo not shared, or license not detectable in About | Public repo with an MIT or Apache-2.0 `LICENSE` at the root; confirm GitHub shows it |
| Required technology only mentioned, not called at runtime | Real MCP server; the client calls `initialize`, `tools/list`, and `tools/call` |
| Spec below 2025-11-25, or a non-Streamable-HTTP transport (stdio, legacy SSE) | Pin `2025-11-25` and add a conformance test |
| Video at or over 3:00, private or unlisted, not English, or copyrighted music | Keep it to 2:45, public on YouTube, royalty-free or no music |
| Third-party trademarks in the video or UI | Do not copy Alexa or Echo trade dress; label it "simulated Alexa+-style experience"; use no other brands' logos [A]: Amazon is the sponsor, but "Alexa" wording should still be careful |
| Not original or not solely owned; open-source code reused without "enhancing and building upon" it | New project; OSS dependencies used as libraries only, licenses respected |
| Ineligible entrant (embargoed region, Sponsor or Devpost affiliation, under age of majority) | **Confirm residency and affiliation yourself.** India is not on the named list [V], but this is your call |
| Pre-existing project not "significantly updated" | New repo; first commit after 2026-08-31 |
| Health or medical data handling (idea-specific) | Synthetic data only; no medical advice; position as family logistics [A]; Amazon dropped its HIPAA skills program [V] S17 |
| Judges can't run it: hosted dependency gone, or needs paid keys | Locally runnable with `docker compose` or `pnpm dev`; mock-LLM fallback mode; keys documented [V] S3 says local run is enough |
| Multiple near-identical submissions | One submission |

## 7. Mini challenges (stackable: one track prize plus one mini prize) [V] S2

- **AWS Builder:** use AWS services with *documented* integration, for example a Bedrock or Strands agent driving the simulated host. Kiro Crew also qualifies on its own. Credits are gone, so you pay for usage [V].
- **Open Source:** must be a *new, additional* project or a contribution beyond the primary submission [V]. Candidates: a PR to the MCP Inspector or ext-apps, or a separately licensed reusable "browser voice MCP host" package. [A]
