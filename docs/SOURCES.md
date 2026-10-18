# Sources

Accessed 2026-10-10. Devpost pages block automated fetchers (HTTP 403), so they were read in a real browser session. The text quoted in these docs is what the pages showed on that date. Devpost says rules can change ("September 16, 2026 UPDATE", "October 7th Update"), so re-read them before you submit.

## Official hackathon (primary, authoritative)

| ID | URL | Used for |
|---|---|---|
| S1 | https://amazonappdev2026.devpost.com/ | Track definitions, what to submit, prizes, judges, criteria summary |
| S2 | https://amazonappdev2026.devpost.com/rules | Binding rules: dates, eligibility, project and submission requirements, judging stages, IP |
| S3 | https://amazonappdev2026.devpost.com/details/faqs | Gated Alexa+ tools, simulator path, hosting, credits, GitHub-only |
| S4 | https://amazonappdev2026.devpost.com/resources | Alexa+ resource links, AWS credits exhausted note |

## MCP specification and SDKs

| ID | URL | Used for |
|---|---|---|
| S5 | https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http | Streamable HTTP MUST/SHOULD requirements (linked from S4) |
| S6 | https://modelcontextprotocol.io/docs/latest/getting-started/intro | Rules-designated starting doc for Alexa+ (S2 §4) |
| S7 | https://apps.extensions.modelcontextprotocol.io/api/#build-with-agent-skills | MCP Apps extension and Agent Skills (linked from S4) |
| S8 | https://github.com/modelcontextprotocol/typescript-sdk (`packages/core/src/constants.ts`) | `LATEST_PROTOCOL_VERSION = '2025-11-25'` in the TS SDK (read via `gh api`) |
| S9 | https://github.com/modelcontextprotocol/python-sdk (`src/mcp-types/mcp_types/version.py`) | Python SDK knows `2026-07-28` and separates "handshake" from "modern" versions |
| S10 | npm registry (`npm view`) | `@modelcontextprotocol/server` 2.3.1, `/client` 2.3.1, `/sdk` 1.32.1, `/ext-apps` 2.0.3, `/inspector` 2.10.1 |
| S11 | https://pypi.org/pypi/mcp/json | Python `mcp` 2.3.0 (2026-10-02) |

## Amazon Alexa+ (context only: the tooling is gated for participants)

| ID | URL | Used for |
|---|---|---|
| S12 | https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html | Alexa+ targets MCP 2025-11-25, uses Streamable HTTP, supports MCP Apps, `alexa-ai deploy` |
| S13 | https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-design-guide.html | Tool design guidance: one intent per tool, explicit errors, minimal schemas |
| S14 | https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-tools-schema-data-design.html | Schema and data design ("declare only what you honor") |
| S15 | https://developer.amazon.com/alexaplus/blogs/2026/07/alexa-plus-new-ways-to-build-experiences | Preview status, launch partners, Amazon Wallet |

The S13 and S14 claims come from search-result excerpts. I did not read those pages in full; read them before building.

## Market and comparables (secondary)

| ID | URL | Used for |
|---|---|---|
| S16 | https://www.aboutamazon.com/md/news/devices/alexa-together-is-helping-bridge-the-miles-between-families | Alexa Together discontinued (May 21, 2025 update on that page) |
| S17 | https://www.mobihealthnews.com/news/amazon-ends-support-third-party-hipaa-compliant-alexa-program | Amazon ended its HIPAA-eligible skills program, a scoping risk for health ideas |
| S18 | https://dala.care/blog/dala.care-the-first-mcp-enabled-home-care-platform | Commercial MCP-enabled home-care platform (B2B, agency-facing) |
| S19 | https://glama.ai/mcp/servers/mcp4py217d | SafeSight MCP: doctor appointment booking tools, no family coordination |
| S20 | https://www.androidcentral.com/what-alexa-together-and-how-it-different-alexa-care-hub | Care Hub to Alexa Together history |

## Local environment (verified by command on 2026-10-10)

`node v26.3.0`, `npm 11.16.0`, `pnpm 11.9.0`, `python3 3.13.5`, `uv 0.11.21`, `git 2.52.0`, `gh 2.95.0` (logged in as `shro-2002`), `docker 29.5.3` (daemon not running), `ngrok 3.39.8`. Missing: `aws` CLI, `sam`, `cloudflared`.
