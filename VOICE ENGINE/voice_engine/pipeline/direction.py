from dataclasses import dataclass

from voice_engine.audio import EnergyVAD, JitterBuffer, PassthroughDenoiser
from voice_engine.config import EngineConfig, ParticipantConfig
from voice_engine.engines.asr import StreamingASR
from voice_engine.engines.guard import TerminologyGuard
from voice_engine.engines.translation import TranslationEngine
from voice_engine.engines.tts import TTSEngine
from voice_engine.engines.voice_clone import SpeakerEmbeddingEngine
from voice_engine.exceptions import GuardRejectedOutput
from voice_engine.feedback import TranslationFeedbackModel
from voice_engine.metrics import LatencyTrace, StageTimer
from voice_engine.models import AudioFrame, Direction, SynthAudioEvent
from voice_engine.pipeline.phrase_committer import PhraseCommitter


@dataclass
class DirectionResult:
    audio_events: list[SynthAudioEvent]
    trace: LatencyTrace
    blocked_reason: str | None = None


class DirectionPipeline:
    def __init__(
        self,
        direction: Direction,
        source: ParticipantConfig,
        recipient: ParticipantConfig,
        config: EngineConfig,
        asr: StreamingASR,
        translator: TranslationEngine,
        tts: TTSEngine,
        speaker_profiles: SpeakerEmbeddingEngine,
        feedback_model: TranslationFeedbackModel | None = None,
    ):
        self.direction = direction
        self.source = source
        self.recipient = recipient
        self.config = config
        self.asr = asr
        self.translator = translator
        self.tts = tts
        self.feedback_model = feedback_model
        self.speaker_profiles = speaker_profiles
        self.jitter = JitterBuffer(config.jitter_buffer_ms)
        self.denoiser = PassthroughDenoiser()
        self.vad = EnergyVAD()
        self.committer = PhraseCommitter(config.asr_min_confidence)
        self.guard = TerminologyGuard(config.translation_min_confidence, config.glossary)

    async def accept_audio(self, frame: AudioFrame) -> DirectionResult:
        trace = LatencyTrace(direction=self.direction.value)
        timer = StageTimer(trace)
        output: list[SynthAudioEvent] = []

        with timer.stage("jitter_buffer"):
            self.jitter.push(frame)
            if not self.jitter.ready():
                return DirectionResult(audio_events=[], trace=trace)
            frame = self.jitter.pop()
            if frame is None:
                return DirectionResult(audio_events=[], trace=trace)

        with timer.stage("denoise"):
            clean_frame = self.denoiser.process(frame)

        with timer.stage("vad"):
            if not self.vad.is_speech(clean_frame):
                return DirectionResult(audio_events=[], trace=trace)

        with timer.stage("speaker_profile"):
            speaker_profile = self.speaker_profiles.enroll_or_update(self.source.participant_id, clean_frame)

        with timer.stage("asr"):
            transcript_events = await self.asr.accept_audio(clean_frame)

        for transcript in transcript_events:
            with timer.stage("phrase_commit"):
                phrase = self.committer.accept(transcript)
            if phrase is None:
                continue

            with timer.stage("translation"):
                translation = await self.translator.translate(
                    phrase,
                    source_language=self.source.source_language,
                    target_language=self.source.target_language,
                )

            if self.feedback_model is not None:
                with timer.stage("feedback"):
                    feedback = await self.feedback_model.apply(
                        translation,
                        namespace="global",
                        domain="general",
                        metadata={
                            "source_participant_id": self.source.participant_id,
                            "recipient_id": self.recipient.participant_id,
                        },
                    )
                    translation = feedback.translation

            try:
                with timer.stage("guard"):
                    translation = self.guard.validate(translation)
            except GuardRejectedOutput as exc:
                return DirectionResult(audio_events=output, trace=trace, blocked_reason=str(exc))

            with timer.stage("tts"):
                output.append(
                    await self.tts.synthesize(
                        translation,
                        speaker_profile=speaker_profile,
                        recipient_id=self.recipient.participant_id,
                    )
                )

        return DirectionResult(audio_events=output, trace=trace)
