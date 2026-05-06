import os
import json
import asyncio
import queue as _queue
import random
import string
import logging
import threading
import time
from pathlib import Path
from contextlib import asynccontextmanager
from dotenv import load_dotenv

try:
    from google.cloud import speech as _google_speech
    _GOOGLE_STT_AVAILABLE = True
except ImportError:
    _google_speech = None
    _GOOGLE_STT_AVAILABLE = False

# ISO 639-1 → BCP-47 language tags for Google STT
_GOOGLE_LANG = {
    "en": "en-US", "es": "es-ES", "fr": "fr-FR", "de": "de-DE",
    "it": "it-IT", "pt": "pt-BR", "zh": "zh-CN", "ja": "ja-JP",
    "ko": "ko-KR", "ar": "ar-SA", "ru": "ru-RU", "hi": "hi-IN",
    "nl": "nl-NL", "pl": "pl-PL", "tr": "tr-TR", "tl": "fil-PH",
}

# Load environment variables BEFORE importing agents (they need GROQ_API_KEY)
load_dotenv(override=False)

from fastapi import FastAPI, UploadFile, WebSocket, WebSocketDisconnect  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from agents.orchestrator import run_text_pipeline, run_audio_pipeline, run_conversation_pipeline  # noqa: E402
from agents import language_detection_agent, transcription_agent  # noqa: E402

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Frontend directory - works whether run from project root or from backend directory
_current_file = Path(__file__).resolve()
if _current_file.parent.name == "backend":
    FRONTEND_DIR = _current_file.parent.parent / "frontend"
else:
    FRONTEND_DIR = _current_file.parent / "frontend"


@asynccontextmanager
async def lifespan(app):
    yield

app = FastAPI(title="AI Translate", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Conversation rooms: room_id → {
#   "conns":   {user_id: WebSocket},
#   "info":    {user_id: {name, language, is_host, mic_on}},
#   "host_id": str | None
# }
_rooms: dict = {}


def _gen_room_id() -> str:
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=6))


def _gen_user_id() -> str:
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=8))


@app.get("/")
async def root():
    """Serve index.html for the SPA."""
    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"message": "AI Translate API"}


@app.get("/api/health")
async def health_check():
    """API health check endpoint."""
    return {"status": "ok"}


@app.get("/create_room")
async def create_room():
    """Generate a new room ID for live conversation."""
    room_id = _gen_room_id()
    while room_id in _rooms:
        room_id = _gen_room_id()
    return {"room_id": room_id}


