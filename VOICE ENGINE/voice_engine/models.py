from dataclasses import dataclass, field
from enum import Enum
from time import monotonic


class Direction(str, Enum):
    A_TO_B = "A_TO_B"
    B_TO_A = "B_TO_A"


@dataclass(frozen=True)
class AudioFrame:
    participant_id: str
    pcm16: bytes
    sample_rate_hz: int
    timestamp_ms: int
    duration_ms: int
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class TranscriptEvent:
    text: str
    is_final: bool
    confidence: float
    timestamp_ms: int


@dataclass(frozen=True)
class CommittedPhrase:
    source_text: str
    confidence: float
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class TranslationEvent:
    source_text: str
    target_text: str
    confidence: float
    source_language: str
    target_language: str
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class VoiceProfile:
    participant_id: str
    profile_id: str
    embedding: tuple[float, ...] = ()
    ready: bool = False


@dataclass(frozen=True)
class SynthAudioEvent:
    recipient_id: str
    source_participant_id: str
    pcm16: bytes
    sample_rate_hz: int
    duration_ms: int
    text: str
    created_at: float = field(default_factory=monotonic)
    audio_format: str = "pcm16"
    metadata: dict[str, str] = field(default_factory=dict)
