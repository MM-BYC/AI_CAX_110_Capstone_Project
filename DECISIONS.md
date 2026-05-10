# DECISIONS.md — Architecture Decision Records

Each entry records a choice, the alternatives considered, and the reason. Read before adding a new dependency or service.

---

## Streaming STT: Google Cloud Speech (single provider)

**Decision:** Use Google Cloud Speech for all 16 languages via `/ws/stt/{room}/{user}`. No second STT vendor.

**Why Google Cloud Speech:**
- Native support for every language the app supports, including Tagalog (`tl → fil-PH`). Deepgram Nova-2 does not support `tl`, and dropping `language=` falls back to garbage English guesses for Tagalog audio.
- Streaming via gRPC is low-latency (~300–500 ms) and reliable.
- Auto-restart of streaming sessions every 270 s avoids Google's 5-minute hard cap.

**Why not Deepgram Nova-2:** Lower per-stream cost and ~200 ms latency, but no Tagalog. Maintaining Deepgram for 15 languages plus a separate provider for `tl` doubled the operational surface and forced a brittle routing table that broke whenever Deepgram changed an accepted language code.

**Why not AssemblyAI:** Their real-time API is paid-tier only; the project's account returned `3006 Not Authorized` on every connect. Even with a paid account, this would re-introduce the two-vendor split.

**Trade-off accepted:** Slightly higher per-second cost than Deepgram, and a service-account JSON credential (`GOOGLE_CREDENTIALS_JSON`) is more operational overhead than a flat API key. Worth it for one provider that covers every language with consistent quality.

---

## LLM Provider: Groq (not OpenAI)

**Decision:** All LLM calls (translation, quality review) use Groq's hosted API with `llama-3.3-70b-versatile`.

**Why Groq:** Groq hardware delivers significantly lower inference latency than OpenAI at this model size — critical for the ≤700 ms end-to-end target. Groq also hosts Whisper (`whisper-large-v3`), consolidating STT and LLM under one API key.

**Why not OpenAI:** Higher latency at comparable cost. Whisper hosted by OpenAI works, but Groq's Whisper is faster and cheaper.

**Why not local LLM / Ollama:** Would require a GPU server; Render free tier is CPU-only with 512 MB RAM. Not viable.

---

## Whisper Model: `whisper-large-v3` (not local openai-whisper)

**Decision:** Use Groq-hosted `whisper-large-v3` via the API, never the `openai-whisper` Python package.

**Why:** The `openai-whisper` package installs PyTorch (~2 GB). Render free tier has 512 MB RAM — it OOMs during startup. Groq's hosted Whisper has no local dependencies and costs less per call.

**Trade-off accepted:** Groq Whisper is a network call (adds ~50–100 ms). Acceptable because real-time STT goes through Google Cloud Speech (`/ws/stt/`); Groq Whisper is only used for uploaded audio files.

---

## Language Detection: `lingua` (offline, not LLM-based)

**Decision:** Use the `lingua-language-detector` library for language detection, not a Groq LLM call.

**Why:** Lingua runs offline with no API call — adds ~0 ms to the pipeline. An LLM call would add ~200 ms per utterance just for detection, doubling latency on every message.

**Constraints applied:**
- Detector scoped to only the 16 supported languages (cannot return unsupported codes).
- Minimum confidence threshold: 0.15 — below this, fall back to the user's declared language.
- Minimum text length: 4 characters — shorter strings produce unreliable scores.
- Short phrases < 6 characters do not override the user's declared source language even if detected differently.

---

## Pipeline: Plain Python (not LangGraph)

**Decision:** The orchestrator (`backend/agents/orchestrator.py`) is a plain Python function, not a LangGraph `StateGraph`.

**Why plain Python now:** LangGraph adds a dependency and a learning curve. The current pipeline is linear and simple enough that a function with a retry loop is correct and readable.

**Why LangGraph later:** The clearest near-term gain is parallel fan-out — currently, translating one utterance to N target languages runs sequentially. LangGraph fan-out would run all N in parallel, cutting latency by N× for multi-participant rooms.

**Migration path documented in:** `skills.md` section 4 (LangGraph Capability).

---

## Conversation Pipeline: Failsafe Pass-Through on Every Agent Error

**Decision:** Any exception in the translation or quality-review step does not crash the pipeline — it returns the original (or partially translated) text instead.

**Why:** A live meeting cannot silently drop a message because of a transient API error. Delivering imperfect text is better than delivering nothing.

**Implemented in:** `backend/agents/orchestrator.py` lines 64–89.

---

## Frontend Serving: FastAPI StaticFiles (not a separate CDN/server)

**Decision:** The frontend SPA is served by the FastAPI backend as static files, mounted at `/`.

**Why:** Render free tier allows one web service. A separate frontend host would require a second service (or Netlify/Vercel). Consolidating avoids CORS complexity and keeps the deploy simple.

**Trade-off accepted:** Static files are served through Python/uvicorn, which is slightly less efficient than Nginx. Acceptable at this scale.

---

## Room ID Format: 6 uppercase alphanumeric characters

**Decision:** Room IDs are 6-character random strings from `[A-Z0-9]`.

**Why:** Short enough to share verbally in a meeting. ~2.1 billion combinations makes collision probability negligible at the expected scale (<1000 concurrent rooms).

**Collision guard:** `_gen_room_id()` loops until a non-colliding ID is found.
