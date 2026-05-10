# Project Skills — AI Real-Time Translation Meeting App

Four core capabilities that drive the voice-to-voice translation pipeline.

---

## 1. Active Listening

**What it is:** The mic streams audio continuously to the STT service the moment a participant unmutes. There is no push-to-record or silence-triggered batch; the connection stays open for the entire session.

**How it is implemented today:**

| Path | Code |
| ---- | ---- |
| iOS / Chrome | `AudioContext` → `ScriptProcessorNode` (4 096-sample buffer) → raw PCM Int16 → WebSocket `/ws/deepgram/{room}/{user}` |
| Firefox / Android | Web Speech API `SpeechRecognition` (continuous mode) |
| Backend relay | `_ws_relay()` in `backend/main.py` proxies PCM to Deepgram or AssemblyAI and calls `inject_speech()` on every `speech_final` event |

**Known gap:** `ScriptProcessorNode` is deprecated; the modern replacement is `AudioWorkletNode`. It does not affect correctness today but is the upgrade path.

---

### Deepgram — Primary STT Engine

**Role:** Deepgram Nova-2 is the default real-time Speech-to-Text engine for the entire application. It is not a fallback or a detection-only service — it handles every language except Tagalog.

**Why Deepgram:** Nova-2 delivers ~300 ms streaming latency with `interim_results` and `endpointing`, making it the fastest path to a `speech_final` event that triggers the translation pipeline.

**WebSocket endpoint:** `GET /ws/deepgram/{room_id}/{user_id}?language=<code>&sample_rate=16000`
This single endpoint routes internally to Deepgram or AssemblyAI based on the language code.

**Deepgram connection parameters (`backend/main.py` line 731):**

```text
wss://api.deepgram.com/v1/listen
  ?encoding=linear16
  &sample_rate=<rate>
  &channels=1
  &model=nova-2-general
  &language=<code>          ← explicit code when language ∈ _NOVA2_LANGS
  OR &detect_language=true  ← fallback for any unsupported / unknown language
  &interim_results=true
  &endpointing=300
  &smart_format=true
```

**Language routing (`backend/main.py` lines 659–667):**

| Language | STT service | Param |
| -------- | ----------- | ----- |
| `tl` (Tagalog) | AssemblyAI real-time | — (Deepgram Nova-2 lacks native `tl`) |
| Any code in `_NOVA2_LANGS` (35 languages) | Deepgram Nova-2 | `language=<code>` |
| Anything else | Deepgram Nova-2 | `detect_language=true` |

`_NOVA2_LANGS` covers: `bg ca cs da de el en es et fi fr hi hr hu id it ja ko lt lv ms nl no pl pt ro ru sk sl sv th tr uk vi zh`

**env var required:** `DEEPGRAM_API_KEY`

---

## 2. Active Translation Voice-to-Voice

**What it is:** Every final transcript triggers the full translation pipeline and is immediately converted to speech in each listener's language. The pipeline runs per-participant so Room A (Spanish) → Room B (English) and Room B (English) → Room A (Spanish) happen in parallel.

**How it is implemented today:**

```text
STT (Deepgram / AssemblyAI)  ← streaming, ~300 ms
        ↓  inject_speech()
Conversation Agent            ← removes fillers, normalises text
        ↓
Language Detection Agent      ← confirms / overrides source language
        ↓
Translation Agent (Groq LLM)  ← llama-3.3-70b-versatile, temp=0, ~200 ms
        ↓
Quality Review Agent          ← flags hallucinations; retries once if needed
        ↓
TTS Agent                     ← returns audio bytes to each listener
```

End-to-end latency target: **≤ 700 ms** (Deepgram 300 ms + Groq LLM 200 ms + TTS 200 ms).

**Language routing:**

| Language | STT service | Why |
| -------- | ----------- | --- |
| Tagalog (`tl`) | AssemblyAI real-time | Deepgram Nova-2 does not support `tl` natively |
| All others in `_NOVA2_LANGS` | Deepgram Nova-2 with `language=` param | Best accuracy + lowest latency |
| Unsupported / unknown | Deepgram Nova-2 with `detect_language=true` | Graceful fallback |

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
