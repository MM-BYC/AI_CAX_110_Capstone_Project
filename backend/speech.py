import whisper

model = whisper.load_model("base")


def speech_to_text(audio_file: str) -> str:
    """Convert audio file to text using Whisper."""
    result = model.transcribe(audio_file)
    return result["text"]
