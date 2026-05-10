# PATTERNS.md — Reusable Code Patterns

These are the recurring implementation patterns in this codebase. Use them whenever the situation applies.

---

## 1. Lazy Groq Client Initialization

Never initialize the Groq client at module load time. Use a lazy singleton so missing env vars raise a clear error at call time, not at import time.

```python
_client = None

def _get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY environment variable is not set")
        _client = Groq(api_key=api_key)
    return _client
```

**Where used:** All agents — `transcription_agent.py`, `translation_agent.py`, `quality_review_agent.py`.

**Why:** `load_dotenv()` in `main.py` must run before agents are imported. Lazy init ensures the key is available when the first actual call is made.

---

## 2. Groq Word-Timestamp Normalization

Groq Whisper returns words as `dict` in some SDK versions, objects in others. Always normalize both:

```python
words = []
raw_words = getattr(transcription, "words", None) or []
for w in raw_words:
    if isinstance(w, dict):
        words.append({"word": w["word"], "start": w["start"], "end": w["end"]})
    else:
        words.append({"word": w.word, "start": w.start, "end": w.end})
```

**Where used:** `backend/agents/transcription_agent.py` lines 52–57.

---

## 3. Failsafe Pipeline Step

Any agent step that is an enhancement (not core delivery) must be wrapped so a failure degrades gracefully instead of crashing:

```python
result = default_value
try:
    result = agent.run(...)
except Exception as e:
    logger.warning("Agent failed (using default): %s", e)
# continue with result (may be default)
```

**Where used:** Quality review in `orchestrator.py` lines 72–79. Translation failsafe lines 64–68.

---

## 4. STT WebSocket Relay

All STT streaming (Deepgram, AssemblyAI) goes through `_ws_relay()` in `main.py`. To add a new STT provider, implement a `parse_fn(payload) -> (text, is_final)` and call:

```python
await _ws_relay(websocket, stt_url, headers, room_id, user_id, parse_fn)
```

Never duplicate the audio-relay + transcript-inject logic — extend `_ws_relay` instead.

**Where defined:** `backend/main.py` lines 610–656.

---

## 5. Language Routing Guard

When adding a new language code, update all three places in sequence:

1. `_AAI_LANGS` set in `main.py` line 660 — if AssemblyAI handles it
2. `_NOVA2_LANGS` set in `main.py` lines 663–667 — if Deepgram supports it natively
3. `_SUPPORTED` dict in `language_detection_agent.py` lines 5–22 — so lingua can detect it
4. `LANG_NAMES` dict in `translation_agent.py` and `quality_review_agent.py` — for LLM prompts
5. `_GOOGLE_LANG` dict in `main.py` lines 53–58 — for Google Cloud STT BCP-47 mapping

Missing any one of these causes silent mis-routing or fallback to English.

---

## 6. Quality Review + Retry Pattern

The standard translation quality loop: try once, review, retry once with critique if flagged.

```python
MAX_RETRIES = 1

translation = translation_agent.run(text, source, target, strict=True)

for _ in range(MAX_RETRIES):
    try:
        review = quality_review_agent.run(text, translation, source, target)
    except Exception:
        review = {"passed": True, "critique": ""}
        break
    if review["passed"]:
        break
    try:
        translation = translation_agent.run(
            text, source, target, critique=review["critique"], strict=True
        )
    except Exception:
        break
```

**Where used:** `orchestrator.py` lines 70–89.

---

## 7. Hallucination Pre-Filter

Before sending any STT output to the pipeline, check against the static blocklist and minimum length:

```python
_HALLUCINATIONS = {
    "", ".", " ", "you", "you.", "uh.", "hmm.", "um.", ...
}

text = transcription.text.strip()
if text.lower() in _HALLUCINATIONS or len(text) < 3:
    text = ""  # discard — do not send to pipeline
```

**Where used:** `backend/agents/transcription_agent.py` lines 7–14, 47–49.

---

## 8. LLM Verdict Parsing (Defensive)

LLM responses are not guaranteed to match exact expected strings. Always use `.upper().startswith()`:

```python
# BAD — breaks on "pass\n", "Pass", "PASS."
if verdict == "PASS":

# GOOD
if verdict.upper().startswith("PASS"):
    return {"passed": True, "critique": ""}
critique = verdict.replace("FAIL:", "").strip()
return {"passed": False, "critique": critique}
```

**Where used:** `backend/agents/quality_review_agent.py` lines 51–54.

---

## 9. Room State Access Pattern

Always guard against the user_id or room being absent before accessing room state. Rooms can be cleaned up between async steps:

```python
room = _rooms.get(room_id)
if not room:
    return
my_info = room["info"].get(user_id)
if not my_info:
    return
```

**Where used:** `inject_speech()` in `main.py`, message handlers in `conversation_ws()`.

---

## 10. Global Browser Drop Blocker

Any page with a drag-and-drop zone must add these two listeners to prevent accidental navigation:

```js
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => {
  if (!dropZone.contains(e.target)) e.preventDefault();
});
```
