from typing import Protocol

from voice_engine.models import CommittedPhrase, TranslationEvent


class TranslationEngine(Protocol):
    async def translate(
        self,
        phrase: CommittedPhrase,
        source_language: str,
        target_language: str,
    ) -> TranslationEvent:
        ...


class GlossaryTranslator:
    """Local deterministic placeholder translator.

    This is not a real general translation model. It exists so the call engine
    can be wired and tested while native trained translation models are built.
    """

    def __init__(self, phrase_table: dict[tuple[str, str, str], str] | None = None):
        self.phrase_table = phrase_table or {}

    async def translate(
        self,
        phrase: CommittedPhrase,
        source_language: str,
        target_language: str,
    ) -> TranslationEvent:
        key = (source_language.lower(), target_language.lower(), phrase.source_text.lower())
        target = self.phrase_table.get(key)
        confidence = 0.98 if target else 0.5
        if not target:
            target = phrase.source_text
        return TranslationEvent(
            source_text=phrase.source_text,
            target_text=target,
            confidence=min(confidence, phrase.confidence),
            source_language=source_language,
            target_language=target_language,
        )
