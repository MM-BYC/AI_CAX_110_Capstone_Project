"""Quality Review Agent — checks translation accuracy and flags hallucinations."""
import os
import logging
from groq import Groq

logger = logging.getLogger(__name__)

_client = None


def _get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY environment variable is not set")
        _client = Groq(api_key=api_key)
    return _client


LANG_NAMES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German",
    "it": "Italian", "pt": "Portuguese", "zh": "Chinese", "ja": "Japanese",
    "ko": "Korean", "ar": "Arabic", "ru": "Russian", "hi": "Hindi",
    "nl": "Dutch", "pl": "Polish", "tr": "Turkish", "tl": "Tagalog",
}


def run(original: str, translation: str, source: str, target: str) -> dict:
    source_name = LANG_NAMES.get(source, source)
    target_name = LANG_NAMES.get(target, target)

    # Tight prompt + small/fast model so the review adds ~80-150 ms instead
    # of the 300-500 ms a 70B call costs. The smaller model is plenty good
    # for binary PASS/FAIL with a short critique.
    prompt = (
        f"Review {source_name}→{target_name} translation for hallucinations, "
        f"omissions, mistranslations.\n"
        f"Original: {original}\n"
        f"Translation: {translation}\n"
        f"Reply only: PASS or FAIL: <brief critique>"
    )

    response = _get_client().chat.completions.create(
        model=os.environ.get("GROQ_REVIEW_MODEL", "llama-3.1-8b-instant"),
        messages=[{"role": "user", "content": prompt}],
        temperature=0,
        max_tokens=80,
    )
    verdict = response.choices[0].message.content.strip()

    if verdict.upper().startswith("PASS"):
        return {"passed": True, "critique": ""}

    critique = verdict.replace("FAIL:", "").strip()
    return {"passed": False, "critique": critique}
