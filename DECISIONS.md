# DECISIONS.md — Architecture Decision Records

Each entry records a choice, the alternatives considered, and the reason. Read before adding a new dependency or service.

---

## STT Service Split: Deepgram (primary) + AssemblyAI (Tagalog)

**Decision:** Use Deepgram Nova-2 for all languages except Tagalog; use AssemblyAI real-time for Tagalog.

**Why not Deepgram for Tagalog:** Deepgram Nova-2 does not support `language=tl`. Passing it returns HTTP 400. `detect_language=true` may identify Tagalog audio, but accuracy is lower than a dedicated model.

**Why not AssemblyAI for everything:** Deepgram Nova-2 has lower latency (~300 ms) and explicit language-code support for 35 languages. AssemblyAI requires a REST round-trip to fetch a temp token before opening the WebSocket, adding ~200 ms overhead on every session start.

**Why not Google Cloud Speech for all:** GCS requires a service account JSON credential (`GOOGLE_CREDENTIALS_JSON`), which adds operational complexity. Deepgram key-based auth is simpler. GCS is retained as a third STT path for iOS clients via `/ws/stt/` because it handles the iOS audio format cleanly.

**Trade-off accepted:** Two STT vendors in production increases operational surface. Mitigated by the single WebSocket endpoint (`/ws/deepgram/`) that routes internally — the frontend does not know which vendor is used.

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

**Trade-off accepted:** Groq Whisper is a network call (adds ~50–100 ms). Acceptable because the Deepgram streaming path handles real-time STT; Groq Whisper is only used for uploaded audio files.

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
