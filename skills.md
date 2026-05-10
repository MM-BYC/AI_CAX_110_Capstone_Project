# Project Skills — AI Real-Time Translation Meeting App

Four core capabilities that drive the voice-to-voice translation pipeline.

---

## 1. Active Listening

**What it is:** The mic streams audio continuously to the STT service the moment a participant unmutes. There is no push-to-record or silence-triggered batch; the connection stays open for the entire session.

**How it is implemented today:**

| Path | Code |
| ---- | ---- |
| iOS / Safari / Chrome | `AudioContext` → `ScriptProcessorNode` (4 096-sample buffer) → raw PCM Int16 → WebSocket `/ws/stt/{room}/{user}` |
| Firefox / Android | Web Speech API `SpeechRecognition` (continuous mode) |
| Backend | `stt_stream_endpoint` in `backend/main.py` feeds PCM into Google Cloud Speech `streaming_recognize` and calls `inject_speech()` on every final transcript |

**Known gap:** `ScriptProcessorNode` is deprecated; the modern replacement is `AudioWorkletNode`. It does not affect correctness today but is the upgrade path.

---

### Google Cloud Speech — Single STT Engine

**Role:** Google Cloud Speech is the only real-time Speech-to-Text engine. It handles all 16 supported languages, including Tagalog.

**Why Google Cloud Speech:** Native support for every supported language (e.g. `tl → fil-PH`), gRPC streaming with ~300–500 ms latency, and automatic 270-second session restarts to dodge Google's 5-minute hard cap.

**WebSocket endpoint:** `GET /ws/stt/{room_id}/{user_id}` (no URL params).

**Connect protocol:**

1. Open WebSocket.
2. Send a single JSON config message: `{"sample_rate": 16000, "language": "tl"}`.
3. Stream raw LINEAR16 PCM as binary frames.

The backend reads `_GOOGLE_LANG[language]` for the BCP-47 code and feeds the audio queue into `client.streaming_recognize()`.

**env var required:** `GOOGLE_CREDENTIALS_JSON` (the full service-account JSON, parsed by `_make_speech_client()` on every connect).

---

## 2. Active Translation Voice-to-Voice

**What it is:** Every final transcript triggers the full translation pipeline and is immediately converted to speech in each listener's language. The pipeline runs per-participant so Room A (Spanish) → Room B (English) and Room B (English) → Room A (Spanish) happen in parallel.

**How it is implemented today:**

```text
Google Cloud Speech            ← streaming, ~300–500 ms
        ↓  inject_speech()
Conversation Agent             ← removes fillers, normalises text
        ↓
Language Detection Agent       ← confirms / overrides source language
        ↓
Translation Agent (Groq LLM)   ← llama-3.3-70b-versatile, temp=0, ~200 ms
        ↓
Quality Review Agent           ← flags hallucinations; retries once if needed
        ↓
TTS Agent                      ← returns audio bytes to each listener
```

End-to-end latency target: **≤ 900 ms** (Google STT 400 ms + Groq LLM 200 ms + TTS 200 ms).

All 16 languages route through the same `/ws/stt/` endpoint — no per-language routing logic. `_GOOGLE_LANG` in `backend/main.py` maps the app's ISO 639-1 codes (e.g. `tl`) to Google's BCP-47 codes (e.g. `fil-PH`).

---

## 3. Hallucination Elimination

**What it is:** Three layers of filtering prevent nonsense text from being translated and broadcast.

**Layer 1 — Whisper static blocklist** (`transcription_agent.py` lines 8-14):
Short strings that Whisper emits on silence or very short audio are dropped before the pipeline starts.

```python
_HALLUCINATIONS = {
    "", ".", " ", "you", "you.", "uh.", "hmm.", "um.",
    "thank you.", "thank you", "thanks.", "thanks",
    "bye.", "bye", "goodbye.", "goodbye",
    "the.", "the", "okay.", "okay", ...
}
```

Any transcript shorter than 3 characters is also discarded.

**Layer 2 — Conversation Agent** (`conversation_agent.py`):
Removes filler words, normalises whitespace, and strips artefacts before the text reaches the translation step.

**Layer 3 — Quality Review Agent + retry** (`quality_review_agent.py`, `orchestrator.py` lines 72-89):
After translation, a second Groq LLM call scores the output. If it fails, the translation is re-run once with the critique attached. Any API error on the review step is treated as a pass so delivery is never blocked.

---

## 4. LangGraph Capability

**What it is:** [LangGraph](https://github.com/langchain-ai/langgraph) is a graph-based state machine for multi-agent LLM pipelines. It replaces a hand-written `for` loop + `if/else` routing with typed `StateGraph` nodes, conditional edges, and built-in retry/checkpoint support.

**Current state:** The orchestrator (`backend/agents/orchestrator.py`) is a plain Python function. It works correctly but has limitations:

- The retry loop (lines 72-89) is ad-hoc
- Running translations to multiple target languages is sequential
- No observability into which node failed

**What LangGraph would unlock:**

| Capability | Benefit for this app |
| ---------- | -------------------- |
| `StateGraph` nodes for each agent | Each step is independently testable and replaceable |
| Conditional edges | `quality_review → pass → deliver` vs `quality_review → fail → retry_translation` expressed as a graph, not nested `if/for` |
| `fan-out` parallel edges | Translate to all N target languages simultaneously instead of in a loop |
| `MemorySaver` checkpoints | Resume a failed pipeline without re-running STT or re-fetching audio |
| LangSmith tracing | See exactly which node consumed latency in every real conversation |

**Migration path** (non-breaking):

1. Replace `run_conversation_pipeline()` with a `StateGraph` that has nodes: `clean → detect → translate → review → [retry | deliver]`
2. Add a `fan_out` edge after `translate` to run all target-language TTS calls in parallel
3. Keep the existing `inject_speech()` as the terminal deliver node so the WebSocket layer is unchanged

**Verdict:** The project runs correctly without LangGraph today. The clearest near-term win would be the parallel fan-out — if a room has 5 participants speaking 3 different languages, the current code translates sequentially; LangGraph fan-out cuts that latency by 3×.
