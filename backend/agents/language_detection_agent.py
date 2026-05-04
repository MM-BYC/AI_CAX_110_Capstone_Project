"""Language Detection Agent — identifies source language, constrained to the 16 supported languages."""
from lingua import Language, LanguageDetectorBuilder

# The 16 languages the app supports
_SUPPORTED: dict[str, Language] = {
    "en": Language.ENGLISH,
    "es": Language.SPANISH,
    "fr": Language.FRENCH,
    "de": Language.GERMAN,
    "it": Language.ITALIAN,
    "pt": Language.PORTUGUESE,
    "zh": Language.CHINESE,
    "ja": Language.JAPANESE,
    "ko": Language.KOREAN,
    "ar": Language.ARABIC,
    "ru": Language.RUSSIAN,
    "hi": Language.HINDI,
    "nl": Language.DUTCH,
    "pl": Language.POLISH,
    "tr": Language.TURKISH,
    "tl": Language.TAGALOG,
}

_CODE_FOR: dict[Language, str] = {v: k for k, v in _SUPPORTED.items()}

# Detector scoped to only the 16 supported languages — cannot return "so", "af", etc.
_detector = LanguageDetectorBuilder.from_languages(*_SUPPORTED.values()).build()

# Reject detection if the top result is below this confidence (0–1 scale)
# With 16 languages sharing probability mass, top scores are naturally lower than
# a full-corpus detector (0.4–0.6 is typical). 0.15 rejects near-uniform noise
# while accepting clear signals.
_MIN_CONFIDENCE = 0.15
# Very short strings produce unreliable signals
_MIN_LENGTH = 4


def run(text: str) -> str:
    """Return the ISO 639-1 code of the detected language, or 'en' as fallback."""
    stripped = (text or "").strip()
    if len(stripped) < _MIN_LENGTH:
        return "en"

    results = _detector.compute_language_confidence_values(stripped)
    if not results or results[0].value < _MIN_CONFIDENCE:
        return "en"

    return _CODE_FOR.get(results[0].language, "en")
