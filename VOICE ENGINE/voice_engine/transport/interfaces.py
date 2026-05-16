from typing import Protocol

from voice_engine.models import AudioFrame, SynthAudioEvent


class AudioSource(Protocol):
    async def receive_frame(self) -> AudioFrame:
        ...


class AudioSink(Protocol):
    async def send_audio(self, event: SynthAudioEvent) -> None:
        ...


class PhoneTransport(Protocol):
    """Transport boundary for phone clients.

    Production implementations must ensure only synthesized translated audio is
    sent to the opposite participant.
    """

    async def receive_from_phone(self, participant_id: str) -> AudioFrame:
        ...

    async def send_to_phone(self, event: SynthAudioEvent) -> None:
        ...
