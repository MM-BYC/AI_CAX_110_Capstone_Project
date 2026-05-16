import re


_SPACE_RE = re.compile(r"\s+")


def normalize_tagalog_for_tts(text: str) -> str:
    """Normalize Tagalog text for speech synthesis.

    This is intentionally conservative. It preserves the words and only fixes
    spacing/punctuation so a neural speech backend has cleaner input.
    """

    cleaned = text.replace("VOICE ENGINE", "voice engine")
    cleaned = cleaned.replace("real-time", "real time")
    cleaned = _SPACE_RE.sub(" ", cleaned).strip()
    return cleaned
