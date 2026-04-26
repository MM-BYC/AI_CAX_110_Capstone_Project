import os
import asyncio
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from dotenv import load_dotenv

# Load env before agent modules so GROQ_API_KEY is available at import time
load_dotenv(Path(__file__).parent / ".env")

from fastapi import FastAPI, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from lingua import Language, LanguageDetectorBuilder
from agents.orchestrator import run_text_pipeline, run_audio_pipeline

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

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
    result = run_text_pipeline(text, source, target)
    return result


@app.post("/translate_audio")
async def translate_audio(source: str, target: str, file: UploadFile):
    """Translate spoken audio from source language to target language."""
    filepath = f"temp_{file.filename}"
    with open(filepath, "wb") as f:
        f.write(await file.read())

    result = run_audio_pipeline(filepath, source, target)

    # Clean up temp file
    if os.path.exists(filepath):
        os.remove(filepath)

    return result


# Serve the frontend as static files. Mounted last so API routes above take priority.
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
