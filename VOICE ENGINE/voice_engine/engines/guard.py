import re

from voice_engine.exceptions import GuardRejectedOutput
from voice_engine.models import TranslationEvent


_NUMBER_RE = re.compile(r"\b\d+(?:[.,]\d+)?\b")


class TerminologyGuard:
    """Blocks translations that violate deterministic safety checks."""

    def __init__(self, min_confidence: float, glossary: dict[str, str] | None = None):
        self.min_confidence = min_confidence
        self.glossary = glossary or {}

    def validate(self, event: TranslationEvent) -> TranslationEvent:
        if event.confidence < self.min_confidence:
            raise GuardRejectedOutput("translation confidence below threshold")

        source_numbers = _NUMBER_RE.findall(event.source_text)
        target_numbers = _NUMBER_RE.findall(event.target_text)
        missing_numbers = [number for number in source_numbers if number not in target_numbers]
        if missing_numbers:
            raise GuardRejectedOutput(f"missing numeric tokens: {missing_numbers}")

        for source_term, target_term in self.glossary.items():
            if source_term.lower() in event.source_text.lower():
                if target_term.lower() not in event.target_text.lower():
                    raise GuardRejectedOutput(f"missing glossary term: {target_term}")

        if not event.target_text.strip():
            raise GuardRejectedOutput("empty target translation")

        return event
