from voice_engine.audio.frames import pcm16_rms
from voice_engine.models import AudioFrame


class EnergyVAD:
    """Small starter VAD based on PCM RMS energy.

    This is deterministic and local. Production should replace or augment it
    with a trained neural VAD or WebRTC audio processing.
    """

    def __init__(self, speech_rms_threshold: float = 0.012):
        self.speech_rms_threshold = speech_rms_threshold

    def is_speech(self, frame: AudioFrame) -> bool:
        if frame.metadata.get("debug_text"):
            return True
        return pcm16_rms(frame.pcm16) >= self.speech_rms_threshold
