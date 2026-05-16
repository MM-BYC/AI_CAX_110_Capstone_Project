import math
import struct


def pcm16_rms(pcm16: bytes) -> float:
    if not pcm16:
        return 0.0
    sample_count = len(pcm16) // 2
    if sample_count == 0:
        return 0.0
    total = 0.0
    for (sample,) in struct.iter_unpack("<h", pcm16[: sample_count * 2]):
        normalized = sample / 32768.0
        total += normalized * normalized
    return math.sqrt(total / sample_count)


def synth_sine_pcm16(frequency_hz: float, duration_ms: int, sample_rate_hz: int, gain: float = 0.12) -> bytes:
    sample_count = int(sample_rate_hz * duration_ms / 1000)
    frames = bytearray()
    for index in range(sample_count):
        value = math.sin(2 * math.pi * frequency_hz * index / sample_rate_hz)
        sample = int(max(-1.0, min(1.0, value * gain)) * 32767)
        frames.extend(struct.pack("<h", sample))
    return bytes(frames)
