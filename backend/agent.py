from langdetect import detect
from speech import speech_to_text
from translator import translate


def translation_agent(
    input_data: str,
    source: str,
    target: str,
    is_audio: bool = False
) -> dict:
    """
    Agentic translation pipeline:
    1. Convert speech to text (if audio input)
    2. Detect the actual source language
    3. Translate to the target language
    """
    # Step 1: Convert speech if needed
    words = []
    if is_audio:
        transcription = speech_to_text(input_data)
        text = transcription["text"]
        words = transcription["words"]
    else:
        text = input_data

    # Step 2: Detect language (auto-correct source if mismatch)
    detected = detect(text)
    if detected != source:
        source = detected

    # Step 3: Translate
    result = translate(text, source, target)

    return {
        "original_text": text,
        "detected_language": detected,
        "translation": result,
        "words": words
    }
