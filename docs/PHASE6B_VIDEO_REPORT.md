# Phase 6B: Demo video production report

**Status:** local video complete. Nothing uploaded, published, committed or pushed.

## Deliverables

| File | Notes |
|---|---|
| `video/out/KinSync-demo-1080p.mp4` | 1920x1080, H.264 (CRF 17) + AAC 48 kHz mono, 25 fps, 34 MB, burned-in English captions. SHA-256 `1be65f41...2f025`. |
| `video/out/KinSync-demo.en.srt` | 29 English captions, timed from the recorded cue times. Same text as the burned-in captions. |
| `video/` (source) | `script.json` (narration), `make-audio.mjs` (TTS), `stage/stage.html` (layout, captions, labels), `record.mjs` (drives the real demo), `ptyrun.py` (pty wrapper), `compose.mjs` (zooms, audio mix, encode, SRT). |

`video/build/` (raw 1080p take, per-sentence narration, event log `events.json`, real terminal text `demo-terminal.log`) and `video/out/` are excluded locally through `.git/info/exclude`, not `.gitignore`, so the staged file set from Phase 6A is unchanged. `video/` source files are untracked.

Rebuild: `node video/make-audio.mjs && node video/record.mjs && node video/compose.mjs` (needs the Phase 5 prerequisites; ports 3333, 8080, 8081 free; about 3 minutes).

## Duration and technical checks

| Check | Result |
|---|---|
| Duration | **165.3 s (2:45.3)**: inside the 2:40-2:50 target, under 3:00 with 14.7 s margin |
| Resolution | 1920x1080, yuv420p, `+faststart` |
| Loudness | -16.1 LUFS integrated, true peak -1.5 dBTP |
| A/V sync | The video clock offset (1.64 s lead-in) was measured two ways (video duration minus recorded stage end; beat-label changes in the video at 31.0/59.0/75.0/95.0 s vs. recorded 31.0/59.0/75.0/95.0 s) and trimmed. First narration onset in the output: 0.61 s vs. caption cue 0.60 s. Sync was measured with silence detection and frame differencing; I did not listen to the audio. |
| Real restart | `pnpm demo` stopped with a genuine Ctrl+C keypress in the pty, then `pnpm demo -- --keep` started and the dashboard reloaded **6.3 s later, uncut**. The completed agreement and 3-row audit trail were still there. |
| Secret / path scan | `demo-terminal.log`, SRT and script: no `/Users`, user name, email, key, token or password strings. No home path appears in sampled frames or the 36-frame contact sheet. |
| Outdated labels | Completed card shows "Was responsible (on duty)" and "Now responsible for this task (accepted)"; the old "Responsible now" wording appears only on the open (pending) card, where it is correct. |
| Leftovers | Ports 3333, 8080, 8081 free afterwards. |

## What is real

- **Application:** the real `pnpm demo` (fresh synthetic database, deterministic planner) and the real ext-apps reference host with the KinSync MCP Apps view, loaded in headless Chromium.
- **Interactions:** Enter and Ctrl+C go to the process through a real pty. Dashboard clicks (Refresh, Approve, Accept, audit trail) are real mouse events at the on-screen position of each control. Identity changes use the real selector. Server responses and state changes are not mocked or edited; every state in the video is the one that run produced.
- **Terminal pane:** the real stdout of the process, rendered in an HTML pane (not a native terminal window). Output printed before recording began (startup banner) is replayed from the same process. The `$ pnpm demo` and `$ pnpm demo -- --keep` lines are the commands that were run.
- **Dashboard pane:** the reference host's own header and Tool Input block are cropped out (as `DEMO_SCRIPT.md` planned); the view is otherwise unmodified (scaled 1.15x by CSS zoom for legibility).
- **Overlays added in editing:** captions, step label, panel labels, amber highlight rings, the title/end cards and six gentle 8-10% push-ins on the dashboard pane. Nothing else is composited.

## Honesty requirements

- "Simulated Alexa+ workflow, not native Alexa+" is in the persistent header bar for the whole video, on the title and end cards, and in narration. "Synthetic data" likewise.
- Narration and on-screen terminal highlight both say the planner is deterministic and rule-based, not an LLM. The optional Ollama insert from the script was not used.
- "Nothing is sent or booked" is stated; no claim of notifications, bookings, dispatch or medical advice, and none of the "Do not say" phrases appear.
- The line "In our automated tests, a forced click is refused" refers to the Phase 5 browser test evidence (`evidence/phase5/browser/21-wrong-actor-refused.png`). It is not demonstrated live in the video, and it is narrated as a test result.
- Deployment to Alexa+ is not claimed; the end card says "Open source, MIT" (the repository has an MIT `LICENSE`).

## Changes to the storyboard

- Added a persistent label bar and a "n / 10" step label, plus highlight rings, so each beat is readable without sound.
- Narration is spoken a little more tightly than the script (per-sentence TTS, then holds for the actions); beats 3, 5 and 7 got extra hold time for output and clicks.
- Beat 5 narrates the server-side refusal as test evidence instead of forcing a click on camera.
- The repository URL slot was dropped (see below).

## Known limitations and unresolved

1. **Voice:** free macOS `say` voice "Samantha" (no paid or downloaded model). It is intelligible but synthetic; "MCP" and "LLM" are spelled out phonetically for the TTS. I could not audition it. If you prefer your own voice, record over `video/script.json` text and swap the audio mix (the SRT and captions stay valid if beat timing is kept).
2. **No GitHub URL on screen.** The repository has no commits or remote yet, so no URL is shown. After publishing, add it to the end card in `video/stage/stage.html` and rerun `record.mjs` and `compose.mjs` (or overlay it in any editor).
3. **Source video quality:** Playwright records VP8 at about 0.85 Mbps; the final H.264 re-encode is clean but small text (terminal, audit table) is softer than a native capture. Readable at 1080p; less so at 360p.
4. **Terminal is an HTML rendering** of real output, and the first lines pre-date the recording start (same process, not edited). If a judge requires a native terminal, screen-record Terminal.app following `docs/DEMO_SCRIPT.md`.
5. **Ring placement** is computed from element positions and was spot-checked on about 20 frames, not every frame; a few labels sit over adjacent text for the span of the highlight.
6. Running the recorder overwrote the local `data/kinsync-demo.db` and clock file (gitignored, regenerated by `pnpm demo`).
7. Still open from Phase 6A: your approval of the first commit and the public repo, the YouTube/Vimeo upload (public, logged-out check), and the Devpost form.
