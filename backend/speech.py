import whisper

model = whisper.load_model("base")


def speech_to_text(audio_file: str) -> dict:
    """Convert audio file to text using Whisper with word-level timestamps."""
    result = model.transcribe(audio_file, word_timestamps=True)
    words = []
    for segment in result["segments"]:
        for word_info in segment.get("words", []):
            words.append({
                "word": word_info["word"],
                "start": word_info["start"],
                "end": word_info["end"]
            })
    return {"text": result["text"].strip(), "words": words}
