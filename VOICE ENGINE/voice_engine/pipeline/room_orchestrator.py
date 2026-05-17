import asyncio
from dataclasses import dataclass, field
from typing import Callable, Iterable

from voice_engine.audio import EnergyVAD, JitterBuffer, PassthroughDenoiser
from voice_engine.config import EngineConfig, ParticipantConfig
from voice_engine.engines import DebugStreamingASR, GlossaryTranslator, GroqTranslationEngine, SpeakerEmbeddingEngine, ToneTTS
from voice_engine.engines.asr import StreamingASR
from voice_engine.engines.guard import TerminologyGuard
from voice_engine.engines.translation import TranslationEngine
from voice_engine.engines.tts import TTSEngine
from voice_engine.exceptions import GuardRejectedOutput
from voice_engine.feedback import GroqTranslationReviewer, TranslationFeedbackModel
from voice_engine.memory import MemoryAugmentedTranslator, TranslationMemory
from voice_engine.memory.storage import default_training_path
from voice_engine.metrics import LatencyTrace, StageTimer
from voice_engine.models import AudioFrame, CommittedPhrase, SynthAudioEvent, TranslationEvent
from voice_engine.pipeline.phrase_committer import PhraseCommitter


@dataclass(frozen=True)
class RoomAudioResult:
    """Result returned after a mic frame is accepted by the room orchestrator."""

    source_participant_id: str
    output_events: list[SynthAudioEvent]
    trace: LatencyTrace
    blocked_reason: str | None = None


@dataclass(frozen=True)
class RoomOutputBatch:
    """One or more translated audio events ready for a recipient to play."""

    recipient_id: str
    events: tuple[SynthAudioEvent, ...]


@dataclass
class _ParticipantIngress:
    participant: ParticipantConfig
    jitter: JitterBuffer
    denoiser: PassthroughDenoiser
    vad: EnergyVAD
    asr: StreamingASR
    committer: PhraseCommitter
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


@dataclass
class _RecipientOutputQueue:
    participant_id: str
    max_queued_ms: int
    queue: asyncio.Queue[SynthAudioEvent] = field(default_factory=asyncio.Queue)
    queued_duration_ms: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def put(self, event: SynthAudioEvent) -> None:
        async with self.lock:
            while self.queued_duration_ms + event.duration_ms > self.max_queued_ms:
                try:
                    stale = self.queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                self.queued_duration_ms = max(0, self.queued_duration_ms - stale.duration_ms)
                self.queue.task_done()
            await self.queue.put(event)
            self.queued_duration_ms += event.duration_ms

    async def get(self, timeout_s: float | None = None) -> SynthAudioEvent | None:
        try:
            if timeout_s is None:
                event = await self.queue.get()
            else:
                event = await asyncio.wait_for(self.queue.get(), timeout=timeout_s)
        except asyncio.TimeoutError:
            return None
        async with self.lock:
            self.queued_duration_ms = max(0, self.queued_duration_ms - event.duration_ms)
        self.queue.task_done()
        return event

    async def drain_ready(self, max_events: int = 8) -> tuple[SynthAudioEvent, ...]:
        events: list[SynthAudioEvent] = []
        async with self.lock:
            while len(events) < max_events:
                try:
                    event = self.queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                self.queued_duration_ms = max(0, self.queued_duration_ms - event.duration_ms)
                self.queue.task_done()
                events.append(event)
        return tuple(events)


