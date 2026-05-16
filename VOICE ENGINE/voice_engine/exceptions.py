class VoiceEngineError(Exception):
    """Base exception for VOICE ENGINE failures."""


class GuardRejectedOutput(VoiceEngineError):
    """Raised when output is blocked by anti-hallucination guardrails."""


class RawAudioPassthroughBlocked(VoiceEngineError):
    """Raised if a caller's raw audio is accidentally routed to the peer."""
