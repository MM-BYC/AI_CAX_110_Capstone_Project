from voice_engine.models import AudioFrame


class PassthroughDenoiser:
    """Placeholder for local denoise/echo suppression.

    Production implementation should replace this with local echo cancellation
    and noise suppression. This class intentionally does not alter audio.
    """

    def process(self, frame: AudioFrame) -> AudioFrame:
        return frame