class VoiceEngineOrchestrator:
    """Room-level async orchestrator for many live callers.

    Each participant has one ingress pipeline. A committed phrase is translated
    and synthesized for every other participant, then placed into that
    recipient's output queue. Raw mic audio is never placed in an output queue.
    """

    def __init__(
        self,
        room_id: str,
        participants: Iterable[ParticipantConfig] = (),
        config: EngineConfig | None = None,
        translator: TranslationEngine | None = None,
        tts: TTSEngine | None = None,
        speaker_profiles: SpeakerEmbeddingEngine | None = None,
        asr_factory: Callable[[], StreamingASR] | None = None,
        translation_memory: TranslationMemory | None = None,
        memory_namespace: str | None = None,
        memory_domain: str = "general",
        feedback_model: TranslationFeedbackModel | None = None,
        feedback_correction_provider=None,
    ):
        self.room_id = room_id
        self.config = config or EngineConfig()
        self.translation_memory = translation_memory or TranslationMemory.create_default(
            min_similarity=self.config.translation_memory_min_similarity
        )
        self.memory_namespace = memory_namespace or room_id
        self.memory_domain = memory_domain
        base_translator = translator or GroqTranslationEngine.from_environment() or GlossaryTranslator()
        self.translator = MemoryAugmentedTranslator(
            base_translator,
            memory=self.translation_memory,
            min_accept_confidence=self.config.translation_min_confidence,
            namespace=self.memory_namespace,
            domain=memory_domain,
        )
        correction_provider = feedback_correction_provider
        if correction_provider is None:
            correction_provider = GroqTranslationReviewer.from_environment()
        self.feedback_model = feedback_model or TranslationFeedbackModel(
            memory=self.translation_memory,
            correction_provider=correction_provider,
            review_all_with_provider=correction_provider is not None,
            training_path=default_training_path(),
        )
        self.tts = tts or ToneTTS(self.config.sample_rate_hz)
        self.speaker_profiles = speaker_profiles or SpeakerEmbeddingEngine()
        self.asr_factory = asr_factory or DebugStreamingASR
        self.guard = TerminologyGuard(self.config.translation_min_confidence, self.config.glossary)
        self._participants: dict[str, ParticipantConfig] = {}
        self._ingress: dict[str, _ParticipantIngress] = {}
        self._output_queues: dict[str, _RecipientOutputQueue] = {}
        self._lock = asyncio.Lock()

        for participant in participants:
            self.add_participant(participant)

    @property
    def participant_ids(self) -> tuple[str, ...]:
        return tuple(self._participants)

    def add_participant(self, participant: ParticipantConfig) -> None:
        self._participants[participant.participant_id] = participant
        self._ingress[participant.participant_id] = _ParticipantIngress(
            participant=participant,
            jitter=JitterBuffer(self.config.jitter_buffer_ms),
            denoiser=PassthroughDenoiser(),
            vad=EnergyVAD(),
            asr=self.asr_factory(),
            committer=PhraseCommitter(self.config.asr_min_confidence),
        )
        self._output_queues.setdefault(
            participant.participant_id,
            _RecipientOutputQueue(
                participant_id=participant.participant_id,
                max_queued_ms=self.config.max_output_queue_ms,
            ),
        )

    def remove_participant(self, participant_id: str) -> None:
        self._participants.pop(participant_id, None)
        self._ingress.pop(participant_id, None)
        self._output_queues.pop(participant_id, None)

    def learn_translation_correction(
        self,
        source_participant_id: str,
        recipient_id: str,
        source_text: str,
        target_text: str,
        metadata: dict[str, str] | None = None,
    ) -> None:
        """Store an approved phrase correction for future low-latency lookup."""
        source = self._participants[source_participant_id]
        recipient = self._participants[recipient_id]
        target_language = recipient.target_language or recipient.source_language
        self.translator.learn_correction(
            source_text=source_text,
            target_text=target_text,
            source_language=source.source_language,
            target_language=target_language,
            metadata={
                "room_id": self.room_id,
                "source_participant_id": source_participant_id,
                "recipient_id": recipient_id,
                **(metadata or {}),
            },
        )

    async def accept_audio(self, frame: AudioFrame) -> RoomAudioResult:
        """Accept one caller mic frame and enqueue translated audio for listeners."""
        async with self._lock:
            ingress = self._ingress.get(frame.participant_id)
            if ingress is None:
                trace = LatencyTrace(direction=f"{self.room_id}:{frame.participant_id}:UNKNOWN")
                return RoomAudioResult(
                    source_participant_id=frame.participant_id,
                    output_events=[],
                    trace=trace,
                    blocked_reason="unknown participant",
                )

        async with ingress.lock:
            return await self._accept_audio_for_ingress(frame, ingress)

    async def _accept_audio_for_ingress(
        self,
        frame: AudioFrame,
        ingress: _ParticipantIngress,
    ) -> RoomAudioResult:
        trace = LatencyTrace(direction=f"{self.room_id}:{frame.participant_id}:ROOM")
        timer = StageTimer(trace)
        output_events: list[SynthAudioEvent] = []

        with timer.stage("jitter_buffer"):
            ingress.jitter.push(frame)
            if not ingress.jitter.ready():
                return RoomAudioResult(frame.participant_id, output_events, trace)
            clean_candidate = ingress.jitter.pop()
            if clean_candidate is None:
                return RoomAudioResult(frame.participant_id, output_events, trace)

        with timer.stage("denoise"):
            clean_frame = ingress.denoiser.process(clean_candidate)

        with timer.stage("vad"):
            if not ingress.vad.is_speech(clean_frame):
                return RoomAudioResult(frame.participant_id, output_events, trace)

        with timer.stage("speaker_profile"):
            speaker_profile = self.speaker_profiles.enroll_or_update(frame.participant_id, clean_frame)

        with timer.stage("asr"):
            transcript_events = await ingress.asr.accept_audio(clean_frame)

        committed_phrases: list[CommittedPhrase] = []
        for transcript in transcript_events:
            with timer.stage("phrase_commit"):
                phrase = ingress.committer.accept(transcript)
            if phrase is not None:
                committed_phrases.append(phrase)

        if not committed_phrases:
            return RoomAudioResult(frame.participant_id, output_events, trace)

        for phrase in committed_phrases:
            with timer.stage("fanout"):
                deliveries = await asyncio.gather(
                    *[
                        self._translate_synthesize_enqueue(
                            source=ingress.participant,
                            recipient=recipient,
                            phrase=phrase,
                            speaker_profile=speaker_profile,
                        )
                        for recipient in self._listeners_for(ingress.participant.participant_id)
                    ],
                    return_exceptions=True,
                )
            for delivery in deliveries:
                if isinstance(delivery, GuardRejectedOutput):
                    return RoomAudioResult(
                        frame.participant_id,
                        output_events,
                        trace,
                        blocked_reason=str(delivery),
                    )
                if isinstance(delivery, Exception) or delivery is None:
                    continue
                output_events.append(delivery)

        return RoomAudioResult(frame.participant_id, output_events, trace)

    async def next_output_for(
        self,
        participant_id: str,
        timeout_s: float | None = None,
    ) -> SynthAudioEvent | None:
        """Wait for the next translated audio event for one participant."""
        queue = self._output_queues.get(participant_id)
        if queue is None:
            return None
        return await queue.get(timeout_s=timeout_s)

    async def next_output_batch_for(
        self,
        participant_id: str,
        timeout_s: float | None = None,
        max_events: int = 8,
    ) -> RoomOutputBatch | None:
        """Wait for one event, then return the currently ready playback batch."""
        first = await self.next_output_for(participant_id, timeout_s=timeout_s)
        if first is None:
            return None
        queue = self._output_queues.get(participant_id)
        if queue is None:
            return RoomOutputBatch(participant_id=participant_id, events=(first,))
        rest = await queue.drain_ready(max_events=max(0, max_events - 1))
        return RoomOutputBatch(participant_id=participant_id, events=(first, *rest))

    def _listeners_for(self, source_participant_id: str) -> tuple[ParticipantConfig, ...]:
        return tuple(
            participant
            for participant_id, participant in self._participants.items()
            if participant_id != source_participant_id
        )

    async def _translate_synthesize_enqueue(
        self,
        source: ParticipantConfig,
        recipient: ParticipantConfig,
        phrase: CommittedPhrase,
        speaker_profile,
    ) -> SynthAudioEvent | None:
        target_language = recipient.target_language or recipient.source_language
        translation = await self.translator.translate(
            phrase,
            source_language=source.source_language,
            target_language=target_language,
        )
        if self.feedback_model is not None:
            feedback = await self.feedback_model.apply(
                translation,
                namespace=self.memory_namespace,
                domain=self.memory_domain,
                metadata={
                    "room_id": self.room_id,
                    "source_participant_id": source.participant_id,
                    "recipient_id": recipient.participant_id,
                },
            )
            translation = feedback.translation
        try:
            translation = self.guard.validate(translation)
        except GuardRejectedOutput as exc:
            return exc

        event = await self.tts.synthesize(
            TranslationEvent(
                source_text=translation.source_text,
                target_text=translation.target_text,
                confidence=translation.confidence,
                source_language=translation.source_language,
                target_language=target_language,
                metadata=translation.metadata,
            ),
            speaker_profile=speaker_profile,
            recipient_id=recipient.participant_id,
        )
        queue = self._output_queues.get(recipient.participant_id)
        if queue is None:
            return None
        await queue.put(event)
        return event
