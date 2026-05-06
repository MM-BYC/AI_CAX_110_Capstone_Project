"""Transcription Agent — converts audio to text using NVIDIA Canary-1B."""
import os
import requests

_API_URL = "https://integrate.api.nvidia.com/v1/audio/transcriptions"
_MODEL   = "nvidia/canary-1b"

# Canary-1B hallucinates these on silence or very short audio.
_HALLUCINATIONS = {
    "", ".", " ", "you", "you.", "uh.", "hmm.", "um.",
    "thank you.", "thank you", "thanks.", "thanks",
    "bye.", "bye", "goodbye.", "goodbye",
    "the.", "the", "okay.", "okay", "ok.", "ok",
    "yes.", "yes", "no.", "no", "right.", "right",
}


def run(audio_file: str, language: str = None) -> dict:
    """
    Transcribe audio using NVIDIA Canary-1B via NVIDIA NIM.
    Canary-1B supports English, German, French, and Spanish.
    Pass language (ISO-639-1 code) to improve accuracy; omit for auto-detect.
    Returns {"text": str, "words": []}.
    """
    api_key = os.environ.get("NVIDIA_API_KEY")
    if not api_key:
        raise RuntimeError("NVIDIA_API_KEY environment variable is not set")

    ext  = os.path.splitext(audio_file)[1].lstrip(".") or "mp4"
    mime = f"audio/{ext}"

    data = {"model": _MODEL}
    if language and language != "auto":
        data["language"] = language

    with open(audio_file, "rb") as f:
        resp = requests.post(
            _API_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": (os.path.basename(audio_file), f, mime)},
            data=data,
            timeout=30,
        )

    resp.raise_for_status()
    text = resp.json().get("text", "").strip()

    if text.lower() in _HALLUCINATIONS or len(text) < 3:
        text = ""

    return {"text": text, "words": []}
