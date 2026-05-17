from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from time import time
from typing import Awaitable, Callable, Protocol

from voice_engine.memory import TranslationMemory
from voice_engine.models import TranslationEvent


_NUMBER_RE = re.compile(r"\b\d+(?:[.,]\d+)?\b")


@dataclass(frozen=True)
class FeedbackCorrection:
    target_text: str
    confidence: float
    reason: str
    provider: str = "feedback_model"
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class FeedbackDecision:
    translation: TranslationEvent
    corrected: bool
    learned: bool
    reason: str
    metadata: dict[str, str] = field(default_factory=dict)


class AsyncCorrectionProvider(Protocol):
    async def suggest_correction(self, event: TranslationEvent, reason: str) -> FeedbackCorrection | None:
        ...


CorrectionProvider = Callable[[TranslationEvent, str], Awaitable[FeedbackCorrection | None]]


class TranslationFeedbackModel:
    """Fast correction loop before translated text reaches TTS.

    The model is deliberately conservative:
      - exact/fuzzy approved memory can override a candidate immediately
      - deterministic checks catch obvious unsafe output
      - an optional provider can generate a corrected candidate
      - accepted provider corrections are persisted for future training
    """

    def __init__(
        self,
        memory: TranslationMemory,
        correction_provider: AsyncCorrectionProvider | CorrectionProvider | None = None,
        min_provider_confidence: float = 0.86,
        review_all_with_provider: bool = False,
        training_path: Path | None = None,
    ):
        self.memory = memory
        self.correction_provider = correction_provider
        self.min_provider_confidence = min_provider_confidence
        self.review_all_with_provider = review_all_with_provider
        self.training_path = training_path

    async def apply(
        self,
        event: TranslationEvent,
        namespace: str = "global",
        domain: str = "general",
        metadata: dict[str, str] | None = None,
    ) -> FeedbackDecision:
        memory_match = self.memory.lookup(
            event.source_text,
            source_language=event.source_language,
            target_language=event.target_language,
            namespace=namespace,
            domain=domain,
        )
        if memory_match and memory_match.confidence >= 0.96:
            return self._decision_from_correction(
                event,
                FeedbackCorrection(
                    target_text=memory_match.entry.target_text,
                    confidence=memory_match.confidence,
                    reason="approved translation memory match",
                    provider="translation_memory",
                    metadata={
                        "memory_similarity": f"{memory_match.similarity:.3f}",
                        "memory_exact": str(memory_match.exact).lower(),
                    },
                ),
                learned=False,
                extra_metadata=metadata,
            )

        reason = self._failure_reason(event)
        if not reason:
            if self.review_all_with_provider and self.correction_provider is not None:
                correction = await self._provider_correction(event, "provider translation review")
                if correction is not None and correction.confidence >= self.min_provider_confidence:
                    learned = self._learn(event, correction, namespace=namespace, domain=domain, metadata=metadata)
                    return self._decision_from_correction(event, correction, learned=learned, extra_metadata=metadata)
            return FeedbackDecision(
                translation=event,
                corrected=False,
                learned=False,
                reason="passed feedback model",
                metadata={**event.metadata, **(metadata or {}), "feedback_passed": "true"},
            )

        correction = await self._provider_correction(event, reason)
        if correction is None or correction.confidence < self.min_provider_confidence:
            return FeedbackDecision(
                translation=TranslationEvent(
                    source_text=event.source_text,
                    target_text=event.target_text,
                    confidence=min(event.confidence, 0.70),
                    source_language=event.source_language,
                    target_language=event.target_language,
                    metadata={
                        **event.metadata,
                        **(metadata or {}),
                        "feedback_passed": "false",
                        "feedback_reason": reason,
                    },
                ),
                corrected=False,
                learned=False,
                reason=reason,
            )

        learned = self._learn(event, correction, namespace=namespace, domain=domain, metadata=metadata)
        return self._decision_from_correction(event, correction, learned=learned, extra_metadata=metadata)

    def _failure_reason(self, event: TranslationEvent) -> str:
        if not event.target_text.strip():
            return "empty translation"
        if event.source_language != event.target_language:
            source_norm = event.source_text.strip().lower()
            target_norm = event.target_text.strip().lower()
            if source_norm == target_norm:
                return "translation copied source text"
        source_numbers = _NUMBER_RE.findall(event.source_text)
        target_numbers = _NUMBER_RE.findall(event.target_text)
        missing_numbers = [number for number in source_numbers if number not in target_numbers]
        if missing_numbers:
            return f"missing numeric tokens: {missing_numbers}"
        if event.confidence < 0.82:
            return "translation confidence below feedback threshold"
        return ""

    async def _provider_correction(self, event: TranslationEvent, reason: str) -> FeedbackCorrection | None:
        provider = self.correction_provider
        if provider is None:
            return None
        if hasattr(provider, "suggest_correction"):
            return await provider.suggest_correction(event, reason)
        return await provider(event, reason)

    def _learn(
        self,
        event: TranslationEvent,
        correction: FeedbackCorrection,
        namespace: str,
        domain: str,
        metadata: dict[str, str] | None = None,
    ) -> bool:
        corrected = correction.target_text.strip()
        if not corrected or corrected == event.target_text:
            return False
        entry = self.memory.learn_correction(
            source_text=event.source_text,
            target_text=corrected,
            source_language=event.source_language,
            target_language=event.target_language,
            namespace=namespace,
            domain=domain,
            metadata={
                **(metadata or {}),
                "feedback_provider": correction.provider,
                "feedback_reason": correction.reason,
            },
        )
        self._append_training_example(event, correction, asdict(entry))
        return True

    def _decision_from_correction(
        self,
        event: TranslationEvent,
        correction: FeedbackCorrection,
        learned: bool,
        extra_metadata: dict[str, str] | None = None,
    ) -> FeedbackDecision:
        corrected_text = correction.target_text.strip()
        changed = bool(corrected_text and corrected_text != event.target_text)
        translation = TranslationEvent(
            source_text=event.source_text,
            target_text=corrected_text or event.target_text,
            confidence=max(event.confidence, correction.confidence),
            source_language=event.source_language,
            target_language=event.target_language,
            metadata={
                **event.metadata,
                **(extra_metadata or {}),
                **correction.metadata,
                "feedback_passed": "true",
                "feedback_corrected": str(changed).lower(),
                "feedback_provider": correction.provider,
                "feedback_reason": correction.reason,
            },
        )
        return FeedbackDecision(
            translation=translation,
            corrected=changed,
            learned=learned,
            reason=correction.reason,
            metadata=translation.metadata,
        )

    def _append_training_example(
        self,
        event: TranslationEvent,
        correction: FeedbackCorrection,
        entry: dict,
    ) -> None:
        if self.training_path is None:
            return
        self.training_path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "created_at": time(),
            "source_text": event.source_text,
            "bad_translation": event.target_text,
            "correct_translation": correction.target_text,
            "source_language": event.source_language,
            "target_language": event.target_language,
            "feedback_provider": correction.provider,
            "feedback_reason": correction.reason,
            "confidence": correction.confidence,
            "memory_entry": entry,
        }
        with self.training_path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(record, ensure_ascii=False) + "\n")
