import asyncio

from voice_engine import CallSession, EngineConfig, ParticipantConfig
from voice_engine.audio.frames import synth_sine_pcm16
from voice_engine.models import AudioFrame


async def main() -> None:
    config = EngineConfig(jitter_buffer_ms=20)
    participant_a = ParticipantConfig(
        participant_id="A",
        display_name="Person A",
        source_language="English",
        target_language="Spanish",
    )
    participant_b = ParticipantConfig(
        participant_id="B",
        display_name="Person B",
        source_language="Spanish",
        target_language="English",
    )
    phrase_table = {
        ("english", "spanish", "hello 123"): "hola 123",
        ("spanish", "english", "hola 123"): "hello 123",
    }
    session = CallSession(participant_a, participant_b, config, phrase_table=phrase_table)
    frame = AudioFrame(
        participant_id="A",
        pcm16=synth_sine_pcm16(220, config.frame_ms, config.sample_rate_hz),
        sample_rate_hz=config.sample_rate_hz,
        timestamp_ms=0,
        duration_ms=config.frame_ms,
        metadata={"debug_text": "hello 123", "debug_confidence": "0.99"},
    )
    result = await session.accept_audio(frame)
    print(f"audio_events={len(result.audio_events)}")
    print(f"blocked_reason={result.blocked_reason}")
    print(f"latency_total_ms={result.trace.total_ms:.2f}")
    for event in result.audio_events:
        print(
            "event "
            f"recipient={event.recipient_id} "
            f"source={event.source_participant_id} "
            f"text={event.text!r} "
            f"bytes={len(event.pcm16)}"
        )


if __name__ == "__main__":
    asyncio.run(main())
