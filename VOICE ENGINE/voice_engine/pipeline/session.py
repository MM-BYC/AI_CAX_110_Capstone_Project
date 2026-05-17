from voice_engine.config import EngineConfig, ParticipantConfig
from voice_engine.engines import DebugStreamingASR, GlossaryTranslator, SpeakerEmbeddingEngine, ToneTTS
from voice_engine.feedback import TranslationFeedbackModel
from voice_engine.memory import MemoryAugmentedTranslator, TranslationMemory
from voice_engine.memory.storage import default_training_path
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
        translation_memory: TranslationMemory | None = None,
        feedback_model: TranslationFeedbackModel | None = None,
    ):
        self.config = config or EngineConfig()
        self.participant_a = participant_a
        self.participant_b = participant_b
        self.speaker_profiles = SpeakerEmbeddingEngine()

        # Placeholders. Replace these with trained native local models.
        memory = translation_memory
        if memory is None and phrase_table is not None:
            memory = TranslationMemory.from_phrase_table(
                phrase_table,
                min_similarity=self.config.translation_memory_min_similarity,
            )
        if memory is None:
            memory = TranslationMemory.create_default(min_similarity=self.config.translation_memory_min_similarity)
        translator = MemoryAugmentedTranslator(
            GlossaryTranslator(phrase_table),
            memory=memory,
            min_accept_confidence=self.config.translation_min_confidence,
        )
        self.translator = translator
        self.feedback_model = feedback_model or TranslationFeedbackModel(
            memory=memory,
            training_path=default_training_path(),
        )
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
            feedback_model=self.feedback_model,
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
            feedback_model=self.feedback_model,
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

    def learn_translation_correction(
        self,
        source_participant_id: str,
        source_text: str,
        target_text: str,
        metadata: dict[str, str] | None = None,
    ) -> None:
        """Store an approved correction for the A/B call memory layer."""
        if source_participant_id == self.participant_a.participant_id:
            source = self.participant_a
            target = self.participant_b
        elif source_participant_id == self.participant_b.participant_id:
            source = self.participant_b
            target = self.participant_a
        else:
            raise ValueError(f"unknown participant: {source_participant_id}")
        self.translator.learn_correction(
            source_text=source_text,
            target_text=target_text,
            source_language=source.source_language,
            target_language=source.target_language or target.source_language,
            metadata=metadata,
        )
