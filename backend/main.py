import os
import json
import asyncio
import random
import string
import logging
from pathlib import Path
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load environment variables before importing agents
load_dotenv(override=False)

from fastapi import FastAPI, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from agents.orchestrator import run_text_pipeline, run_audio_pipeline
from agents import language_detection_agent

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

from contextlib import asynccontextmanager

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

# Conversation rooms: room_id → {"conns": {pos: WebSocket|None}, "info": {pos: {name, language}|None}}
_rooms: dict = {}


def _gen_room_id() -> str:
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=6))


@app.get("/api/health")
async def health_check():
    """API health check endpoint."""
    logger.info("Health check called")
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
    """WebSocket endpoint for live conversation between two users."""
    await websocket.accept()

    room = _rooms.get(room_id)
    if room and len([v for v in room["conns"].values() if v is not None]) >= 2:
        await websocket.send_json({"type": "error", "message": "Room is full"})
        await websocket.close()
        return

    if room_id not in _rooms:
        _rooms[room_id] = {"conns": {}, "info": {}}

    room = _rooms[room_id]
    occupied = set(k for k, v in room["conns"].items() if v is not None)
    position = 0 if 0 not in occupied else 1
    room["conns"][position] = websocket
    room["info"][position] = None

    try:
        raw = await websocket.receive_text()
        data = json.loads(raw)
        if data.get("type") != "join":
            return

        room["info"][position] = {"name": data["name"], "language": data["language"]}

        await websocket.send_json({"type": "joined", "position": position, "room": room_id})

        # Notify both if paired
        if (
            room["conns"].get(0) and room["conns"].get(1)
            and room["info"].get(0) and room["info"].get(1)
        ):
            for ws in room["conns"].values():
                if ws:
                    await ws.send_json({
                        "type": "paired",
                        "users": [room["info"][0], room["info"][1]]
                    })

        # Message loop
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            msg_type = data.get("type")

            if msg_type == "speech":
                text = data.get("text", "").strip()
                if not text:
                    continue

                my_info = room["info"][position]
                partner_pos = 1 - position
                partner_ws = room["conns"].get(partner_pos)
                partner_info = room["info"].get(partner_pos)

                if not partner_ws or not partner_info:
                    continue

                try:
                    translation = await asyncio.to_thread(
                        run_text_pipeline,
                        text,
                        my_info["language"],
                        partner_info["language"]
                    )
                    translated_text = translation.get("translation", "")

                    await partner_ws.send_json({
                        "type": "message",
                        "from": my_info["name"],
                        "original": text,
                        "translation": translated_text,
                        "is_self": False
                    })
                except Exception as e:
                    logger.error(f"Translation error: {e}")

            elif msg_type == "interim":
                my_info = room["info"][position]
                partner_pos = 1 - position
                partner_ws = room["conns"].get(partner_pos)

                if partner_ws and my_info:
                    try:
                        await partner_ws.send_json({
                            "type": "interim",
                            "from": my_info["name"],
                            "text": data.get("text", ""),
                        })
                    except Exception:
                        pass

    except WebSocketDisconnect:
        pass
    finally:
        room["conns"][position] = None
        partner_pos = 1 - position
        partner_ws = room["conns"].get(partner_pos)
        if partner_ws:
            try:
                await partner_ws.send_json({"type": "partner_left"})
            except Exception:
                pass
        if all(v is None for v in room["conns"].values()):
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
logger = logging.getLogger(__name__)
logger.info(f"Frontend directory: {FRONTEND_DIR}")
logger.info(f"Frontend exists: {FRONTEND_DIR.exists()}")

if FRONTEND_DIR.exists():
    logger.info(f"Frontend files: {list(FRONTEND_DIR.glob('*'))}")
    try:
        logger.info("Mounting frontend StaticFiles at /...")
        app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
        logger.info("✓ Frontend mounted successfully")
    except Exception as e:
        logger.error(f"✗ Failed to mount frontend: {e}", exc_info=True)
else:
    logger.error(f"Frontend directory not found: {FRONTEND_DIR}")
