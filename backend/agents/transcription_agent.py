"""Transcription Agent — converts audio to text with word-level timestamps."""
import os
from groq import Groq

_client = None

def _get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY environment variable is not set")
        _client = Groq(api_key=api_key)
    return _client


def run(audio_file: str) -> dict:
    client = _get_client()
    with open(audio_file, "rb") as f:
        transcription = client.audio.transcriptions.create(
            file=f,
            model="whisper-large-v3-turbo",
            response_format="verbose_json",
            timestamp_granularities=["word"],
        )

    words = []
    raw_words = getattr(transcription, "words", None) or []
    for w in raw_words:
        # Groq SDK returns words as dicts, not objects
        if isinstance(w, dict):
            words.append({"word": w["word"], "start": w["start"], "end": w["end"]})
        else:
            words.append({"word": w.word, "start": w.start, "end": w.end})

    return {"text": transcription.text.strip(), "words": words}
