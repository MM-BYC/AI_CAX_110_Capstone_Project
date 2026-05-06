"""Transcription Agent — converts audio to text using NVIDIA Parakeet TDT 1.1B."""
import os
import requests

_API_URL = "https://integrate.api.nvidia.com/v1/audio/transcriptions"
_MODEL   = "nvidia/parakeet-tdt-1.1b"

# Parakeet TDT hallucinates these on silence or very short audio.
_HALLUCINATIONS = {
    "", ".", " ", "you", "you.", "uh.", "hmm.", "um.",
    "thank you.", "thank you", "thanks.", "thanks",
    "bye.", "bye", "goodbye.", "goodbye",
    "the.", "the", "okay.", "okay", "ok.", "ok",
    "yes.", "yes", "no.", "no", "right.", "right",
}


def run(audio_file: str, language: str = None) -> dict:
    """
    Transcribe audio using NVIDIA Parakeet TDT 1.1B via NVIDIA NIM.
    Parakeet TDT is English-optimised; the language param is accepted for
    interface compatibility but is not forwarded to the model.
    Returns {"text": str, "words": []}.
    """
    api_key = os.environ.get("NVIDIA_API_KEY")
    if not api_key:
        raise RuntimeError("NVIDIA_API_KEY environment variable is not set")

    ext  = os.path.splitext(audio_file)[1].lstrip(".") or "mp4"
    mime = f"audio/{ext}"

    with open(audio_file, "rb") as f:
        resp = requests.post(
            _API_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": (os.path.basename(audio_file), f, mime)},
            data={"model": _MODEL},
            timeout=30,
        )

    resp.raise_for_status()
    text = resp.json().get("text", "").strip()

    if text.lower() in _HALLUCINATIONS or len(text) < 3:
        text = ""

    return {"text": text, "words": []}
