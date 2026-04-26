"""Orchestrator — routes requests and coordinates all agents."""
from agents import (
    transcription_agent,
    language_detection_agent,
    translation_agent,
    quality_review_agent,
)

MAX_RETRIES = 1


def run_text_pipeline(text: str, source: str, target: str) -> dict:
    """
    Fast text pipeline (no quality review) — keeps real-time typing latency-free.

    Language Detection Agent → Translation Agent
    """
    detected = language_detection_agent.run(text)
    effective_source = detected if detected != source else source

    translation = translation_agent.run(text, effective_source, target)

    return {
        "original_text": text,
        "detected_language": detected,
        "translation": translation,
        "words": [],
    }


def run_audio_pipeline(audio_file: str, source: str, target: str) -> dict:
    """
    Full audio pipeline with quality review and retry on failure.

    Transcription Agent → Language Detection Agent → Translation Agent
    → Quality Review Agent → Retry Translation Agent (if flagged)
    """
    # Transcription Agent
    transcription = transcription_agent.run(audio_file)
    text = transcription["text"]
    words = transcription["words"]

    # Language Detection Agent
    detected = language_detection_agent.run(text)
    effective_source = detected if detected != source else source

    # Translation Agent
    translation = translation_agent.run(text, effective_source, target)

    # Quality Review Agent → Retry Translation Agent if flagged
    for _ in range(MAX_RETRIES):
        review = quality_review_agent.run(text, translation, effective_source, target)
        if review["passed"]:
            break
        translation = translation_agent.run(
            text, effective_source, target, critique=review["critique"]
        )

    return {
        "original_text": text,
        "detected_language": detected,
        "translation": translation,
        "words": words,
        "quality": review,
    }
