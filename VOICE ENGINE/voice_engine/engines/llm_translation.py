from __future__ import annotations

import asyncio
import os

from voice_engine.agents import VoiceEngineGroqTranslationAgent
from voice_engine.models import CommittedPhrase, TranslationEvent


class GroqTranslationEngine:
    """VOICE ENGINE-owned Groq translation engine.

    This replaces app-level translation agents for room audio translation. The
    engine is intentionally prompt-bound to produce direct translation text only
    and leave validation/correction to the feedback model.
    """

    def __init__(
        self,
        api_key: str,
        model: str | None = None,
        confidence: float = 0.90,
    ):
        self.api_key = api_key
        self.model = model or os.getenv("VOICE_ENGINE_TRANSLATION_MODEL", "llama-3.3-70b-versatile")
        self.confidence = confidence
        self.agent = VoiceEngineGroqTranslationAgent(api_key=api_key, model=self.model)

    @classmethod
    def from_environment(cls) -> GroqTranslationEngine | None:
        api_key = os.getenv("VOICE_ENGINE_GROQ_API_KEY") or os.getenv("GROQ_API_KEY")
        if not api_key:
            return None
        return cls(
            api_key=api_key,
            model=os.getenv("VOICE_ENGINE_TRANSLATION_MODEL") or os.getenv("GROQ_TRANSLATION_MODEL"),
        )

    async def translate(
        self,
        phrase: CommittedPhrase,
        source_language: str,
        target_language: str,
    ) -> TranslationEvent:
        if source_language == target_language:
            target_text = phrase.source_text
        else:
            target_text = await asyncio.to_thread(
                self._translate_sync,
                phrase.source_text,
                source_language,
                target_language,
            )
        return TranslationEvent(
            source_text=phrase.source_text,
            target_text=target_text,
            confidence=min(self.confidence, phrase.confidence),
            source_language=source_language,
            target_language=target_language,
            metadata={
                "translator": "voice_engine_groq_translation",
                "translation_model": self.model,
            },
        )

    def _translate_sync(self, text: str, source_language: str, target_language: str) -> str:
        return self.agent.translate(text, source_language, target_language)
