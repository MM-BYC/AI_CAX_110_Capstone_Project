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
- Built-in Groq translation engine for package-owned translation.
- Translation memory and confidence guard layer.
- Automatic translation feedback model before TTS.
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

## Translation Memory and Confidence Guard

The orchestrator now wraps the configured translator with a local translation-memory layer. This is the low-latency anti-hallucination helper for live calls:

- Approved source phrase -> target phrase corrections are stored locally.
- A persistent JSONL memory path is created automatically by the package.
- A local vector index is built in-process for fast retrieval.
- Pinecone can mirror approved examples for external vector storage when configured.
- Exact or high-similarity approved matches can be used immediately.
- Weaker matches become confidence signals instead of hard overrides.
- Grammar-profile scoring learns simple structure from approved examples.
- The existing terminology guard still blocks low-confidence or incomplete output.

This module does not claim that hallucination is impossible. Its job is to keep the realtime path conservative: use known good translations quickly, preserve important terms and numbers, and lower confidence when the engine cannot justify the output.

Package users can create memory explicitly:

```python
from voice_engine import TranslationMemory, TranslationMemoryEntry, VoiceEngineOrchestrator

memory = TranslationMemory(
    entries=[
        TranslationMemoryEntry(
            source_language="en",
            target_language="tl",
            source_text="I am on my way",
            target_text="Papunta na ako",
            namespace="global",
            domain="general",
        )
    ]
)

orchestrator = VoiceEngineOrchestrator(
    room_id="992144",
    participants=[participant_a, participant_b],
    translation_memory=memory,
)
```

After a human-approved correction, feed it back through the orchestrator:

```python
orchestrator.learn_translation_correction(
    source_participant_id="A",
    recipient_id="B",
    source_text="I am on my way",
    target_text="Papunta na ako",
    metadata={"reviewer": "operator"},
)
```

Future matching chunks are retrieved in-process first. Pinecone is treated as an external mirror and fallback, not as the first blocking step in the live audio path.

The default persistent memory path is:

```text
VOICE ENGINE/data/translation_memory/approved_corrections.jsonl
```

When the package is installed outside this repository and that folder is not available, the fallback path is:

```text
~/.voice_engine/translation_memory/approved_corrections.jsonl
```

Override the path with:

```bash
export VOICE_ENGINE_TRANSLATION_MEMORY_PATH="/absolute/path/approved_corrections.jsonl"
```

Enable the Pinecone vector mirror with:

```bash
export VOICE_ENGINE_PINECONE_API_KEY="..."
export VOICE_ENGINE_PINECONE_INDEX="voice-engine-memory"
# Optional if targeting a specific index host:
export VOICE_ENGINE_PINECONE_HOST="..."
export VOICE_ENGINE_PINECONE_NAMESPACE="voice-engine-translation-memory"
```

The package install metadata includes Pinecone:

```bash
python3 -m pip install -e "VOICE ENGINE"
```

This installs `pinecone[grpc]` with the package. If Pinecone credentials are not configured, VOICE ENGINE still uses its persistent local memory and local vector retrieval.

## Automatic Feedback Model

VOICE ENGINE includes its own Groq translation engine plus a feedback model that runs after translation and before TTS. This replaces the manual in-room Correct button flow for normal meeting use.

Runtime behavior:

- Check approved translation memory first.
- Run deterministic safety checks for copied source text, empty output, missing numbers, and low confidence.
- Optionally call a fast correction provider supplied by the host application.
- Use the built-in `GroqTranslationReviewer` when `VOICE_ENGINE_GROQ_API_KEY` or `GROQ_API_KEY` is configured.
- Replace the translation before synthesis when the provider returns a higher-confidence correction.
- Save accepted corrections back to translation memory.
- Append correction examples to the training dataset.

Default training dataset path:

```text
VOICE ENGINE/data/training/feedback_corrections.jsonl
```

Installed-package fallback:

```text
~/.voice_engine/training/feedback_corrections.jsonl
```

Override with:

```bash
export VOICE_ENGINE_TRAINING_DATASET_PATH="/absolute/path/feedback_corrections.jsonl"
```

The package-level APIs are `GroqTranslationEngine`, `GroqTranslationReviewer`, and `TranslationFeedbackModel`. Apps may pass custom engines into `VoiceEngineOrchestrator`, but they do not have to. By default, VOICE ENGINE creates its own Groq translator and reviewer from environment variables when available:

```bash
export VOICE_ENGINE_GROQ_API_KEY="..."
export VOICE_ENGINE_TRANSLATION_MODEL="llama-3.3-70b-versatile"
export VOICE_ENGINE_REVIEW_MODEL="llama-3.1-8b-instant"
export VOICE_ENGINE_CORRECTION_MODEL="llama-3.3-70b-versatile"
```

If `VOICE_ENGINE_GROQ_API_KEY` is not set, `GROQ_API_KEY` is used. If neither exists, VOICE ENGINE still runs memory and deterministic feedback checks, but it cannot call the built-in Groq translator/reviewer and falls back to deterministic placeholder translation.

VOICE ENGINE owns translation generation, review, correction generation, persistence, and the training-data path. Host apps only configure credentials and call the orchestrator.

The package-local agent modules are:

```text
voice_engine/agents/translation_agent.py
voice_engine/agents/quality_review_agent.py
```

`GroqTranslationEngine` uses the package translation agent. `GroqTranslationReviewer` uses the package quality-review agent and the package translation agent for correction generation. These agents do not import backend app modules.

## Production Rule

The phone clients must send mic audio only and receive synthesized translated audio only. Raw participant audio must never be routed to the opposite participant.
