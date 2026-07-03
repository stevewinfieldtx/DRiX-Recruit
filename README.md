# DRiX Recruit

Score a reseller/partner for a vendor's partner program — focused on **one specific product** — then, if they're a good fit, get five *defended* recruitment strategies and a full outreach kit.

Standalone app. It **borrows** the proven plumbing from DRiX Ready Leads (URL ingest, LLM client, central DRiX Auth, Postgres persistence, the chat/voice coach) but has its **own** folder, server, database, and pages. No runtime dependency on the Leads app.

## The flow

1. **Inputs** — three URLs: the **vendor** (whose partner program you recruit into), the **product** (what you want them to sell), and the **partner** (the reseller you're evaluating). Optionally upload PDF / Word / PPTX / TXT material about the vendor or the partner.
2. **Fit score (0–100)** — a weighted, *cited* assessment across technology alignment, market/vertical overlap, portfolio fit, business-model fit, and capacity/credibility. It shows its work — every sub-score cites the source facts.
3. **The 60 gate** — below the threshold (`GATE_THRESHOLD`, default 60) it **stops and explains why**, then offers an explicit **override** to generate strategies anyway.
4. **Five defended strategies** — each with the concrete approach, *why it works for this specific partner*, cited evidence, and the role inside the partner to aim at. You pick one.
5. **Outreach kit** — for the chosen strategy: an **entry point** (how to approach, who to approach, what tone), **three levels of discovery questions** (each with why you ask it, the expected response, the contrary response, and how to pivot), a **5-email drip** (goal: earn the meeting), and **two phone scripts**.
6. **Coach** — a context-aware **chat** engine and an ElevenLabs **voice** agent that **share one memory**: each knows what was discussed in the other.

## Shared chat ↔ voice memory

The server is the single source of truth (`recruit_memory` table).
- **Chat** loads the full memory (chat + voice) each turn and writes both turns back.
- **Voice** is provisioned with the full memory baked into the agent's prompt, so it starts every call knowing everything said so far.
- When a voice call ends, ElevenLabs posts the transcript to `/api/recruit-voice/webhook`, which appends those turns to the shared memory.

Sync is at the **session boundary** — each agent knows what the other discussed as of the last call/message (not mid-call real-time).

## Run it locally

```bash
cd drix-recruit
npm install
cp .env.example .env      # set OPENROUTER_API_KEY + OPENROUTER_MODEL_ID
# For a quick test without the central auth service or a DB:
#   RECRUIT_DEV_OPEN=true   (skips the auth wall — DEV ONLY)
#   leave DATABASE_URL blank (in-memory, no persistence)
npm start                 # http://localhost:3002
```

For the full experience set `DATABASE_URL` (its own Railway Postgres) and the central-auth vars, and (optionally) the ElevenLabs vars for voice.

## Endpoints

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/recruit-flow` | SSE: ingest 3 URLs → score → gate → 5 strategies |
| POST | `/api/recruit-outreach` | Entry point + 3-level questions + 5-email drip + phone scripts |
| POST | `/api/recruit-chat` | Context-aware chat coach (shares memory with voice) |
| POST | `/api/recruit-voice/provision` | Create an ElevenLabs voice agent seeded with shared memory |
| POST | `/api/recruit-voice/webhook` | ElevenLabs post-call transcript → shared memory |
| POST | `/api/upload-doc` | Extract text from PDF/DOCX/PPTX/TXT |
| GET | `/api/recruit/:run_id` | Fetch a saved run |
| GET | `/healthz` | Health/status |

## Config

Model is env-driven (`OPENROUTER_MODEL_ID`) — swap it any time. Gate threshold, database, auth, and voice are all configured in `.env` (see `.env.example`).
# DRiX-Recruit
