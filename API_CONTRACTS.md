# API_CONTRACTS.md — Endpoint Reference

All HTTP and WebSocket endpoints exposed by `backend/main.py`. Update this file whenever an endpoint is added, removed, or its shape changes.

Base URL (production): your Render service URL
Base URL (local): `http://localhost:8000`

---

## HTTP Endpoints

### `GET /`
Serves `frontend/index.html`. Returns the SPA.

---

### `GET /api/health`
Health check.

**Response:**
```json
{ "status": "ok" }
```

---

### `GET /create_room`
Generate a new conversation room ID.

**Response:**
```json
{ "room_id": "AB3X7Q" }
```

Room IDs are 6 uppercase alphanumeric characters. They are created lazily — the room state is not allocated until the first participant connects via `/ws/conversation/{room_id}`.

---

### `POST /detect_language`
Run offline language detection on a string.

**Query params:**
| Param | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `text` | string | yes | The text to detect |

**Response:**
```json
{ "detected_language": "es" }
```

Returns an ISO 639-1 code from the 16 supported languages, or `"en"` as fallback.

---

### `POST /translate_text`
Fast text-to-text translation (no quality review, no filler cleaning). Used for real-time keystroke translation.

**Query params:**
| Param | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `source` | string | yes | ISO 639-1 source language |
| `target` | string | yes | ISO 639-1 target language |
| `text` | string | yes | Text to translate |

**Response:**
```json
{
  "original_text": "Hola mundo",
  "detected_language": "es",
  "translation": "Hello world",
  "words": []
}
```

---

### `POST /translate_audio`
Full audio-to-text-to-translation pipeline with quality review. Accepts an uploaded audio file.

**Form data:**
| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `source` | string (query) | yes | ISO 639-1 source language |
| `target` | string (query) | yes | ISO 639-1 target language |
| `file` | binary | yes | Audio file (any format Groq Whisper accepts) |

**Response:**
```json
{
  "original_text": "Hola mundo",
  "detected_language": "es",
  "translation": "Hello world",
  "words": [
    { "word": "Hola", "start": 0.0, "end": 0.3 },
    { "word": "mundo", "start": 0.4, "end": 0.8 }
  ],
  "quality": { "passed": true, "critique": "" }
}
```

---

### `POST /transcribe_audio`
Transcribe-only endpoint (no translation). Used by the iOS hot-mic pipeline; caller sends the text to `/ws/conversation/` as a speech message.

**Form data:**
| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `source` | string (query) | yes | ISO 639-1 language, or `"auto"` |
| `file` | binary | yes | Audio file |

**Response:**
```json
{ "text": "Hello world" }
```

Returns `{ "text": "" }` if the transcript is in the hallucination blocklist or shorter than 3 characters.

---

## WebSocket Endpoints

### `WS /ws/conversation/{room_id}`
Multi-user live conversation room. All signaling, speech, and translation happen here.

**Connect:** No query params. On connect, send a join message within 15 seconds or the server closes the connection.

#### Client → Server Messages

**Join (must be first message):**
```json
{
  "type": "join",
  "name": "Alice",
  "language": "en"
}
```

**Speech (STT final transcript):**
```json
{
  "type": "speech",
  "text": "Hello everyone"
}
```
Server translates `text` for every other participant and delivers a `message` event to each.

**Interim (in-progress STT):**
```json
{
  "type": "interim",
  "text": "Hello every..."
}
```
Server forwards to all other participants as-is (no translation).

**Keyboard (typed text, submitted):**
```json
{
  "type": "keyboard",
  "text": "Hello everyone"
}
```
Server runs keyboard pipeline (keyboard agent → language detection → translation) and delivers `message` to each participant.

**Typing indicator:**
```json
{
  "type": "typing",
  "is_typing": true
}
```

**Mic / camera state:**
```json
{ "type": "mic_on" }
{ "type": "mic_off" }
{ "type": "camera_on" }
{ "type": "camera_off" }
```

#### Server → Client Messages

**Joined (response to join, includes full room snapshot):**
```json
{
  "type": "joined",
  "user_id": "ABCD1234",
  "room": "AB3X7Q",
  "is_host": true,
  "users": [
    { "user_id": "ABCD1234", "name": "Alice", "language": "en", "is_host": true, "mic_on": false }
  ]
}
```

**User joined:**
```json
{
  "type": "user_joined",
  "user": { "user_id": "EFGH5678", "name": "Bob", "language": "es", "is_host": false, "mic_on": false }
}
```

**User left:**
```json
{ "type": "user_left", "user_id": "EFGH5678", "name": "Bob" }
```

**Message (translated speech or keyboard):**
```json
{
  "type": "message",
  "from_id": "ABCD1234",
  "from": "Alice",
  "original": "Hello everyone",
  "translation": "Hola a todos",
  "is_self": false
}
```
`is_self: true` when echoed back to the speaker (translation === original).

**Interim:**
```json
{ "type": "interim", "from_id": "ABCD1234", "from": "Alice", "text": "Hello every..." }
```

**Typing:**
```json
{ "type": "typing", "user_id": "ABCD1234", "name": "Alice", "is_typing": true }
```

**Mic / camera state:**
```json
{ "type": "mic_on", "user_id": "ABCD1234" }
{ "type": "mic_off", "user_id": "ABCD1234" }
{ "type": "camera_on", "user_id": "ABCD1234" }
{ "type": "camera_off", "user_id": "ABCD1234" }
```

---

### `WS /ws/deepgram/{room_id}/{user_id}`
Streaming STT proxy. Routes to Deepgram (all languages) or AssemblyAI (Tagalog).

**Query params:**
| Param | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `language` | string | `"en"` | ISO 639-1 code |
| `sample_rate` | int | `16000` | PCM sample rate in Hz |

**Binary frames:** Raw LINEAR16 PCM at `sample_rate` Hz.

**Behavior:** Every `speech_final` event from the STT provider calls `inject_speech()`, which delivers translated messages to all room participants via `/ws/conversation/`.

**Close codes:**
- `1011` — `DEEPGRAM_API_KEY` not set, or `ASSEMBLYAI_API_KEY` not set, or AssemblyAI token fetch failed.

---

### `WS /ws/stt/{room_id}/{user_id}`
Google Cloud Speech streaming STT. Used by iOS clients.

**First message (JSON, required within 5 seconds):**
```json
{ "sample_rate": 44100, "language": "tl" }
```

**Binary frames:** Raw LINEAR16 PCM at the declared `sample_rate`.

**Behavior:** Final transcripts call `inject_speech()`. Sessions restart automatically every 270 seconds (before Google's 5-minute hard limit).

**Close codes:**
- `1011` — `google-cloud-speech` not installed, or credentials not configured.

---

## Environment Variables

| Variable | Required | Used by |
| -------- | -------- | ------- |
| `GROQ_API_KEY` | yes | All agents (LLM + Whisper STT) |
| `DEEPGRAM_API_KEY` | yes | `/ws/deepgram/` — all non-Tagalog STT |
| `ASSEMBLYAI_API_KEY` | yes (for `tl`) | `/ws/deepgram/` — Tagalog STT path |
| `GOOGLE_CREDENTIALS_JSON` | yes (for iOS) | `/ws/stt/` — Google Cloud Speech |
| `GROQ_MODEL` | no | LLM model override (default: `llama-3.3-70b-versatile`) |