@app.websocket("/ws/conversation/{room_id}")
async def conversation_ws(websocket: WebSocket, room_id: str):
    """WebSocket endpoint for live multi-user conversation."""
    await websocket.accept()

    if room_id not in _rooms:
        _rooms[room_id] = {"conns": {}, "info": {}, "host_id": None}

    room = _rooms[room_id]

    # Wait for join message
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=15)
        data = json.loads(raw)
        if data.get("type") != "join":
            await websocket.close()
            return
    except (asyncio.TimeoutError, Exception):
        await websocket.close()
        return

    user_id = _gen_user_id()
    is_host = room["host_id"] is None
    if is_host:
        room["host_id"] = user_id

    room["conns"][user_id] = websocket
    room["info"][user_id] = {
        "name": data["name"],
        "language": data["language"],
        "is_host": is_host,
        "mic_on": False,
        "camera_on": False,
    }

    # Confirm join with full room snapshot
    await websocket.send_json({
        "type": "joined",
        "user_id": user_id,
        "room": room_id,
        "is_host": is_host,
        "users": [{"user_id": uid, **info} for uid, info in room["info"].items()],
    })

    # Announce arrival to everyone already in the room
    new_user = {"user_id": user_id, **room["info"][user_id]}
    for uid, ws in list(room["conns"].items()):
        if uid != user_id:
            try:
                await ws.send_json({"type": "user_joined", "user": new_user})
            except Exception:
                pass

    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            msg_type = data.get("type")

            if msg_type == "speech":
                text = data.get("text", "").strip()
                if not text:
                    continue

                my_info = room["info"].get(user_id)
                if not my_info:
                    continue

                # Echo original back to speaker
                await websocket.send_json({
                    "type": "message",
                    "from_id": user_id,
                    "from": my_info["name"],
                    "original": text,
                    "translation": text,
                    "is_self": True,
                })

                # Translate and deliver to every other participant
                for other_id, other_ws in list(room["conns"].items()):
                    if other_id == user_id or not other_ws:
                        continue
                    other_info = room["info"].get(other_id)
                    if not other_info:
                        continue
                    try:
                        if other_info["language"] == my_info["language"]:
                            translated = text
                        else:
                            result = await asyncio.to_thread(
                                run_conversation_pipeline,
                                text,
                                my_info["language"],
                                other_info["language"],
                            )
                            translated = result.get("translation", text)

                        await other_ws.send_json({
                            "type": "message",
                            "from_id": user_id,
                            "from": my_info["name"],
                            "original": text,
                            "translation": translated,
                            "is_self": False,
                        })
                    except Exception as e:
                        logger.error(f"Translation error for {other_id}: {e}")

            elif msg_type == "interim":
                my_info = room["info"].get(user_id)
                if not my_info:
                    continue
                for other_id, other_ws in list(room["conns"].items()):
                    if other_id == user_id or not other_ws:
                        continue
                    try:
                        await other_ws.send_json({
                            "type": "interim",
                            "from_id": user_id,
                            "from": my_info["name"],
                            "text": data.get("text", ""),
                        })
                    except Exception:
                        pass

            elif msg_type == "typing":
                my_info = room["info"].get(user_id)
                if not my_info:
                    continue
                for other_id, other_ws in list(room["conns"].items()):
                    if other_id == user_id or not other_ws:
                        continue
                    try:
                        await other_ws.send_json({
                            "type": "typing",
                            "user_id": user_id,
                            "name": my_info["name"],
                            "is_typing": bool(data.get("is_typing", False)),
                        })
                    except Exception:
                        pass

            elif msg_type == "keyboard":
                text = data.get("text", "").strip()
                if not text:
                    continue

                my_info = room["info"].get(user_id)
                if not my_info:
                    continue

                # Echo original back to sender
                await websocket.send_json({
                    "type": "message",
                    "from_id": user_id,
                    "from": my_info["name"],
                    "original": text,
                    "translation": text,
                    "is_self": True,
                })

                # Translate via conversation pipeline and deliver to every other participant
                for other_id, other_ws in list(room["conns"].items()):
                    if other_id == user_id or not other_ws:
                        continue
                    other_info = room["info"].get(other_id)
                    if not other_info:
                        continue
                    try:
                        if other_info["language"] == my_info["language"]:
                            translated = text
                        else:
                            result = await asyncio.to_thread(
                                run_conversation_pipeline,
                                text,
                                my_info["language"],
                                other_info["language"],
                            )
                            translated = result.get("translation", text)

                        await other_ws.send_json({
                            "type": "message",
                            "from_id": user_id,
                            "from": my_info["name"],
                            "original": text,
                            "translation": translated,
                            "is_self": False,
                        })
                    except Exception as e:
                        logger.error(f"Keyboard translation error for {other_id}: {e}")

            elif msg_type == "mic_status":
                is_on = bool(data.get("is_on", False))
                if user_id in room["info"]:
                    room["info"][user_id]["mic_on"] = is_on
                for other_id, other_ws in list(room["conns"].items()):
                    if other_id == user_id or not other_ws:
                        continue
                    try:
                        await other_ws.send_json({
                            "type": "user_mic_status",
                            "user_id": user_id,
                            "is_on": is_on,
                        })
                    except Exception:
                        pass

            elif msg_type == "camera_status":
                is_on = bool(data.get("is_on", False))
                if user_id in room["info"]:
                    room["info"][user_id]["camera_on"] = is_on
                for other_id, other_ws in list(room["conns"].items()):
                    if other_id == user_id or not other_ws:
                        continue
                    try:
                        await other_ws.send_json({
                            "type": "user_camera_status",
                            "user_id": user_id,
                            "is_on": is_on,
                        })
                    except Exception:
                        pass

            elif msg_type in ("webrtc_offer", "webrtc_answer", "webrtc_ice"):
                target_id = data.get("target_id")
                if target_id and target_id in room["conns"]:
                    payload = {"type": msg_type, "from_id": user_id}
                    if msg_type in ("webrtc_offer", "webrtc_answer"):
                        payload["sdp"] = data.get("sdp")
                    else:
                        payload["candidate"] = data.get("candidate")
                    try:
                        await room["conns"][target_id].send_json(payload)
                    except Exception:
                        pass

    except WebSocketDisconnect:
        pass
    finally:
        user_name = (room["info"].get(user_id) or {}).get("name", "Someone")
        room["conns"].pop(user_id, None)
        room["info"].pop(user_id, None)

        # Pass host role to next participant if host left
        if room.get("host_id") == user_id:
            remaining = list(room["conns"].keys())
            if remaining:
                new_host_id = remaining[0]
                room["host_id"] = new_host_id
                if new_host_id in room["info"]:
                    room["info"][new_host_id]["is_host"] = True
                try:
                    await room["conns"][new_host_id].send_json({
                        "type": "host_changed",
                        "new_host_id": new_host_id,
                    })
                except Exception:
                    pass
            else:
                room["host_id"] = None

        # Notify remaining participants
        for uid, ws in list(room["conns"].items()):
            if ws:
                try:
                    await ws.send_json({"type": "user_left", "user_id": user_id, "name": user_name})
                except Exception:
                    pass

        if not room["conns"]:
            _rooms.pop(room_id, None)


