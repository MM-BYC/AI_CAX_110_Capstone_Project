from collections import deque

from voice_engine.models import AudioFrame


class JitterBuffer:
    def __init__(self, target_ms: int):
        self.target_ms = target_ms
        self._frames: deque[AudioFrame] = deque()
        self._duration_ms = 0

    def push(self, frame: AudioFrame) -> None:
        self._frames.append(frame)
        self._duration_ms += frame.duration_ms

    def ready(self) -> bool:
        return self._duration_ms >= self.target_ms

    def pop(self) -> AudioFrame | None:
        if not self._frames:
            return None
        frame = self._frames.popleft()
        self._duration_ms = max(0, self._duration_ms - frame.duration_ms)
        return frame

    def clear(self) -> None:
        self._frames.clear()
        self._duration_ms = 0
