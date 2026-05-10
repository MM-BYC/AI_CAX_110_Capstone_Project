"""Speaker Style Profiler — zero-latency voice preservation.

Analyzes each utterance for formality, sentence rhythm, and contraction usage,
then accumulates a running per-speaker profile stored in
room["info"][user_id]["style_profile"].

After 2+ samples the profile generates a prompt hint that tells the translation
model to preserve the speaker's exact register and rhythm rather than
normalising to a generic "translation voice".

All analysis is rule-based (regex + counters) — no LLM call, runs in < 1 ms.
"""
import re
from typing import Optional

# ── Lexical signal patterns ───────────────────────────────────────────────────

_CONTRACTIONS = re.compile(
    r"\b(i'm|you're|he's|she's|it's|we're|they're|i've|you've|we've|they've|"
    r"i'll|you'll|he'll|she'll|we'll|they'll|i'd|you'd|he'd|she'd|we'd|they'd|"
    r"can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|couldn't|"
    r"wouldn't|shouldn't|hasn't|haven't|hadn't|that's|there's|here's|what's|"
    r"who's|how's|where's|when's|why's|let's|"
    r"gonna|wanna|gotta|kinda|sorta|lemme|gimme|ya|yep|nope)\b",
    re.IGNORECASE,
)

_FORMAL_MARKERS = re.compile(
    r"\b(furthermore|henceforth|pursuant|regarding|aforementioned|"
    r"notwithstanding|accordingly|therefore|wherein|whereby|hereinafter|"
    r"as per|per our|please find|kindly note|sincerely|respectfully|"
    r"in accordance|with respect to|it is my understanding|"
    r"I would like to|I am pleased to|on behalf of)\b",
    re.IGNORECASE,
)

_INFORMAL_MARKERS = re.compile(
    r"\b(stuff|thing|kinda|sorta|yeah|yep|nope|nah|cool|awesome|great|"
    r"hey|hi there|ok so|like|literally|basically|totally|super|"
    r"you know|i mean|tbh|fyi|btw|lol|omg|no way|for real|"
    r"gonna|wanna|gotta|guys|folks)\b",
    re.IGNORECASE,
)

_SENTENCE_END = re.compile(r"[.!?]+")


# ── Core analysis ─────────────────────────────────────────────────────────────

def _formality_score(text: str) -> float:
    """Returns 0.0 (very casual) to 1.0 (very formal)."""
    words = text.split()
    if not words:
        return 0.5

    formal_hits   = len(_FORMAL_MARKERS.findall(text))
    informal_hits = len(_INFORMAL_MARKERS.findall(text))
    contraction_hits = len(_CONTRACTIONS.findall(text))

    # Average word length: longer words lean formal
    avg_word_len = sum(len(w.strip(".,!?;:\"'")) for w in words) / len(words)
    length_signal = min(1.0, max(0.0, (avg_word_len - 3.5) / 3.5))

    raw = 0.5 + 0.12 * formal_hits - 0.08 * informal_hits - 0.06 * contraction_hits + 0.08 * length_signal
    return round(min(1.0, max(0.0, raw)), 3)


def analyze(text: str) -> dict:
    """Analyze a single utterance. Returns a raw sample dict."""
    sentences = [s.strip() for s in _SENTENCE_END.split(text.strip()) if s.strip()]
    n_sentences = max(1, len(sentences))
    words = text.split()

    return {
        "formality_score":    _formality_score(text),
        "avg_sentence_words": round(len(words) / n_sentences, 1),
        "uses_contractions":  bool(_CONTRACTIONS.search(text)),
        "exclamatory":        "!" in text,
        "sample_count":       1,
    }


def accumulate(existing: Optional[dict], new_sample: dict) -> dict:
    """Merge a new sample into a running profile via exponential moving average."""
    if existing is None:
        return dict(new_sample)

    n = existing.get("sample_count", 1)
    alpha = 0.3  # weight for the new sample (EMA)

    return {
        "formality_score":    round(
            (1 - alpha) * existing["formality_score"] + alpha * new_sample["formality_score"], 3
        ),
        "avg_sentence_words": round(
            (1 - alpha) * existing["avg_sentence_words"] + alpha * new_sample["avg_sentence_words"], 1
        ),
        # Sticky: once contractions observed, keep True
        "uses_contractions":  existing["uses_contractions"] or new_sample["uses_contractions"],
        "exclamatory":        existing["exclamatory"] or new_sample["exclamatory"],
        "sample_count":       n + 1,
    }


def to_prompt_hint(profile: Optional[dict]) -> str:
    """Return a one-line style instruction for the translation prompt.

    Returns empty string until we have at least 2 samples (1 is noisy).
    """
    if not profile or profile.get("sample_count", 0) < 2:
        return ""

    score   = profile["formality_score"]
    avg_len = profile["avg_sentence_words"]
    contr   = profile["uses_contractions"]

    if score < 0.35:
        register = "casual and conversational"
    elif score < 0.60:
        register = "neutral, semi-formal"
    else:
        register = "formal and professional"

    if avg_len < 7:
        rhythm = "very short, punchy sentences"
    elif avg_len < 14:
        rhythm = "medium-length sentences"
    else:
        rhythm = "long, structured sentences"

    contraction_note = " Use contractions naturally." if contr else " Avoid contractions."

    return (
        f"Speaker voice style: {register}, {rhythm}.{contraction_note} "
        "Preserve this exact register and rhythm in the translation — "
        "do not normalise to a generic translation voice."
    )
