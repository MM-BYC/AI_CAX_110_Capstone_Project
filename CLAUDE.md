# CLAUDE.md — AI Real-Time Translation Meeting App

Instructions for Claude Code. Follow these in every session without being reminded.

---

## Project Layout

```
AI_CAX_110_Capstone_Project/
├── backend/
│   ├── main.py               # FastAPI app — all HTTP + WebSocket routes
│   ├── agents/
│   │   ├── orchestrator.py   # Pipeline coordinator (text / audio / conversation / keyboard)
│   │   ├── transcription_agent.py   # Groq Whisper STT (audio file → text)
│   │   ├── translation_agent.py     # Groq LLM translation
│   │   ├── quality_review_agent.py  # Groq LLM hallucination review
│   │   ├── language_detection_agent.py  # lingua offline detector
│   │   ├── conversation_agent.py    # Filler-word cleaner
│   │   └── keyboard_agent.py        # Keyboard-input cleaner
│   ├── speech.py             # Standalone Groq Whisper helper (legacy, not in hot path)
│   ├── room_manager.py
│   └── requirements.txt
├── frontend/                 # Static SPA served by FastAPI
├── CLAUDE.md                 # ← you are here
├── skills.md                 # Capability documentation
├── DECISIONS.md              # Architecture decision records
├── TROUBLESHOOTING.md        # Known bugs + fixes
├── PATTERNS.md               # Reusable code patterns
└── API_CONTRACTS.md          # All API endpoints and WebSocket contracts
```

---

## Non-Negotiable Rules

### Git
- After every code change, commit **and push** all modified files (source, assets, configs) without waiting to be asked.
- Never leave related files uncommitted.

### Deployment — Render Free Tier
- **No `apt-get`** in build commands — read-only filesystem.
- **`render.yaml` is ignored** for manually created services; set Build/Start commands in the dashboard.
- Build Command: `pip install -r backend/requirements.txt`
- Start Command: `cd backend && uvicorn main:app --host 0.0.0.0 --port $PORT`
- **Never use `uv`** — Render auto-runs `uv sync` on `pyproject.toml` and OOMs.
- **Never use `openai-whisper`** — pulls PyTorch (~2 GB), OOMs at 512 MB. Use Groq's hosted `whisper-large-v3`.

### Environment Variables (always required on Render)
- `GROQ_API_KEY` — Groq LLM + Groq Whisper (uploaded audio files)
- `GOOGLE_CREDENTIALS_JSON` — Google Cloud Speech (streaming STT for all 16 languages)
- `VOICE_CLONE_ENABLED=0` — must be set on Render free tier; XTTS-v2 needs ~3 GB RAM and will OOM otherwise. The app falls back to the browser Web Speech API automatically.

### Voice Cloning (optional, off on free tier)

- Implementation: `backend/voice_clone.py` — standalone module wrapping Coqui XTTS-v2.
- Extra deps: `pip install -r backend/requirements-voice.txt` (pulls torch + librosa + coqui-tts).
- Endpoints: `GET /api/v1/voices/status`, `POST /api/v1/voices/enroll`, `POST /api/v1/voices/analyze`, `POST /api/v1/voices/synthesize`.
- License: XTTS-v2 is CPML (non-commercial). Set `COQUI_TOS_AGREED=1` to auto-accept on first model download.
- CLI: `python backend/voice_clone.py status | analyze | enroll | speak` for ad-hoc testing.

### Load Order in `main.py`
- `load_dotenv()` **must** run before any agent import — Groq clients initialize at module level.

### UI Theme — Professional Light
Do not revert to dark theme. Use these tokens for all CSS:
- Page bg: `#f5f7fa` | Cards: `#ffffff` | Border: `#e5e7eb`
- Primary text: `#111827` | Secondary: `#6b7280` | Muted: `#9ca3af`
- Accent: `#6366f1` (indigo) | Input bg: `#ffffff`, border: `#d1d5db`
- Btn secondary: `#f3f4f6` bg, `#374151` text

---

## Language Support

The app supports **16 languages**: `en es fr de it pt zh ja ko ar ru hi nl pl tr tl`

All 16 languages stream through **Google Cloud Speech** via `/ws/stt/{room}/{user}`. The mapping from app code to Google's BCP-47 lives in `_GOOGLE_LANG` in `backend/main.py` (e.g. `tl → fil-PH`).

---

## Run Locally

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
# Frontend served at http://localhost:8000
```

---

## Key Files to Read Before Any Change

| File | Read before touching |
| ---- | ------------------- |
| `backend/main.py` `/ws/stt/` route | Any STT or WebSocket change |
| `backend/agents/orchestrator.py` | Any pipeline change |
| `DECISIONS.md` | Before adding a new dependency or service |
| `TROUBLESHOOTING.md` | Before writing Groq or Google Cloud Speech code |
| `API_CONTRACTS.md` | Before adding or modifying any endpoint |
