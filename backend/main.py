import os
import json
import asyncio
import queue as _queue
import random
import string
import logging
import threading
import time
from collections import deque
from pathlib import Path
from contextlib import asynccontextmanager
from dotenv import load_dotenv

try:
    from google.cloud import speech as _google_speech
    from google.oauth2 import service_account as _gsa
    _GOOGLE_STT_AVAILABLE = True
except ImportError:
    _google_speech = None
    _gsa = None
    _GOOGLE_STT_AVAILABLE = False


def _make_speech_client():
    """Return a SpeechClient using whichever credentials are available.

    Priority:
      1. GOOGLE_CREDENTIALS_JSON env var — JSON string set in Render (or any
         host without gcloud). Accepts both 'service_account' and
         'authorized_user' types so the ADC file from
         `gcloud auth application-default login` can be pasted directly.
      2. Application Default Credentials — gcloud CLI on local dev machines.
    """
    raw = os.getenv("GOOGLE_CREDENTIALS_JSON", "").strip()
    if raw:
        info = json.loads(raw)
        cred_type = info.get("type", "")
        if cred_type == "service_account":
            creds = _gsa.Credentials.from_service_account_info(
                info,
                scopes=["https://www.googleapis.com/auth/cloud-platform"],
            )
        elif cred_type == "authorized_user":
            from google.oauth2.credentials import Credentials as _UserCreds
            creds = _UserCreds.from_authorized_user_info(info)
        else:
            raise ValueError(f"Unsupported credential type: {cred_type!r}")
        return _google_speech.SpeechClient(credentials=creds)
    # ADC path — local dev with `gcloud auth application-default login`
    return _google_speech.SpeechClient()

# ISO 639-1 → BCP-47 language tags for Google STT
_GOOGLE_LANG = {
    "en": "en-US", "es": "es-ES", "fr": "fr-FR", "de": "de-DE",
    "it": "it-IT", "pt": "pt-BR", "zh": "zh-CN", "ja": "ja-JP",
    "ko": "ko-KR", "ar": "ar-SA", "ru": "ru-RU", "hi": "hi-IN",
    "nl": "nl-NL", "pl": "pl-PL", "tr": "tr-TR", "tl": "fil-PH",
}

# Languages that support the high-accuracy `latest_long` model.
# fil-PH does not — Google rejects it with a 400.
_LATEST_LONG_LANGS = {
    "en-US", "es-ES", "fr-FR", "de-DE", "it-IT", "pt-BR",
    "zh-CN", "ja-JP", "ko-KR", "ar-SA", "ru-RU", "hi-IN",
    "nl-NL", "pl-PL", "tr-TR",
}

# Common Google STT hallucinations that show up when the mic picks up
# background noise.  Lower-cased, stripped, punctuation removed — checked
# in inject path.
_STT_HALLUCINATIONS = {
    "you", "the", "a", "an", "i", "is", "it", "to", "of",
    "mom", "mommy", "mama", "dad", "daddy", "papa",
    "yeah", "yes", "no", "okay", "ok", "uh", "um", "hmm", "huh",
    "thank you", "thanks", "bye", "goodbye", "hello", "hi",
    "are you", "are you mom", "you mom", "mom you",
    "oo", "hindi", "sige",  # very short Tagalog one-word noise hits
}


def _is_likely_hallucination(text: str) -> bool:
    """Cheap check for common Google STT hallucinations from background noise."""
    if not text:
        return True
    norm = text.strip().lower().rstrip(".!?,").strip()
    if len(norm) < 4:
        return True
    return norm in _STT_HALLUCINATIONS


# Per-room ring buffer of recently broadcast originals + translations.
# Used to suppress echo: when the iPhone mic picks up the Mac's TTS playback,
# Google STT will transcribe the translated text — we drop it.
_ECHO_WINDOW_SEC = 10.0
_recent_broadcasts: dict = {}  # room_id → deque[(monotonic_ts, normalized_text)]


def _normalize_for_echo(text: str) -> str:
    return text.strip().lower().rstrip(".!?,").strip()


def _record_broadcast(room_id: str, *texts: str) -> None:
    bucket = _recent_broadcasts.setdefault(room_id, deque(maxlen=40))
    now = time.monotonic()
    for t in texts:
        norm = _normalize_for_echo(t)
        if norm:
            bucket.append((now, norm))


