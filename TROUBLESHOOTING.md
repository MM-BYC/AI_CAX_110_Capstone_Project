# TROUBLESHOOTING.md — Known Bugs and Fixes

Every entry here was a real production failure. Read before writing Groq, Google Cloud Speech, or Render code.

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

## Google Cloud Speech (Streaming STT)

### Bug: WebSocket closes with `google-cloud-speech not installed`

**Symptom:** `/ws/stt/` closes immediately with code 1011 and reason "google-cloud-speech not installed".

**Root cause:** The `google-cloud-speech` package is missing from `backend/requirements.txt`, or the build did not install it.

**Fix:** Ensure `google-cloud-speech` is pinned in `requirements.txt` and the Render build command runs `pip install -r backend/requirements.txt`.

---

### Bug: WebSocket closes with `Google STT credentials not configured`

**Symptom:** `/ws/stt/` closes immediately with code 1011 and reason "Google STT credentials not configured".

**Root cause:** `GOOGLE_CREDENTIALS_JSON` env var is missing or contains invalid JSON.

**Fix:** Paste the full ADC service-account JSON (the entire `{...}` blob, no surrounding quotes) into the Render env var. `_make_speech_client()` parses it on every WebSocket connect.

---

### Bug: 5-minute hard cap on streaming sessions

**Symptom:** Streaming silently stops after ~5 minutes of continuous use. No transcripts fire.

**Root cause:** Google's `streaming_recognize` enforces a 5-minute hard limit per session.

**Fix:** Already handled. The `run_stt` thread restarts the session every 270 seconds; clients see no interruption.

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
