from __future__ import annotations

import asyncio
import os

from voice_engine.agents import VoiceEngineGroqQualityReviewAgent, VoiceEngineGroqTranslationAgent
from voice_engine.feedback.translation_feedback import FeedbackCorrection
from voice_engine.models import TranslationEvent


class GroqTranslationReviewer:
    """VOICE ENGINE-owned LLM reviewer and correction generator."""

    def __init__(
        self,
        api_key: str,
        review_model: str | None = None,
        correction_model: str | None = None,
        confidence: float = 0.91,
    ):
        self.api_key = api_key
        self.review_model = review_model or os.getenv("GROQ_REVIEW_MODEL", "llama-3.1-8b-instant")
        self.correction_model = correction_model or os.getenv("GROQ_TRANSLATION_MODEL", "llama-3.3-70b-versatile")
        self.confidence = confidence
        self.quality_agent = VoiceEngineGroqQualityReviewAgent(api_key=api_key, model=self.review_model)
        self.translation_agent = VoiceEngineGroqTranslationAgent(api_key=api_key, model=self.correction_model)

    @classmethod
    def from_environment(cls) -> GroqTranslationReviewer | None:
        api_key = os.getenv("VOICE_ENGINE_GROQ_API_KEY") or os.getenv("GROQ_API_KEY")
        if not api_key:
            return None
        return cls(
            api_key=api_key,
            review_model=os.getenv("VOICE_ENGINE_REVIEW_MODEL") or os.getenv("GROQ_REVIEW_MODEL"),
            correction_model=os.getenv("VOICE_ENGINE_CORRECTION_MODEL") or os.getenv("GROQ_TRANSLATION_MODEL"),
        )

    async def suggest_correction(self, event: TranslationEvent, reason: str) -> FeedbackCorrection | None:
        review = await asyncio.to_thread(self._review, event, reason)
        if review.get("passed"):
            return None
        critique = review.get("critique") or reason
        corrected = await asyncio.to_thread(self._correct, event, critique)
        if not corrected or corrected.strip() == event.target_text.strip():
            return None
        return FeedbackCorrection(
            target_text=corrected,
            confidence=self.confidence,
            reason=critique[:240],
            provider="voice_engine_groq_reviewer",
            metadata={
                "review_model": self.review_model,
                "correction_model": self.correction_model,
            },
        )

    def _review(self, event: TranslationEvent, reason: str) -> dict:
        return self.quality_agent.review(
            original=event.source_text,
            translation=event.target_text,
            source_language=event.source_language,
            target_language=event.target_language,
            reason=reason,
        )

    def _correct(self, event: TranslationEvent, critique: str) -> str:
        return self.translation_agent.correct(
            source_text=event.source_text,
            bad_translation=event.target_text,
            critique=critique,
            source_language=event.source_language,
            target_language=event.target_language,
        )