@app.post("/detect_language")
async def detect_language_endpoint(text: str):
    """Routes every keystroke through the Language Detection Agent."""
    detected = language_detection_agent.run(text)
    return {"detected_language": detected}


@app.post("/translate_text")
async def translate_text(source: str, target: str, text: str):
    result = run_text_pipeline(text, source, target)
    return result


@app.post("/translate_audio")
async def translate_audio(source: str, target: str, file: UploadFile):
    filepath = f"temp_{file.filename}"
    with open(filepath, "wb") as f:
        f.write(await file.read())

    result = run_audio_pipeline(filepath, source, target)

    if os.path.exists(filepath):
        os.remove(filepath)

    return result


async def inject_speech(room_id: str, user_id: str, text: str):
    """Inject a Google-STT transcript into a conversation room.
    Echoes the original to the speaker and runs the per-participant
    translation pipeline for every other participant."""
    room = _rooms.get(room_id)
    if not room:
        return
    my_info = room["info"].get(user_id)
    if not my_info:
        return

    speaker_ws = room["conns"].get(user_id)
    if speaker_ws:
        try:
            await speaker_ws.send_json({
                "type": "message", "from_id": user_id,
                "from": my_info["name"], "original": text,
                "translation": text, "is_self": True,
            })
        except Exception:
            pass

    for other_id, other_ws in list(room["conns"].items()):
        if other_id == user_id or not other_ws:
            continue
        other_info = room["info"].get(other_id)
        if not other_info:
            continue
        try:
            if other_info["language"] == my_info["language"]:
                translated = text
            else:
                result = await asyncio.to_thread(
                    run_conversation_pipeline,
                    text, my_info["language"], other_info["language"],
                )
                translated = result.get("translation", text)
            await other_ws.send_json({
                "type": "message", "from_id": user_id,
                "from": my_info["name"], "original": text,
                "translation": translated, "is_self": False,
            })
        except Exception as e:
            logger.error("Translation error for %s: %s", other_id, e)


