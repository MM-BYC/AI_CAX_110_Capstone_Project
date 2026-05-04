"""Orchestrator — routes requests and coordinates all agents."""
from agents import (
    transcription_agent,
    language_detection_agent,
    translation_agent,
    quality_review_agent,
    keyboard_agent,
    conversation_agent,
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


def run_conversation_pipeline(text: str, source: str, target: str) -> dict:
    """
    Per-participant conversation pipeline with full anti-hallucination guardrails.

    Conversation Agent (clean fillers) → Language Detection Agent
    → Strict Translation Agent (system prompt + temperature=0)
    → Quality Review Agent → Retry with critique (if flagged)
    """
    # Conversation Agent — remove fillers, normalise whitespace
    cleaned = conversation_agent.run(text, source_lang=source)

    # Language Detection Agent — confirm source language
    detected = language_detection_agent.run(cleaned)
    effective_source = detected if detected != source else source

    # Strict Translation Agent
    translation = translation_agent.run(cleaned, effective_source, target, strict=True)

    # Quality Review Agent → retry once with critique if hallucination detected
    review = {"passed": True, "critique": ""}
    for _ in range(MAX_RETRIES):
        review = quality_review_agent.run(cleaned, translation, effective_source, target)
        if review["passed"]:
            break
        translation = translation_agent.run(
            cleaned, effective_source, target,
            critique=review["critique"], strict=True,
        )

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
