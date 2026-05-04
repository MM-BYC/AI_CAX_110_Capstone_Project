"""Conversation Agent — cleans live speech/keyboard input before translation.

Strips common English filler words and normalises whitespace so the
Translation Agent receives clean, unambiguous text, which directly reduces
hallucination risk.  For non-English input the agent only normalises
whitespace; filler-word removal is English-specific.
"""
import re

_ENGLISH_FILLERS = re.compile(
    r"\b(um+|uh+|er+|ah+|hmm+|like|you know|i mean|basically|literally|actually|"
    r"sort of|kind of|right\?|okay so|so um|well um)\b",
    re.IGNORECASE,
)


def run(text: str, source_lang: str = "en") -> str:
    """Return a cleaned version of the input ready for translation."""
    text = text.strip()
    if source_lang == "en":
        text = _ENGLISH_FILLERS.sub("", text)
    # Collapse runs of whitespace / punctuation left by filler removal
    text = re.sub(r" {2,}", " ", text)
    text = re.sub(r"\s+([,.!?])", r"\1", text)
    return text.strip()
