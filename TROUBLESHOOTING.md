# TROUBLESHOOTING.md — Known Bugs and Fixes

Every entry here was a real production failure. Read before writing Groq, Deepgram, AssemblyAI, or Render code.

---

## Groq Whisper

### Bug: `AttributeError: 'dict' object has no attribute 'word'`

**Symptom:** Crash when accessing word timestamps from `verbose_json` response.

**Root cause:** Groq Whisper `verbose_json` returns words as plain `dict`, not objects. OpenAI SDK returns objects.

**Fix:** Always handle both:

```python
for w in raw_words:
    if isinstance(w, dict):
        words.append({"word": w["word"], "start": w["start"], "end": w["end"]})
    else:
        words.append({"word": w.word, "start": w.start, "end": w.end})
```

**Where fixed:** `backend/agents/transcription_agent.py` lines 52–57

---

### Bug: Words concatenated without spaces

**Symptom:** Output like `"helloworldhow"` instead of `"hello world how"`.

**Root cause:** Groq Whisper word tokens do NOT include leading spaces. OpenAI's do.

**Fix:** Always `" ".join(words)` not `"".join(words)`. Also `.strip()` each word defensively.

---

### Bug: Quality review crashes pipeline

**Symptom:** Entire translation pipeline fails when quality review hits a rate limit.

**Root cause:** Unguarded exception propagates up from `quality_review_agent.run()`.

**Fix:** Always wrap in try/except; treat any error as a pass:

```python
try:
    review = quality_review_agent.run(...)
except Exception:
    review = {"passed": True, "critique": ""}
```

**Where fixed:** `backend/agents/orchestrator.py` lines 73–79

---

### Bug: Quality review always fails (never matches "PASS")

**Symptom:** Every translation gets flagged even when correct.

**Root cause:** LLM reply format varies — `"pass"`, `"Pass"`, `"PASS.\n"`. Exact `== "PASS"` misses all of them.

**Fix:** Use `verdict.upper().startswith("PASS")`.

**Where fixed:** `backend/agents/quality_review_agent.py` line 51

---

### Bug: Groq client raises `AuthenticationError` at startup

**Symptom:** App crashes immediately on import; `GROQ_API_KEY` is set in `.env`.

**Root cause:** `load_dotenv()` was called AFTER agent imports. Groq clients initialize at module level.

**Fix:** `load_dotenv()` must be the first statement in `main.py`, before any `from agents import ...`.

**Where fixed:** `backend/main.py` line 61

---

## Deepgram

### Bug: HTTP 405 Method Not Allowed on WebSocket connect

**Symptom:** Deepgram WebSocket handshake fails with 405.

**Root cause:** `model=whisper-large` was passed — Deepgram does not accept Whisper model names on the Nova-2 endpoint.

**Fix:** Use `model=nova-2-general`. Never pass `whisper-*` to Deepgram.

---

### Bug: HTTP 400 Bad Request for unsupported language codes

**Symptom:** Deepgram rejects `language=tl` (Tagalog) or other unsupported codes with 400.

**Root cause:** Deepgram Nova-2 does not support all ISO 639-1 codes natively.

**Fix:** Route `tl` to AssemblyAI. For all other unsupported codes, fall back to `detect_language=true`.

**Where fixed:** `backend/main.py` lines 659–667, 729

---

## AssemblyAI

### Bug: HTTP 404 on temp-token endpoint

**Symptom:** `POST https://api.assemblyai.com/v2/realtime/token` returns 404.

**Root cause:** AssemblyAI deprecated their entire `/v2/realtime/` API including the token endpoint.

**Fix:** Upgraded to AssemblyAI v3 streaming. API key goes directly in the `Authorization` header, no token fetch needed.

**Where fixed:** `backend/main.py` AssemblyAI block (~line 684)

---

### Bug: AssemblyAI v3 closes connection immediately; mic auto-closes without a click

**Symptom:** `connection open` then `connection closed` in server logs within the same second for `language=tl`. Mic button turns off without user interaction.

**Root cause 1:** AssemblyAI v3 requires `encoding=pcm_s16le` in the URL query string. Without it the stream is rejected immediately.

**Root cause 2:** `parse_aai` checked `message_type == "FinalTranscript"` (v2 field name). AssemblyAI v3 sends `type == "final_transcript"` (lowercase, different key). Connection stayed open but no transcripts were injected.

**Root cause 3:** The permanent `onclose` handler in `app.js` called `convStopIosMic()` whenever the STT WebSocket dropped — this turned off the mic button without a user click.

**Fix (backend):** Add `encoding=pcm_s16le` to the AssemblyAI v3 URL. Update `parse_aai` to accept both `message_type:"FinalTranscript"` (v2) and `type:"final_transcript"` (v3).

**Fix (frontend):** Replace the `convStopIosMic()` call in the permanent onclose handler with `_scheduleIosDgReconnect()`. Mic state now only changes on user clicks. STT WebSocket auto-reconnects up to 6 times with exponential backoff (1 s, 2 s … 8 s cap) before giving up.

**Where fixed:** `backend/main.py` lines 693–703; `frontend/app.js` iOS mic section

---

### Bug: AssemblyAI closes every connection with 3006

**Symptom:** `STT msg type=Error text=''` followed by `received 3006 (registered) See Error message for details` immediately after every connect. Infinite reconnect loop, no transcripts.

**Root cause:** WebSocket close code 3006 = "Not Authorized". The `ASSEMBLYAI_API_KEY` is invalid, expired, or the account does not have real-time streaming access (paid feature).

**Fix:** Set `_AAI_LANGS = set()` in `main.py`. All languages including Tagalog route to Deepgram with `detect_language=true`. Deepgram auto-detects the language from audio — no explicit code needed.

**Where fixed:** `backend/main.py` `_AAI_LANGS` definition.

---

## Render Deployment

### Bug: Build fails with "Read-only file system"

**Symptom:** `apt-get update` fails during build.

**Root cause:** Render free tier has a read-only filesystem. `apt-get` cannot write.

**Fix:** Remove `apt-get` from build commands. Pre-installed system packages (including ffmpeg) are already available.

---

### Bug: `uv sync` error "No file/folder found for package"

**Symptom:** Build fails even with a custom `buildCommand`.

**Root cause:** Render's Python buildpack auto-detects `pyproject.toml` and runs `uv sync --no-root` regardless of build command.

**Fix:** Do not use `pyproject.toml`. Use `pip install -r backend/requirements.txt` and keep `requirements.txt` as the only dependency manifest.

---

### Bug: App OOMs during startup on Render free tier

**Symptom:** Service crashes with memory error shortly after deploy.

**Root cause:** `openai-whisper` (local Whisper) was in requirements — it pulls PyTorch (~2 GB) and exceeds the 512 MB free-tier RAM limit.

**Fix:** Never use `openai-whisper`. Use `groq` SDK with `model="whisper-large-v3"` (hosted, no PyTorch).

---

## Browser / Frontend

### Bug: Dropping a file outside the drop zone navigates the browser away

**Symptom:** Accidentally dragging a file over the page body navigates away, losing session state.

**Root cause:** Default browser drag-and-drop handles the drop as a file open.

**Fix:** Add global blockers:

```js
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => {
  if (!dropZone.contains(e.target)) e.preventDefault();
});
```
