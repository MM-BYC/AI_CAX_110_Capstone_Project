"""Transcription Agent — converts audio to text with word-level timestamps."""
import os
from groq import Groq

_client = None

# Whisper hallucinates these phrases on silence/very short audio.
_HALLUCINATIONS = {
    "", ".", " ", "you", "you.", "uh.", "hmm.", "um.",
    "thank you.", "thank you", "thanks.", "thanks",
    "bye.", "bye", "goodbye.", "goodbye",
    "the.", "the", "okay.", "okay", "ok.", "ok",
    "yes.", "yes", "no.", "no", "right.", "right",
}


def _get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY environment variable is not set")
        _client = Groq(api_key=api_key)
    return _client


def run(audio_file: str, language: str = None) -> dict:
    """
    Transcribe audio using whisper-large-v3.
    Pass language (ISO-639-1 code, e.g. "tl") to prevent hallucinations on
    non-English audio; omit or pass None for auto-detection.
    """
    client = _get_client()
    kwargs = dict(
        model="whisper-large-v3",
        response_format="verbose_json",
        timestamp_granularities=["word"],
    )
    if language and language != "auto":
        kwargs["language"] = language

    with open(audio_file, "rb") as f:
        kwargs["file"] = f
        transcription = client.audio.transcriptions.create(**kwargs)

    text = transcription.text.strip()
    if text.lower() in _HALLUCINATIONS or len(text) < 3:
        text = ""

    words = []
    raw_words = getattr(transcription, "words", None) or []
    for w in raw_words:
        if isinstance(w, dict):
            words.append({"word": w["word"], "start": w["start"], "end": w["end"]})
        else:
            words.append({"word": w.word, "start": w.start, "end": w.end})

    return {"text": text, "words": words}
