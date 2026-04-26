"""Translation Agent — translates text from source to target language."""
import os
from groq import Groq

_client = None

def _get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY environment variable is not set")
        try:
            _client = Groq(api_key=api_key)
        except Exception as e:
            raise RuntimeError(f"Failed to initialize Groq client: {e}")
    return _client

LANG_NAMES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German",
    "it": "Italian", "pt": "Portuguese", "zh": "Chinese", "ja": "Japanese",
    "ko": "Korean", "ar": "Arabic", "ru": "Russian", "hi": "Hindi",
    "nl": "Dutch", "pl": "Polish", "tr": "Turkish", "tl": "Tagalog",
}


def run(text: str, source: str, target: str, critique: str = "") -> str:
    client = _get_client()
    source_name = LANG_NAMES.get(source, source)
    target_name = LANG_NAMES.get(target, target)

    correction_note = (
        f"\nA previous attempt was flagged for: {critique}\nFix these issues."
        if critique else ""
    )

    prompt = (
        f"Translate the following text from {source_name} to {target_name}. "
        f"Return only the translated text with no commentary.{correction_note}\n\nText:\n{text}"
    )

    response = client.chat.completions.create(
        model=os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile"),
        messages=[{"role": "user", "content": prompt}],
    )
    return response.choices[0].message.content.strip()
