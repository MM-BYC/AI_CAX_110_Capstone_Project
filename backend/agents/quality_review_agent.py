"""Quality Review Agent — checks translation accuracy and flags hallucinations."""
import os
from groq import Groq

_client = Groq(api_key=os.environ.get("GROQ_API_KEY"))

LANG_NAMES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German",
    "it": "Italian", "pt": "Portuguese", "zh": "Chinese", "ja": "Japanese",
    "ko": "Korean", "ar": "Arabic", "ru": "Russian", "hi": "Hindi",
    "nl": "Dutch", "pl": "Polish", "tr": "Turkish", "tl": "Tagalog",
}


def run(original: str, translation: str, source: str, target: str) -> dict:
    source_name = LANG_NAMES.get(source, source)
    target_name = LANG_NAMES.get(target, target)

    prompt = (
        f"You are a professional translation reviewer.\n"
        f"Review this translation from {source_name} to {target_name}.\n\n"
        f"Original: {original}\n"
        f"Translation: {translation}\n\n"
        f"Check for: hallucinations, added content, omissions, mistranslations.\n"
        f"Reply with exactly one of:\n"
        f"PASS\n"
        f"or\n"
        f"FAIL: <brief critique of what is wrong>"
    )

    response = _client.chat.completions.create(
        model=os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile"),
        messages=[{"role": "user", "content": prompt}],
    )
    verdict = response.choices[0].message.content.strip()

    if verdict.upper().startswith("PASS"):
        return {"passed": True, "critique": ""}

    critique = verdict.replace("FAIL:", "").strip()
    return {"passed": False, "critique": critique}
