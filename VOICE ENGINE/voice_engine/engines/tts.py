from typing import Protocol

from voice_engine.audio.frames import synth_sine_pcm16
from voice_engine.models import SynthAudioEvent, TranslationEvent, VoiceProfile


class TTSEngine(Protocol):
    async def synthesize(
        self,
        translation: TranslationEvent,
        speaker_profile: VoiceProfile,
        recipient_id: str,
    ) -> SynthAudioEvent:
        ...


class ToneTTS:
    """Audible local placeholder for TTS wiring.

    Production replaces this with a speaker-conditioned local neural TTS and
    vocoder. This class intentionally generates a short tone instead of speech.
    """

    def __init__(self, sample_rate_hz: int):
        self.sample_rate_hz = sample_rate_hz

    async def synthesize(
        self,
        translation: TranslationEvent,
        speaker_profile: VoiceProfile,
        recipient_id: str,
    ) -> SynthAudioEvent:
        duration_ms = min(900, max(180, len(translation.target_text) * 25))
        profile_shift = sum(speaker_profile.embedding[:4]) if speaker_profile.embedding else 0.0
        frequency = 440.0 + (profile_shift * 80.0)
        pcm16 = synth_sine_pcm16(frequency, duration_ms, self.sample_rate_hz)
        return SynthAudioEvent(
            recipient_id=recipient_id,
            source_participant_id=speaker_profile.participant_id,
            pcm16=pcm16,
            sample_rate_hz=self.sample_rate_hz,
            duration_ms=duration_ms,
            text=translation.target_text,
            metadata=translation.metadata,
        )
