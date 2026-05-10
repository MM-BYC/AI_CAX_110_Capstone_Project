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
- `GROQ_API_KEY` — Groq LLM + Whisper STT
- `DEEPGRAM_API_KEY` — primary streaming STT for all non-Tagalog languages
- `ASSEMBLYAI_API_KEY` — streaming STT for Tagalog (`tl`)
- `GOOGLE_CREDENTIALS_JSON` — Google Cloud Speech STT (JSON string, paste ADC file content)

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

STT routing:
- `tl` → AssemblyAI real-time (Deepgram lacks native Tagalog)
- All others → Deepgram Nova-2 (`language=<code>` or `detect_language=true` for unknowns)

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
| `backend/main.py` lines 659–746 | Any STT routing or WebSocket change |
| `backend/agents/orchestrator.py` | Any pipeline change |
| `DECISIONS.md` | Before adding a new dependency or service |
| `TROUBLESHOOTING.md` | Before writing Groq, Deepgram, or AssemblyAI code |
| `API_CONTRACTS.md` | Before adding or modifying any endpoint |
