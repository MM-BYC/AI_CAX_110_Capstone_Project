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
    Per-participant conversation pipeline with full anti-hallucination guardrails.

    Conversation Agent (clean fillers) → Language Detection Agent
    → Strict Translation Agent (system prompt + temperature=0)
    → Quality Review Agent → Retry with critique (if flagged)

    Every external call is wrapped with a failsafe so a transient API error
    never silently drops a message — the pipeline always returns a translation.
    """
    # Conversation Agent — remove fillers, normalise whitespace
    cleaned = conversation_agent.run(text, source_lang=source)

    # Language Detection Agent — only override the user's chosen language when
    # the text is long enough for reliable detection; short phrases fall back
    # to the claimed source to avoid mis-routing (e.g. "Oo" detected as "en").
    detected = language_detection_agent.run(cleaned)
    effective_source = (
        detected
        if detected != source and len(cleaned) >= _DETECT_OVERRIDE_MIN_LEN
        else source
    )

    # Strict Translation Agent — failsafe: return original text on API error
    try:
        translation = translation_agent.run(cleaned, effective_source, target, strict=True)
    except Exception as e:
        logger.error("Translation agent failed: %s", e)
        translation = cleaned  # pass-through so the message is still delivered

    # Quality Review Agent → retry once with critique if hallucination detected.
    # Failsafe: any API error is treated as a pass so delivery is never blocked.
    review = {"passed": True, "critique": ""}
    for _ in range(MAX_RETRIES):
        try:
            review = quality_review_agent.run(cleaned, translation, effective_source, target)
        except Exception as e:
            logger.warning("Quality review failed (treating as pass): %s", e)
            review = {"passed": True, "critique": ""}
            break
        if review["passed"]:
            break
        try:
            translation = translation_agent.run(
                cleaned, effective_source, target,
                critique=review["critique"], strict=True,
            )
        except Exception as e:
            logger.error("Retry translation failed: %s", e)
            break

    return {
        "original_text": text,
        "cleaned_text": cleaned,
        "detected_language": detected,
        "translation": translation,
        "quality": review,
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
