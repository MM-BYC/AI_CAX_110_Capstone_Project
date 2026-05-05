import os
import json
import base64
import asyncio
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from lingua import Language, LanguageDetectorBuilder

from agent import translation_agent
from room_manager import room_manager, Participant
from speaker_orchestrator import SpeakerOrchestrator

load_dotenv(Path(__file__).parent / ".env")

_SUPPORTED = [
    Language.ENGLISH, Language.SPANISH, Language.FRENCH, Language.GERMAN,
    Language.ITALIAN, Language.PORTUGUESE, Language.CHINESE, Language.JAPANESE,
    Language.KOREAN, Language.ARABIC, Language.RUSSIAN, Language.HINDI,
    Language.DUTCH, Language.POLISH, Language.TURKISH, Language.TAGALOG,
]
_detector = LanguageDetectorBuilder.from_languages(*_SUPPORTED).build()
_executor = ThreadPoolExecutor(max_workers=4)


@asynccontextmanager
async def lifespan(app):
    yield  # detector already loaded above
    _executor.shutdown(wait=False)


app = FastAPI(title="Language Translation Agent", version="1.0.0", lifespan=lifespan)

# Allow requests from the frontend (served on any local origin during dev)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/detect_language")
async def detect_language_endpoint(text: str):
    """Detect the language of the given text using lingua (high accuracy, pre-loaded)."""
    loop = asyncio.get_event_loop()
    lang = await loop.run_in_executor(_executor, _detector.detect_language_of, text)
    if lang is None:
        return {"detected_language": "unknown"}
    code = lang.iso_code_639_1.name.lower()
    return {"detected_language": code}


@app.post("/translate_text")
async def translate_text(source: str, target: str, text: str):
    """You are a multi lingual expert.
    Translate plain text from source language to target language."""
    result = translation_agent(text, source, target, is_audio=False)
    return result


@app.post("/translate_audio")
async def translate_audio(source: str, target: str, file: UploadFile):
    """Translate spoken audio from source language to target language."""
    filepath = f"temp_{file.filename}"
    with open(filepath, "wb") as f:
        f.write(await file.read())

    result = translation_agent(filepath, source, target, is_audio=True)

    # Clean up temp file
    if os.path.exists(filepath):
        os.remove(filepath)

    return result


@app.websocket("/ws/room")
async def room_websocket(ws: WebSocket):
    """
    Real-time conversation room over WebSocket.

    Message types (client → server, JSON):
      create_room  {participant_id, name, lang}
      join_room    {code, participant_id, name, lang}
      audio_chunk  {data: base64}   ← full recording sent when mic is muted
      leave_room   {}

    Message types (server → client, JSON):
      room_created       {code, participants}
      joined             {code, participants, is_reconnect}
      join_error         {message}
      participant_joined {id, name, lang, is_host}
      participant_left   {id, name}
      speaker_translation {speaker_id, speaker_name, original, translation, target_lang}
      error              {message}
    """
    await ws.accept()

    current_room_code: str | None = None
    current_participant_id: str | None = None

    try:
        while True:
            data = await ws.receive_text()
            msg = json.loads(data)
            msg_type = msg.get("type")

            # ── Create room ──────────────────────────────────────────────────
            if msg_type == "create_room":
                participant_id = msg["participant_id"]
                name = msg["name"]
                lang = msg["lang"]

                code = room_manager.create_room()
                participant = Participant(
                    participant_id=participant_id,
                    name=name,
                    lang=lang,
                    ws=ws,
                    is_host=True,
                )
                room_manager.join_room(code, participant)
                current_room_code = code
                current_participant_id = participant_id

                await ws.send_text(json.dumps({
                    "type": "room_created",
                    "code": code,
                    "participants": room_manager.get_room(code).to_participant_list(),
                }))

            # ── Join room ────────────────────────────────────────────────────
            elif msg_type == "join_room":
                code = msg["code"]
                participant_id = msg["participant_id"]
                name = msg["name"]
                lang = msg["lang"]

                participant = Participant(
                    participant_id=participant_id,
                    name=name,
                    lang=lang,
                    ws=ws,
                    is_host=False,
                )
                success, error, is_reconnect = room_manager.join_room(code, participant)

                if not success:
                    await ws.send_text(json.dumps({
                        "type": "join_error",
                        "message": error,
                    }))
                    continue

                current_room_code = code
                current_participant_id = participant_id
                room = room_manager.get_room(code)

                await ws.send_text(json.dumps({
                    "type": "joined",
                    "code": code,
                    "participants": room.to_participant_list(),
                    "is_reconnect": is_reconnect,
                }))

                if not is_reconnect:
                    await room_manager.broadcast(code, {
                        "type": "participant_joined",
                        "id": participant_id,
                        "name": name,
                        "lang": lang,
                        "is_host": False,
                    }, exclude_id=participant_id)

            # ── Audio chunk ──────────────────────────────────────────────────
            elif msg_type == "audio_chunk":
                if current_room_code and current_participant_id:
                    room = room_manager.get_room(current_room_code)
                    if room and current_participant_id in room.participants:
                        p = room.participants[current_participant_id]
                        audio_bytes = base64.b64decode(msg["data"])
                        orchestrator = SpeakerOrchestrator(
                            speaker_id=current_participant_id,
                            speaker_name=p.name,
                            speaker_lang=p.lang,
                            room_code=current_room_code,
                            room_manager=room_manager,
                        )
                        await orchestrator.process(audio_bytes)

            # ── WebRTC signaling relay ───────────────────────────────────────
            # Server is a pure relay: it stamps from_id and forwards to target.
            elif msg_type in ("webrtc_offer", "webrtc_answer", "webrtc_ice"):
                to_id = msg.get("to_id")
                if current_room_code and current_participant_id and to_id:
                    await room_manager.send_to(current_room_code, to_id, {
                        **msg,
                        "from_id": current_participant_id,
                    })

            # ── Leave room ───────────────────────────────────────────────────
            elif msg_type == "leave_room":
                if current_room_code and current_participant_id:
                    p_name = room_manager.leave_room(
                        current_room_code, current_participant_id
                    )
                    await room_manager.broadcast(current_room_code, {
                        "type": "participant_left",
                        "id": current_participant_id,
                        "name": p_name,
                    })
                    current_room_code = None
                    current_participant_id = None

    except WebSocketDisconnect:
        if current_room_code and current_participant_id:
            p_name = room_manager.leave_room(current_room_code, current_participant_id)
            await room_manager.broadcast(current_room_code, {
                "type": "participant_left",
                "id": current_participant_id,
                "name": p_name,
            })
    except Exception as e:
        try:
            await ws.send_text(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass
