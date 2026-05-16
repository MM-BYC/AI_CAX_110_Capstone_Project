# VOICE ENGINE

Standalone Python voice-engine workspace for realtime bidirectional audible translation calls.

Everything in this folder is intentionally isolated from the rest of the project. The current implementation is a native Python engine scaffold: it defines the realtime call pipeline, component contracts, guardrails, buffering, metrics, and placeholder engines that can be replaced with trained local models.

It does not use OpenAI, external LLM APIs, or hosted AI services.

## Current Scope

- Two-person translated call session.
- Multi-participant room-level async voice orchestrator.
- A-to-B and B-to-A independent pipelines.
- One live ingress pipeline per participant in a room.
- Per-recipient translated-audio output queues.
- Audio-frame contracts.
- Jitter buffering.
- Energy-based VAD starter.
- Streaming ASR interface.
- Phrase commit logic.
- Translation interface.
- Terminology and anti-hallucination guard.
- Speaker profile and voice-clone interface.
- TTS interface.
- Latency metrics.
- Smoke test with deterministic placeholder components.

## Run Smoke Test

From inside this folder:

```bash
python3 -m voice_engine.smoke_test
```

The smoke test uses synthetic debug frames and placeholder model components. It proves the call-session wiring without raw-audio passthrough.

## Package Use

The intended integration contract is a normal Python package import:

```python
from voice_engine import EngineConfig, ParticipantConfig, VoiceEngineOrchestrator
from voice_engine.models import AudioFrame
```

During local development this folder can be installed into another app:

```bash
python3 -m pip install -e "VOICE ENGINE"
```

An application should not depend on this repository's folder layout. It should import `voice_engine`, create a `VoiceEngineOrchestrator` for each meeting room, pass `AudioFrame` objects into `accept_audio()`, and send returned or queued `SynthAudioEvent` audio only to the event's `recipient_id`.

In `AI_CAX_110_Capstone_Project`, the conversation room follows that package contract:

- The backend first imports the installed `voice_engine` package.
- The local `VOICE ENGINE` folder is only a development fallback.
- Meeting joins call `VoiceEngineOrchestrator.add_participant(...)`.
- Explicit leaves call `VoiceEngineOrchestrator.remove_participant(...)`.
- Browser mic PCM streams to `/ws/voice-engine/{room_id}/{user_id}`.
- Final committed speech is routed through the room orchestrator before the app falls back to the older translation path.
- Room output audio is synthesized through `VoiceEngineNeuralTTSPlatform` first, so A to B and A to C use the VOICE ENGINE package synthesizer before any app-level fallback.

## Full Call Session Pipeline

Use `CallSession` when the call is exactly two people, A to B and B to A.

```python
from voice_engine import CallSession, EngineConfig, ParticipantConfig
from voice_engine.models import AudioFrame

session = CallSession(
    participant_a=ParticipantConfig(
        participant_id="A",
        display_name="Caller A",
        source_language="en",
        target_language="tl",
    ),
    participant_b=ParticipantConfig(
        participant_id="B",
        display_name="Caller B",
        source_language="tl",
        target_language="en",
    ),
    config=EngineConfig(),
)

result = await session.accept_audio(
    AudioFrame(
        participant_id="A",
        pcm16=mic_pcm16_bytes,
        sample_rate_hz=16000,
        timestamp_ms=timestamp_ms,
        duration_ms=20,
    )
)

for event in result.audio_events:
    # Send event.pcm16 to event.recipient_id only.
    pass
```

## Room Voice Orchestrator

Use `VoiceEngineOrchestrator` when the same engine must serve a room with two or more participants and any number of people may talk at the same time.

```python
from voice_engine import EngineConfig, ParticipantConfig, VoiceEngineOrchestrator
from voice_engine.models import AudioFrame

orchestrator = VoiceEngineOrchestrator(
    room_id="992144",
    participants=[
        ParticipantConfig("A", "Caller A", source_language="en", target_language="en"),
        ParticipantConfig("B", "Caller B", source_language="tl", target_language="tl"),
        ParticipantConfig("C", "Caller C", source_language="es", target_language="es"),
    ],
    config=EngineConfig(),
)

await orchestrator.accept_audio(
    AudioFrame(
        participant_id="A",
        pcm16=mic_pcm16_bytes,
        sample_rate_hz=16000,
        timestamp_ms=timestamp_ms,
        duration_ms=20,
        metadata={"room_id": "992144", "sequence": "1801"},
    )
)

event_for_b = await orchestrator.next_output_for("B", timeout_s=0.25)
if event_for_b is not None:
    # Send event_for_b.pcm16 to participant B only.
    pass
```

The room orchestrator keeps the same simple calling model for phone and web clients:

- Clients send mic audio frames to `accept_audio()`.
- Clients receive only generated translated audio from `next_output_for()`.
- Raw caller audio is never placed in another participant's output queue.
- Incoming audio is processed per speaker, so A, B, and C may all speak at the same time.
- Playback is controlled per recipient by an async output queue so one listener can receive translated audio from many speakers without the input streams blocking each other.

The room-level layer runs cleanup, VAD, ASR, and phrase commit once per source participant. When a phrase is committed, translation and synthesis are fanned out concurrently to every other participant, then queued by recipient.

## Production Rule

The phone clients must send mic audio only and receive synthesized translated audio only. Raw participant audio must never be routed to the opposite participant.
