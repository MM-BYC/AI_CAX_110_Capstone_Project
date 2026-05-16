from voice_engine.models import AudioFrame, VoiceProfile


class SpeakerEmbeddingEngine:
    """Call-scoped speaker profile builder.

    This starter implementation derives a deterministic placeholder embedding.
    Production replaces this with a trained local speaker encoder.
    """

    def __init__(self):
        self._profiles: dict[str, VoiceProfile] = {}

    def enroll_or_update(self, participant_id: str, frame: AudioFrame) -> VoiceProfile:
        seed = sum(frame.pcm16[:128]) % 997 if frame.pcm16 else len(participant_id)
        embedding = tuple(((seed + i * 37) % 100) / 100.0 for i in range(8))
        profile = VoiceProfile(
            participant_id=participant_id,
            profile_id=f"call-scoped:{participant_id}",
            embedding=embedding,
            ready=True,
        )
        self._profiles[participant_id] = profile
        return profile

    def get(self, participant_id: str) -> VoiceProfile:
        return self._profiles.get(
            participant_id,
            VoiceProfile(participant_id=participant_id, profile_id=f"generic:{participant_id}"),
        )
