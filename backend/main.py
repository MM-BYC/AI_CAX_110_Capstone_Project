import os
import json
import asyncio
import random
import string
import logging
from pathlib import Path
from contextlib import asynccontextmanager
from dotenv import load_dotenv

# Load environment variables BEFORE importing agents (they need GROQ_API_KEY)
load_dotenv(override=False)

from fastapi import FastAPI, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from agents.orchestrator import run_text_pipeline, run_audio_pipeline, run_keyboard_pipeline
from agents import language_detection_agent

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
                                run_text_pipeline,
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

                # Translate via Keyboard pipeline and deliver to every other participant
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
                                run_keyboard_pipeline,
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


# Serve the frontend as static files
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=False), name="frontend")
