from dataclasses import dataclass, field


@dataclass(frozen=True)
class ParticipantConfig:
    participant_id: str
    display_name: str
    source_language: str
    target_language: str
    voice_profile_id: str | None = None


@dataclass(frozen=True)
class EngineConfig:
    sample_rate_hz: int = 16_000
    frame_ms: int = 20
    jitter_buffer_ms: int = 60
    asr_min_confidence: float = 0.72
    translation_min_confidence: float = 0.78
    translation_memory_min_similarity: float = 0.92
    phrase_commit_ms: int = 280
    max_output_queue_ms: int = 1_500
    translated_audio_only: bool = True
    glossary: dict[str, str] = field(default_factory=dict)

    @property
    def samples_per_frame(self) -> int:
        return int(self.sample_rate_hz * self.frame_ms / 1000)
