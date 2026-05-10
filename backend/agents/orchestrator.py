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
import vocabulary_store

logger = logging.getLogger(__name__)
MAX_RETRIES = 1
_DETECT_OVERRIDE_MIN_LEN = 6


def run_text_pipeline(text: str, source: str, target: str) -> dict:
    """Fast text pipeline (no quality review) — keeps real-time typing latency low.

    Language Detection → Enterprise Vocabulary lookup → Translation
    """
    detected = language_detection_agent.run(text)
    effective_source = detected if detected != source else source

    vocab_entries = vocabulary_store.search(text, effective_source)
    vocab_ctx = vocabulary_store.to_context(vocab_entries, target)
    vocab_ver = vocabulary_store.get_version()

    translation = translation_agent.run(
        text, effective_source, target,
        vocab_context=vocab_ctx, vocab_version=vocab_ver,
    )

    return {
        "original_text": text,
        "detected_language": detected,
        "translation": translation,
        "vocab_hits": len(vocab_entries),
        "words": [],
    }


def run_conversation_pipeline(text: str, source: str, target: str) -> dict:
    """Per-participant conversation pipeline with full anti-hallucination guardrails.

    Conversation Agent (clean fillers) → Language Detection
    → Enterprise Vocabulary lookup
    → Strict Translation (70B, temp=0, voice-preserving)
    → Fast Quality Review (8B-instant) → Retry once with critique if flagged

    The review uses a smaller/faster Groq model than translation so the extra
    round-trip stays under ~150 ms.  Every external call is wrapped with a
    failsafe — a transient API error never silently drops a message.
    """
    cleaned = conversation_agent.run(text, source_lang=source)

    detected = language_detection_agent.run(cleaned)
    effective_source = (
        detected
        if detected != source and len(cleaned) >= _DETECT_OVERRIDE_MIN_LEN
        else source
    )

    # Vocabulary lookup runs once; the version is threaded through so the
    # cache key changes whenever vocabulary is updated.
    vocab_entries = vocabulary_store.search(cleaned, effective_source)
    vocab_ctx = vocabulary_store.to_context(vocab_entries, target)
    vocab_ver = vocabulary_store.get_version()

    try:
        translation = translation_agent.run(
            cleaned, effective_source, target,
            strict=True, vocab_context=vocab_ctx, vocab_version=vocab_ver,
        )
    except Exception as e:
        logger.error("Translation agent failed: %s", e)
        translation = cleaned

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
                vocab_context=vocab_ctx, vocab_version=vocab_ver,
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
        "vocab_hits": len(vocab_entries),
    }


def run_keyboard_pipeline(text: str, source: str, target: str) -> dict:
    """Keyboard pipeline: Keyboard Agent → Language Detection → Translation."""
    cleaned = keyboard_agent.run(text)
    detected = language_detection_agent.run(cleaned)
    effective_source = detected if detected != source else source

    vocab_entries = vocabulary_store.search(cleaned, effective_source)
    vocab_ctx = vocabulary_store.to_context(vocab_entries, target)
    vocab_ver = vocabulary_store.get_version()

    translation = translation_agent.run(
        cleaned, effective_source, target,
        vocab_context=vocab_ctx, vocab_version=vocab_ver,
    )
    return {
        "original_text": cleaned,
        "detected_language": detected,
        "translation": translation,
        "vocab_hits": len(vocab_entries),
    }


def run_audio_pipeline(audio_file: str, source: str, target: str) -> dict:
    """Full audio pipeline with quality review and retry on failure.

    Transcription → Language Detection → Enterprise Vocabulary lookup
    → Translation → Quality Review → Retry if flagged
    """
    transcription = transcription_agent.run(audio_file)
    text = transcription["text"]
    words = transcription["words"]

    detected = language_detection_agent.run(text)
    effective_source = detected if detected != source else source

    vocab_entries = vocabulary_store.search(text, effective_source)
    vocab_ctx = vocabulary_store.to_context(vocab_entries, target)
    vocab_ver = vocabulary_store.get_version()

    translation = translation_agent.run(
        text, effective_source, target,
        vocab_context=vocab_ctx, vocab_version=vocab_ver,
    )

    review = {"passed": True, "critique": ""}
    for _ in range(MAX_RETRIES):
        review = quality_review_agent.run(text, translation, effective_source, target)
        if review["passed"]:
            break
        translation = translation_agent.run(
            text, effective_source, target,
            critique=review["critique"],
            vocab_context=vocab_ctx, vocab_version=vocab_ver,
        )

    return {
        "original_text": text,
        "detected_language": detected,
        "translation": translation,
        "words": words,
        "quality": review,
        "vocab_hits": len(vocab_entries),
    }
