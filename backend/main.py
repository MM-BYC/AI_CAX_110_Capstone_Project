import os
from fastapi import FastAPI, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from agent import translation_agent

app = FastAPI(title="Language Translation Agent", version="1.0.0")

# Allow requests from the frontend (served on any local origin during dev)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/translate_text")
async def translate_text(source: str, target: str, text: str):
    """Translate plain text from source language to target language."""
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
