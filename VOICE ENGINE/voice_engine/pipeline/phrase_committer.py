from voice_engine.models import CommittedPhrase, TranscriptEvent


class PhraseCommitter:
    """Turns ASR events into committed phrase chunks.

    This first implementation commits final high-confidence ASR events. A
    production version should use unstable/pending/committed token windows.
    """

    def __init__(self, min_confidence: float):
        self.min_confidence = min_confidence

    def accept(self, event: TranscriptEvent) -> CommittedPhrase | None:
        if not event.is_final:
            return None
        if event.confidence < self.min_confidence:
            return None
        text = event.text.strip()
        if not text:
            return None
        return CommittedPhrase(
            source_text=text,
            confidence=event.confidence,
            start_ms=event.timestamp_ms,
            end_ms=event.timestamp_ms,
        )
