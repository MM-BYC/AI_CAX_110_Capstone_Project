import os
from groq import Groq
from dotenv import load_dotenv

load_dotenv()

client = Groq(api_key=os.environ.get("GROQ_API_KEY"))

LANG_NAMES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German",
    "it": "Italian", "pt": "Portuguese", "zh": "Chinese", "ja": "Japanese",
    "ko": "Korean", "ar": "Arabic", "ru": "Russian", "hi": "Hindi",
    "nl": "Dutch", "pl": "Polish", "tr": "Turkish", "tl": "Tagalog",
}


def translate(text: str, source: str, target: str) -> str:
    """Translate text from source language to target language using Groq."""
    source_name = LANG_NAMES.get(source, source)
    target_name = LANG_NAMES.get(target, target)
    prompt = f"""Translate the following text from {source_name} to {target_name}.
Return only the translated text with no additional commentary.

Text:
{text}"""

    response = client.chat.completions.create(
        model=os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile"),
        messages=[
            {"role": "user", "content": prompt}
        ]
    )

    return response.choices[0].message.content
