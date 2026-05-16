from voice_engine.config import EngineConfig, ParticipantConfig
from voice_engine.engines import DebugStreamingASR, GlossaryTranslator, SpeakerEmbeddingEngine, ToneTTS
from voice_engine.metrics import LatencyTrace
from voice_engine.models import AudioFrame, Direction, SynthAudioEvent
from voice_engine.pipeline.direction import DirectionPipeline, DirectionResult


class CallSession:
    """Bidirectional translated-audio-only call session."""

    def __init__(
        self,
        participant_a: ParticipantConfig,
        participant_b: ParticipantConfig,
        config: EngineConfig | None = None,
        phrase_table: dict[tuple[str, str, str], str] | None = None,
    ):
        self.config = config or EngineConfig()
        self.participant_a = participant_a
        self.participant_b = participant_b
        self.speaker_profiles = SpeakerEmbeddingEngine()

        # Placeholders. Replace these with trained native local models.
        translator = GlossaryTranslator(phrase_table)
        tts = ToneTTS(self.config.sample_rate_hz)

        self.a_to_b = DirectionPipeline(
            direction=Direction.A_TO_B,
            source=participant_a,
            recipient=participant_b,
            config=self.config,
            asr=DebugStreamingASR(),
            translator=translator,
            tts=tts,
            speaker_profiles=self.speaker_profiles,
        )
        self.b_to_a = DirectionPipeline(
            direction=Direction.B_TO_A,
            source=participant_b,
            recipient=participant_a,
            config=self.config,
            asr=DebugStreamingASR(),
            translator=translator,
            tts=tts,
            speaker_profiles=self.speaker_profiles,
        )

    async def accept_audio(self, frame: AudioFrame) -> DirectionResult:
        if frame.participant_id == self.participant_a.participant_id:
            return await self.a_to_b.accept_audio(frame)
        if frame.participant_id == self.participant_b.participant_id:
            return await self.b_to_a.accept_audio(frame)
        return DirectionResult(audio_events=[], trace=LatencyTrace(direction="UNKNOWN"))

    async def route_audio(self, frame: AudioFrame) -> list[SynthAudioEvent]:
        result = await self.accept_audio(frame)
        return result.audio_events
