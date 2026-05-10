"""Orchestrator — routes requests and coordinates all agents."""
import logging
from agents import (
    transcription_agent,
    language_detection_agent,
    translation_agent,
    quality_review_agent,
    keyboard_agent,
    conversation_agent,
)

logger = logging.getLogger(__name__)
MAX_RETRIES = 1
# Minimum cleaned-text length before language detection can override the
# user's chosen source language.  Short phrases (< 6 chars) produce
# unreliable detection scores and must not silently flip the source lang.
_DETECT_OVERRIDE_MIN_LEN = 6


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


def run_conversation_pipeline(text: str, source: str, target: str) -> dict:
    """
    Per-participant conversation pipeline tuned for ≤1 s end-to-end latency.

    Conversation Agent (clean fillers) → Language Detection Agent
    → Strict Translation Agent (system prompt + temperature=0)

    Quality review is intentionally omitted in the live path — it doubles
    LLM round-trips. Hallucination defenses already run upstream
    (client noise gate + server blocklist + echo suppression).
    """
    cleaned = conversation_agent.run(text, source_lang=source)

    detected = language_detection_agent.run(cleaned)
    effective_source = (
        detected
        if detected != source and len(cleaned) >= _DETECT_OVERRIDE_MIN_LEN
        else source
    )

    try:
        translation = translation_agent.run(cleaned, effective_source, target, strict=True)
    except Exception as e:
        logger.error("Translation agent failed: %s", e)
        translation = cleaned  # pass-through so the message is still delivered

    return {
        "original_text": text,
        "cleaned_text": cleaned,
        "detected_language": detected,
        "translation": translation,
        "quality": {"passed": True, "critique": ""},
    }


def run_keyboard_pipeline(text: str, source: str, target: str) -> dict:
    """
    Keyboard pipeline: Keyboard Agent → Language Detection Agent → Translation Agent
    """
    cleaned = keyboard_agent.run(text)
    detected = language_detection_agent.run(cleaned)
    effective_source = detected if detected != source else source
    translation = translation_agent.run(cleaned, effective_source, target)
    return {
        "original_text": cleaned,
        "detected_language": detected,
        "translation": translation,
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
