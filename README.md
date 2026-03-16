# AI Language Translator — Capstone Project

An agentic AI translation system powered by **Groq AI** and **OpenAI Whisper**.

## Project Structure

```text
AI_CAX_110_Capstone_Project/
├── backend/
│   ├── main.py          # FastAPI server & API endpoints
│   ├── agent.py         # Agentic translation pipeline
│   ├── translator.py    # Groq AI translation tool
│   ├── speech.py        # Whisper speech-to-text tool
│   ├── requirements.txt
│   └── .env.example
└── frontend/
    ├── index.html       # UI with language dropdowns & text input
    ├── styles.css       # Dark-theme styling
    └── app.js           # API calls & UI logic
```

# How to run

## Setup

### 1. Backend

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env
# Edit .env and add your GROQ_API_KEY
uvicorn main:app --reload <-- run ./start.sh
```

Get a free Groq API key at [console.groq.com](https://console.groq.com)

### 2. Frontend

Open `frontend/index.html` directly in a browser, or serve it:

```bash
cd frontend
uv run python -m http.server 3000
# Then open http://localhost:3000
```

## API Endpoints

| Method | Endpoint                                          | Description              |
|--------|---------------------------------------------------|--------------------------|
| POST   | `/translate_text?source=es&target=en&text=...`    | Translate plain text     |
| POST   | `/translate_audio?source=es&target=en` + file     | Translate spoken audio   |

Interactive docs: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)

## Agentic Pipeline

```text
Input (text or audio)
       ↓
Detect audio vs text
       ↓
Whisper speech-to-text  (audio only)
       ↓
langdetect language detection
       ↓
Groq AI translation (llama3-8b-8192)
       ↓
Return result
```

## Supported Languages

English · Spanish · French · German · Italian · Portuguese · Chinese · Japanese · Korean · Arabic · Russian · Hindi · Dutch · Polish · Turkish

sample korean:
사회초년생 포섭해 허위 임대차 계약서 꾸며 85억 대출받아 

sample japanese:
「NHKやさしいことばニュース」は、日本に住んでいる外国人の皆さんや、子どもたちに、できるだけやさしい日本語でニュースを伝えるサイトです。
sample polish:
W poniedziałkowym notowaniu światowego rankingu tenisistek Iga Świątek spadła z drugiego na trzecie miejsce, wyprzedziła ją Kazaszka Jelena Rybakina. Nadal prowadzi Białorusinka Aryna Sabalenka, która dzięki zwycięstwu w turnieju w Indian Wells powiększyła przewagę.