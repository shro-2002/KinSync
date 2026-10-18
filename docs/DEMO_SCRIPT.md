# KinSync Demo Script (target 2:45, hard limit under 3:00)

**What the video shows:** a self-hosted MCP server (spec 2025-11-25, Streamable HTTP) and an MCP Apps dashboard in the official ext-apps reference host, in a **simulated Alexa+ workflow**, running locally on synthetic data. Never say or imply that it runs on native Alexa+, that a message was sent, or that anyone arrived or gave care.

Rules that apply to the upload ([docs/RULES_AUDIT.md](RULES_AUDIT.md)): **under 3:00**, **public** on YouTube or Vimeo, English, the project shown working, no unlicensed music or third-party marks. Use no Alexa or Echo logos or trade dress; say "simulated Alexa+ workflow".

## Before recording (about 5 minutes)

1. One-time setup done (`pnpm install`, `scripts/setup-basic-host.sh`). Nothing else on ports 3333, 8080, 8081.
2. Layout: terminal left (font 18+), browser right, light mode, browser zoom 110-125%. Plan to **crop the browser to the dashboard frame** in editing: the reference host's own chrome (`careloop:show_care_dashboard`, Tool Input/Result panels) is not KinSync's UI.
3. Run `pnpm demo` **before** you start recording. The first start can take about 30 s on a busy machine. Wait for "Open the dashboard, then press Enter". **Do not press Enter yet.**
4. Open the printed dashboard URL. Check: "No open handoffs", the amber **Simulated identity** bar on *Priya (coordinator)*, "On duty today: Priya (daughter)".
5. Have a second terminal tab ready at the repo root for the restart beat.
6. Do a full dry run once, then restart `pnpm demo` (fresh database) for the real take.

## Final storyboard

Voiceover is about 300 words (about 2:05 spoken at 2.4 words per second); the remaining ~40 s is clicks, the restart and holds. On-screen text is a small lower-third caption, not a slide.

| Time | Screen | Action | Voiceover | On-screen text |
|---|---|---|---|---|
| 0:00-0:12 | Dashboard (cropped), empty state | none | "When a family shares care, the hard part isn't the calendar. It's handing a task to someone else and knowing they actually said yes. KinSync makes every care handoff need a human yes." | **KinSync** · family care handoffs that need a human yes |
| 0:12-0:25 | Slow pan over the chips row and Simulated identity bar | none | "It's a self-hosted MCP server with an MCP Apps dashboard, running in the official reference host. The Alexa+ voice turn is simulated, and every person here is synthetic." | MCP 2025-11-25 · Streamable HTTP · MCP Apps · simulated Alexa+ workflow · synthetic data |
| 0:25-0:55 | Terminal | Press **Enter** | "Ravi, who is cared for, says: 'I need help getting to my clinic visit on Thursday. Can Arjun take over from Priya?' The planner in this run is deterministic, rule-based, not an LLM. It reads the household, sees Priya is on duty, and calls one write tool, propose_handoff. Approving and accepting are human-only tools; the model is never even offered them." | Point at `tool 1`, `tool 2`, and "Nothing has been sent or arranged." |
| 0:55-1:15 | Dashboard | Click **Refresh** | "The proposal is stored as *Awaiting approval*. Priya is still responsible; Arjun is only proposed. Four stages: requested, awaiting approval, awaiting recipient acceptance, completed." | Zoom on the lifecycle row |
| 1:15-1:35 | Dashboard | Switch identity to **Arjun (caregiver)** | "This switcher is a labelled demo aid, not sign-in. As Arjun, Approve is disabled: the person taking over can't approve their own handoff. That's enforced on the server, not just in the page; our browser tests force the click and the server refuses it." | Hover the disabled Approve so its reason is visible |
| 1:35-1:55 | Dashboard | Switch to **Priya**, click **Approve** | "Priya, the coordinator, approves. Now it's awaiting Arjun, and the card says he isn't responsible until he accepts." | Show the green "Saved by the server" line |
| 1:55-2:15 | Dashboard | Switch to **Arjun**, click **Accept** | "Only Arjun can accept. Now it's a completed agreement: Arjun is responsible for this task. And notice what it doesn't claim. It records an agreement, not that care was given." | Zoom on "Now responsible for this task (accepted)" |
| 2:15-2:28 | Dashboard | Open **Audit trail (3)** | "Every step is persisted with a timestamp: proposed by Ravi, approved by Priya, accepted by Arjun, flagged simulated because I switched identity for the demo." | none |
| 2:28-2:40 | Terminal tab 2, then dashboard | Ctrl+C the demo, run `pnpm demo -- --keep`, reload the page | "It keeps state across sessions. Restart the server on the same database, reload, and the agreement and its history are still there." | `pnpm demo -- --keep` |
| 2:40-2:45 | Dashboard | Hold on the completed card | "The rules are plain code; any AI can only propose. KinSync: care handoffs that need a human yes." | Repo URL |

## Optional 15-second insert (only if the main cut is at or under 2:30)

At 0:55, show `pnpm demo -- --planner ollama` output (EXPERIMENTAL local model, pre-recorded). Say: "A local model can plan the same request, experimentally. It goes through the same policy, so it can still only propose." Do not include it if it pushes the video past 2:45, and never present it as the default.

## If something goes wrong while recording

- **Port in use:** the demo exits with a clear message. Stop the other process and run `pnpm demo` again; it always starts from a fresh synthetic database.
- **Dashboard shows nothing:** click **Refresh**. After a restart, reload the page.
- **Wrong person on duty:** the demo clock always starts Monday 09:30 IST with Priya on duty. If Arjun is on duty, you are running `pnpm server`, not `pnpm demo`.
- **Never** edit data by hand or splice in a result that did not happen. Re-record the step.

## Editing and upload

- Crop to the dashboard frame and the terminal. Burn in English captions or upload a caption file.
- No music, or a clearly royalty-free track at low volume.
- Final length check: **2:45 or less**. Upload **public** (not unlisted) on YouTube, titled "KinSync: family care handoffs that need a human yes (Alexa+ track, simulated workflow)".

## Do not say

- "Running on Alexa+" or "deployed to Alexa" (it is a simulated Alexa+ workflow).
- "Arjun has been notified" or "a message was sent" (nothing is sent).
- "Arjun is on his way" or "Ravi got to the clinic" (KinSync cannot know that).
- "The AI planned this" for the default run (it is rule-based; say "deterministic").
