import os
from groq import Groq
from dotenv import load_dotenv

load_dotenv()

_client = Groq(api_key=os.environ.get("GROQ_API_KEY"))


def speech_to_text(audio_file: str) -> dict:
    """Transcribe audio using Groq's hosted Whisper API with word-level timestamps."""
    with open(audio_file, "rb") as f:
        transcription = _client.audio.transcriptions.create(
            file=f,
            model="whisper-large-v3-turbo",
            response_format="verbose_json",
            timestamp_granularities=["word"],
        )

    words = []
    if hasattr(transcription, "words") and transcription.words:
        for w in transcription.words:
            words.append({"word": w.word, "start": w.start, "end": w.end})

    return {"text": transcription.text.strip(), "words": words}