@app.websocket("/ws/stt/{room_id}/{user_id}")
async def stt_stream_endpoint(websocket: WebSocket, room_id: str, user_id: str):
    """Google Cloud STT streaming endpoint used by iOS clients.

    Binary frames arriving from the browser contain raw LINEAR16 PCM audio
    at the device's native sample rate.  A daemon thread feeds those frames
    into a Google Cloud streaming_recognize session and calls inject_speech()
    for every final transcript.  Sessions restart automatically every 4.5 min
    (before Google's hard 5-min limit).
    """
    if not _GOOGLE_STT_AVAILABLE:
        await websocket.close(code=1011, reason="google-cloud-speech not installed")
        return

    await websocket.accept()
    loop = asyncio.get_running_loop()
    audio_q: _queue.Queue = _queue.Queue(maxsize=200)
    stop_evt = threading.Event()

    # First message must be JSON: { "sample_rate": 44100, "language": "tl" }
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)
        cfg = json.loads(raw)
        sample_rate = int(cfg.get("sample_rate", 16000))
        language = cfg.get("language", "en")
    except Exception as e:
        logger.error("STT config error: %s", e)
        await websocket.close()
        return

    # Validate Google credentials early — fail fast with a clear close reason.
    try:
        _google_speech.SpeechClient()
    except Exception as e:
        logger.error("Google STT credentials error: %s", e)
        await websocket.close(code=1011, reason="Google STT credentials not configured")
        return

    lang_code = _GOOGLE_LANG.get(language, "en-US")

    def run_stt():
        client = _google_speech.SpeechClient()
        stt_cfg = _google_speech.RecognitionConfig(
            encoding=_google_speech.RecognitionConfig.AudioEncoding.LINEAR16,
            sample_rate_hertz=sample_rate,
            language_code=lang_code,
            enable_automatic_punctuation=True,
            model="latest_long",
        )
        streaming_cfg = _google_speech.StreamingRecognitionConfig(
            config=stt_cfg, interim_results=False,
        )
        SESSION_SECS = 270  # restart before Google's 5-min hard limit

        while not stop_evt.is_set():
            def _gen():
                yield _google_speech.StreamingRecognizeRequest(streaming_config=streaming_cfg)
                deadline = time.monotonic() + SESSION_SECS
                while not stop_evt.is_set():
                    left = deadline - time.monotonic()
                    if left <= 0:
                        return
                    try:
                        chunk = audio_q.get(timeout=min(0.1, left))
                        if chunk is None:
                            return
                        yield _google_speech.StreamingRecognizeRequest(audio_content=chunk)
                    except _queue.Empty:
                        continue

            try:
                for resp in client.streaming_recognize(_gen()):
                    for result in resp.results:
                        if not result.is_final:
                            continue
                        transcript = result.alternatives[0].transcript.strip()
                        if len(transcript) < 2:
                            continue
                        asyncio.run_coroutine_threadsafe(
                            inject_speech(room_id, user_id, transcript), loop
                        )
            except Exception as e:
                if stop_evt.is_set():
                    return
                logger.warning("STT session reset (%s), restarting", type(e).__name__)

    threading.Thread(target=run_stt, daemon=True).start()

    try:
        while True:
            data = await websocket.receive_bytes()
            try:
                audio_q.put_nowait(data)
            except _queue.Full:
                pass  # drop frame — client sent faster than STT can consume
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("STT WS error: %s", e)
    finally:
        stop_evt.set()
        audio_q.put(None)


@app.post("/transcribe_audio")
async def transcribe_audio_only(source: str, file: UploadFile):
    """Transcribe-only endpoint for the iOS hot-mic pipeline.
    Returns {"text": "..."} — no translation. The caller sends the text
    to the conversation WebSocket as a speech message so the per-participant
    translation pipeline runs normally."""
    filepath = f"temp_conv_{file.filename}"
    with open(filepath, "wb") as f:
        f.write(await file.read())
    try:
        lang = None if source in ("auto", "") else source
        result = await asyncio.to_thread(transcription_agent.run, filepath, lang)
    finally:
        if os.path.exists(filepath):
            os.remove(filepath)
    return {"text": result["text"]}


# Serve the frontend as static files
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=False), name="frontend")
