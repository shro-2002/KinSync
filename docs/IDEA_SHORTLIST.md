# Idea Shortlist: Alexa+ Track

Legend: **[V]** verified · **[A]** assumption · **[U]** untested

Filter used for every idea:
- Not a "single-turn Q&A bot" or a "basic MCP wrapper around an existing API" (the rubric's *obvious* list [V] S2).
- Must hit at least three items from the *creative* list: cross-service agentic orchestration, state across sessions, purchasing, cards and carousels, MCP Apps, Agent Skills.
- One person, about 13 days, no Alexa hardware, no partner tools, no real third-party accounts the judges would need.

## The five problems

### 1. Family care coordination for an aging parent ("CareLoop", working title)
- **Problem:** Adult children coordinate medications, refills, appointments, and "did Mom eat or take her pills" check-ins across group chats and sticky notes. The parent wants voice, not apps.
- **Agentic shape:** The parent talks ("I took my morning pills", "my knee hurts again"). The agent logs it, updates shared state, detects a missed dose or an approaching refill, drafts a refill request and appointment prep notes, and escalates to the right sibling with a rotating duty roster. One spoken sentence leads to several tool calls.
- **Existing solutions:** Amazon's **Alexa Together was discontinued (May 2025)** [V] S16, and its replacement Emergency Assist covers emergencies only. dala.care is B2B, agency-facing, and MCP-enabled [V] S18. SafeSight covers appointment booking only [V] S19. Medisafe and similar apps are phone-first, single-user medication reminders [A]. **Gap:** a voice-first, *multi-person household* loop for non-clinical logistics. [A]
- **Risk:** It touches health. Keep it to logistics and adherence logging, use synthetic data, and give no advice. Amazon dropped its HIPAA skills program [V] S17.

### 2. Household operations agent: warranties, returns, and maintenance ("HomeLedger")
- **Problem:** Return windows lapse, warranties go unclaimed, filters and smoke-detector batteries are forgotten.
- **Agentic shape:** Ingest a receipt or order (pasted email or photo), extract item, price, and deadlines, run a recurring maintenance plan, and on request draft a return or warranty claim and build a "replacement parts" cart (simulated purchase, which earns the rubric's purchasing credit).
- **Existing solutions:** Many receipt and warranty trackers and home-maintenance apps exist [A], so novelty is moderate. Alexa already has reminders [A].
- **Risk:** Looks like a CRUD reminder app unless the cross-service orchestration is shown clearly.

### 3. Kitchen "use-it-up" planner ("Pantry Pilot")
- **Problem:** Household food waste. Meal plans ignore what is about to expire.
- **Agentic shape:** Voice pantry updates while cooking, expiry tracking, a plan for the next three dinners that uses perishables first, a shopping-list delta, a simulated cart, and recipe cards and carousels through MCP Apps on a screen device.
- **Existing solutions:** A crowded category (Samsung Food, Mealime, Paprika, and others) [A]. Alexa recipe experiences already exist [A].
- **Risk:** Judges will see it as an obvious idea. Strong demo, weak novelty.

### 4. Benefits and paperwork deadline navigator for low-vision or low-literacy users
- **Problem:** Missed renewals (benefits, licenses, leases) cost people money. Forms are hostile to voice.
- **Agentic shape:** Explains a letter read aloud, extracts the deadline and required documents, builds a checklist, and schedules reminders.
- **Existing solutions:** Accessibility tools exist but fragment by program. Mostly human caseworkers [A].
- **Risk:** Highest impact, but the real data and integrations are jurisdiction-specific. A demo would be fully synthetic, which hurts credibility in a 3-minute video. Legal-advice sensitivity.

### 5. Multi-party trip and errand coordinator for families ("Errand Relay")
- **Problem:** Who picks up whom, when, with what. School runs, pharmacy, groceries.
- **Agentic shape:** Voice requests become a shared task board with assignment and conflict detection, and the agent drafts messages to family members.
- **Existing solutions:** Shared calendars, Cozi, OurHome [A]. Real routing needs maps APIs and keys.
- **Risk:** Overlaps heavily with Alexa's own lists and calendar features. Hard to show differentiation.

## Scoring (1–5; Feasibility and Demo weighted ×1.5 for a solo 13-day build)

| Criterion | 1 CareLoop | 2 HomeLedger | 3 Pantry | 4 Paperwork | 5 Errand |
|---|---|---|---|---|---|
| Impact | 5 | 3 | 3 | 5 | 3 |
| Novelty (vs. rubric "obvious") | 4 | 3 | 2 | 4 | 2 |
| Technical depth (multi-tool, state, MCP Apps) | 5 | 4 | 4 | 3 | 3 |
| Usability (voice fit) | 5 | 4 | 5 | 4 | 3 |
| Feasibility ×1.5 | 4 | 4 | 5 | 2 | 3 |
| Demo quality ×1.5 | 5 | 3 | 4 | 3 | 3 |
| Time risk (5 = low) | 4 | 4 | 5 | 2 | 3 |
| **Weighted total** | **36.5** | **28.5** | **31.5** | **25.5** | **22.0** |

These scores are judgment calls [A]. They are not measured.

## Top 3 recommendation

### #1: CareLoop (family care coordination) — **recommended**
- **Why:** The pitch is clear and emotional, and it fills a gap Amazon itself left by discontinuing Alexa Together [V] S16. That speaks directly to "credible, specific case for solving customer needs" and to "genuine understanding of the ecosystem". [A]
- **Rubric hits:** state across sessions (a household ledger), autonomous cross-tool orchestration (log, detect, draft, notify), MCP Apps (a care dashboard card on a screen device), simulated purchasing (a pharmacy refill cart, confirm-before-buy), and an Agent Skill that packages the workflow. Five of the six creative items. [A]
- **Tradeoffs:** Health sensitivity requires careful framing. Synthetic data makes the demo look staged unless the story is tight. Multi-user identity in a voice demo needs a simple "speaker" switch.

### #2: Pantry Pilot
- **Why:** Easiest to make visually stunning with MCP Apps recipe carousels and a cart. Lowest build risk.
- **Tradeoffs:** The category is crowded and reads as *obvious*. Quality of the Idea would likely score low, and that criterion carries a quarter of the weight. [A]

### #3: HomeLedger
- **Why:** A broad audience, and purchasing and returns tie naturally to Amazon.
- **Tradeoffs:** Risks looking like a reminder app. Receipt parsing adds an OCR or LLM extraction dependency without adding demo drama.

**Fallback rule:** if CareLoop's PoC isn't working by Day 3, pivot to Pantry Pilot. The MCP server and the web-client host are reusable as-is. [A]
