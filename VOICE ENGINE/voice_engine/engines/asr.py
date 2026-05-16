from typing import Protocol

from voice_engine.models import AudioFrame, TranscriptEvent


class StreamingASR(Protocol):
    async def accept_audio(self, frame: AudioFrame) -> list[TranscriptEvent]:
        ...


class DebugStreamingASR:
    """Deterministic ASR placeholder for wiring and tests.

    It reads `frame.metadata["debug_text"]` so the pipeline can be exercised
    before trained local ASR models exist.
    """

    async def accept_audio(self, frame: AudioFrame) -> list[TranscriptEvent]:
        text = frame.metadata.get("debug_text", "").strip()
        if not text:
            return []
        return [
            TranscriptEvent(
                text=text,
                is_final=True,
                confidence=float(frame.metadata.get("debug_confidence", "0.95")),
                timestamp_ms=frame.timestamp_ms,
            )
        ]
