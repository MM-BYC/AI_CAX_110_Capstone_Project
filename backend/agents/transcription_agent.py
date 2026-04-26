"""Transcription Agent — converts audio to text with word-level timestamps."""
import os
from groq import Groq

_client = Groq(api_key=os.environ.get("GROQ_API_KEY"))


def run(audio_file: str) -> dict:
    with open(audio_file, "rb") as f:
        transcription = _client.audio.transcriptions.create(
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
