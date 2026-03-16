import os
from groq import Groq
from dotenv import load_dotenv

load_dotenv()

client = Groq(api_key=os.environ.get("GROQ_API_KEY"))


def translate(text: str, source: str, target: str) -> str:
    """Translate text from source language to target language using Groq."""
    prompt = f"""Translate the following text from {source} to {target}.
Return only the translated text with no additional commentary.

Text:
{text}"""

    response = client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[
            {"role": "user", "content": prompt}
        ]
    )

    return response.choices[0].message.content