def _is_echo(room_id: str, text: str) -> bool:
    bucket = _recent_broadcasts.get(room_id)
    if not bucket:
        return False
    now = time.monotonic()
    while bucket and now - bucket[0][0] > _ECHO_WINDOW_SEC:
        bucket.popleft()
    norm = _normalize_for_echo(text)
    return any(b == norm for _, b in bucket)

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


_EMPTY_ROOM_TTL_SEC = 300


async def _cleanup_empty_rooms():
    while True:
        try:
            await asyncio.sleep(60)
            now = time.time()
            for rid in list(_rooms.keys()):
                empty_since = _rooms[rid].get("empty_since")
                if empty_since and now - empty_since > _EMPTY_ROOM_TTL_SEC:
                    _rooms.pop(rid, None)
                    _recent_broadcasts.pop(rid, None)
                    logger.info("Cleaned up empty room: %s", rid)
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.warning("_cleanup_empty_rooms iteration failed: %s", e)


@asynccontextmanager
async def lifespan(app):
    cleanup_task = asyncio.create_task(_cleanup_empty_rooms())
    try:
        yield
    finally:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except (asyncio.CancelledError, Exception):
            pass

app = FastAPI(title="AI Translate", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _no_cache_static(request, call_next):
    """Force fresh fetches of frontend assets so iPhone Safari can't pin
    a stale app.js / styles.css / index.html across deploys.
    """
    response = await call_next(request)
    p = request.url.path
    if p == "/" or p.endswith((".js", ".css", ".html")):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# Conversation rooms: room_id → {
#   "conns":   {user_id: WebSocket},
#   "info":    {user_id: {name, language, is_host, mic_on}},
#   "host_id": str | None
# }
_rooms: dict = {}


_ROOM_ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # excludes I, L, O, 0, 1


def _gen_room_id() -> str:
    return "".join(random.choices(_ROOM_ID_ALPHABET, k=6))


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
    # Allocate the room immediately so that subsequent /ws/conversation/{id}
    # joins can validate the ID exists. Without this, a participant typing
    # a wrong (or stale) room ID would silently create a brand-new room
    # and become its host.
    _rooms[room_id] = {"conns": {}, "info": {}, "host_id": None, "empty_since": time.time()}
    return {"room_id": room_id}


@app.websocket("/ws/conversation/{room_id}")
async def conversation_ws(websocket: WebSocket, room_id: str):
    """WebSocket endpoint for live multi-user conversation."""
    await websocket.accept()

    # Read the join message FIRST so we can honour `is_creator` before deciding
    # whether to allocate / reject for an unknown room.
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=15)
        data = json.loads(raw)
        if data.get("type") != "join":
            try:
                await websocket.close()
            except Exception:
                pass
            return
    except WebSocketDisconnect:
        return  # client already gone — nothing to close
    except (asyncio.TimeoutError, Exception):
        try:
            await websocket.close()
        except Exception:
            pass
        return

    is_creator = bool(data.get("is_creator", False))

    if room_id not in _rooms:
        if is_creator:
            # Host's frontend remembers it created this room (e.g. the server
            # restarted on a deploy). Recreate the room so they can keep going.
            _rooms[room_id] = {"conns": {}, "info": {}, "host_id": None, "empty_since": time.time()}
            logger.info("Re-created room on host reconnect: %s", room_id)
        else:
            try:
                await websocket.send_json({"type": "error", "code": "room_not_found",
                                           "message": f"Room {room_id} does not exist."})
                await websocket.close()
            except Exception:
                pass
            return

    room = _rooms[room_id]
    room["empty_since"] = None

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

    explicit_leave = False
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

            elif msg_type == "leave":
                explicit_leave = True
                break

    except WebSocketDisconnect:
        pass
    finally:
        user_name = (room["info"].get(user_id) or {}).get("name", "Someone")
        user_was_host = room.get("host_id") == user_id

        room["conns"].pop(user_id, None)
        room["info"].pop(user_id, None)

        if user_was_host and explicit_leave:
            # Host clicked Leave: hand off to the next user or tear down.
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
                room["host_left"] = True
        # On incidental host disconnect, keep host_id reserved so the host
        # can reclaim it on reconnect (their frontend sends is_creator=true).

        # Notify remaining participants
        for uid, ws in list(room["conns"].items()):
            if ws:
                try:
                    await ws.send_json({"type": "user_left", "user_id": user_id, "name": user_name})
                except Exception:
                    pass

        if not room["conns"]:
            # Keep the room alive unless the host has explicitly ended it.
            # Brief WS drops (iOS Safari background, network blip) leave
            # empty_since unset so reconnects always succeed.
            if room.get("host_left", False):
                room["empty_since"] = time.time()


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
    if _is_echo(room_id, text):
        logger.info("inject_speech: echo dropped room=%s user=%s text=%r",
                    room_id, user_id, text[:60])
        return
    logger.info("inject_speech: room=%s user=%s text=%r", room_id, user_id, text[:60])
    room = _rooms.get(room_id)
    if not room:
        logger.warning("inject_speech: room %s not found", room_id)
        return
    my_info = room["info"].get(user_id)
    if not my_info:
        logger.warning("inject_speech: user %s not in room %s. known=%s",
                       user_id, room_id, list(room["info"].keys()))
        return

    # Record the original now so any STT pickup of our own speech is detected.
    _record_broadcast(room_id, text)

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

    # Translate to every other participant's language in parallel — sequential
    # awaits on Groq calls add up fast (each ~200-400 ms).
    async def _translate_and_send(other_id: str, other_ws, other_info):
        try:
            if other_info["language"] == my_info["language"]:
                translated = text
            else:
                result = await asyncio.to_thread(
                    run_conversation_pipeline,
                    text, my_info["language"], other_info["language"],
                )
                translated = result.get("translation", text)
            _record_broadcast(room_id, translated)
            await other_ws.send_json({
                "type": "message", "from_id": user_id,
                "from": my_info["name"], "original": text,
                "translation": translated, "is_self": False,
            })
        except Exception as e:
            logger.error("Translation error for %s: %s", other_id, e)

    tasks = []
    for other_id, other_ws in list(room["conns"].items()):
        if other_id == user_id or not other_ws:
            continue
        other_info = room["info"].get(other_id)
        if not other_info:
            continue
        tasks.append(_translate_and_send(other_id, other_ws, other_info))
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


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
        _make_speech_client()
    except Exception as e:
        logger.error("Google STT credentials error: %s", e)
        await websocket.close(code=1011, reason="Google STT credentials not configured")
        return

    lang_code = _GOOGLE_LANG.get(language, "en-US")

    logger.info("STT session opening: room=%s user=%s lang=%s rate=%d",
                room_id, user_id, lang_code, sample_rate)

    def run_stt():
        client = _make_speech_client()
        cfg_kwargs = dict(
            encoding=_google_speech.RecognitionConfig.AudioEncoding.LINEAR16,
            sample_rate_hertz=sample_rate,
            language_code=lang_code,
            enable_automatic_punctuation=True,
        )
        if lang_code in _LATEST_LONG_LANGS:
            cfg_kwargs["model"] = "latest_long"
            cfg_kwargs["use_enhanced"] = True
        stt_cfg = _google_speech.RecognitionConfig(**cfg_kwargs)
        # single_utterance=True is required for fast per-pause finalization.
        # Without it, Google holds all speech in one giant transcript until a
        # very long silence — making subsequent utterances appear "not picked
        # up" until the speaker mutes. With single_utterance=True the inner
        # for-loop ends on each natural pause; the outer while-loop spins up
        # a fresh session so streaming continues through the whole mic-on
        # period. The 270 s deadline below caps a single session length to
        # stay under Google's 5-min hard limit.
        streaming_cfg = _google_speech.StreamingRecognitionConfig(
            config=stt_cfg, interim_results=False, single_utterance=True,
        )
        SESSION_SECS = 270  # restart before Google's 5-min hard limit
        consecutive_errors = 0
        last_emit = {"text": "", "ts": 0.0}
        session_idx = [0]

        while not stop_evt.is_set():
            first_chunk_logged = False
            speech_event_ts = [0.0]  # set when END_OF_SINGLE_UTTERANCE fires

            def _gen():
                nonlocal first_chunk_logged
                deadline = time.monotonic() + SESSION_SECS
                while not stop_evt.is_set():
                    # Safety: if Google sent END_OF_SINGLE_UTTERANCE but never
                    # followed it with a final transcript, end the session so
                    # the outer loop spins up a fresh recognizer instead of
                    # hanging on stale audio.
                    if speech_event_ts[0] and time.monotonic() - speech_event_ts[0] > 1.5:
                        return
                    left = deadline - time.monotonic()
                    if left <= 0:
                        return
                    try:
                        chunk = audio_q.get(timeout=min(0.1, left))
                        if chunk is None:
                            return
                        if not first_chunk_logged:
                            logger.info("STT first audio chunk (room=%s user=%s, %d bytes)",
                                        room_id, user_id, len(chunk))
                            first_chunk_logged = True
                        yield _google_speech.StreamingRecognizeRequest(audio_content=chunk)
                    except _queue.Empty:
                        continue

            session_idx_local = session_idx[0] = session_idx[0] + 1
            logger.info("STT session %d starting (room=%s user=%s)",
                        session_idx_local, room_id, user_id)
            try:
                first_resp_logged = False
                for resp in client.streaming_recognize(config=streaming_cfg, requests=_gen()):
                    if not first_resp_logged:
                        logger.info("STT session %d first Google response", session_idx_local)
                        first_resp_logged = True
                    sev = getattr(resp, "speech_event_type", None)
                    if sev:
                        logger.info("STT session %d speech_event=%s", session_idx_local, sev)
                        if not speech_event_ts[0]:
                            speech_event_ts[0] = time.monotonic()
                    for result in resp.results:
                        if not result.is_final:
                            continue
                        if not result.alternatives:
                            continue
                        alt = result.alternatives[0]
                        transcript = (alt.transcript or "").strip()
                        confidence = float(getattr(alt, "confidence", 0.0) or 0.0)
                        if _is_likely_hallucination(transcript):
                            logger.info("STT dropped hallucination (sess=%d): %r",
                                        session_idx_local, transcript[:80])
                            continue
                        if confidence and confidence < 0.6:
                            logger.info("STT dropped low-confidence (sess=%d) %.2f: %r",
                                        session_idx_local, confidence, transcript[:80])
                            continue
                        norm = transcript.strip().lower()
                        now_ts = time.monotonic()
                        if norm == last_emit["text"] and now_ts - last_emit["ts"] < 5.0:
                            logger.info("STT dedup duplicate within 5s: %r", transcript[:60])
                            continue
                        last_emit["text"] = norm
                        last_emit["ts"] = now_ts
                        logger.info("STT final (sess=%d): room=%s user=%s conf=%.2f text=%r",
                                    session_idx_local, room_id, user_id, confidence, transcript[:100])
                        asyncio.run_coroutine_threadsafe(
                            inject_speech(room_id, user_id, transcript), loop
                        )
                logger.info("STT session %d ended cleanly", session_idx_local)
                consecutive_errors = 0
            except Exception as e:
                if stop_evt.is_set():
                    return
                consecutive_errors += 1
                logger.warning(
                    "STT session reset (%s: %s) [%d], restarting",
                    type(e).__name__, str(e)[:200], consecutive_errors,
                )
                if consecutive_errors >= 5:
                    logger.error("STT giving up after %d consecutive errors", consecutive_errors)
                    return
                time.sleep(min(2.0, 0.2 * consecutive_errors))

    threading.Thread(target=run_stt, daemon=True).start()

    rx_frames = 0
    rx_bytes = 0
    try:
        while True:
            data = await websocket.receive_bytes()
            rx_frames += 1
            rx_bytes += len(data)
            if rx_frames in (1, 25, 250):
                logger.info("STT WS rx: room=%s user=%s frames=%d bytes=%d",
                            room_id, user_id, rx_frames, rx_bytes)
            try:
                audio_q.put_nowait(data)
            except _queue.Full:
                pass  # drop frame — client sent faster than STT can consume
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("STT WS error: %s", e)
    finally:
        logger.info("STT WS closed: room=%s user=%s rx_frames=%d rx_bytes=%d",
                    room_id, user_id, rx_frames, rx_bytes)
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
