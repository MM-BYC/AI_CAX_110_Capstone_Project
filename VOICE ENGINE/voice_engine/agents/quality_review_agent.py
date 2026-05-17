from __future__ import annotations

from .groq_client import GroqClientFactory
from .languages import LANG_NAMES


class VoiceEngineGroqQualityReviewAgent:
    """VOICE ENGINE package-local quality reviewer for translation candidates."""

    def __init__(self, api_key: str, model: str):
        self.model = model
        self._client_factory = GroqClientFactory(api_key)

    def review(
        self,
        original: str,
        translation: str,
        source_language: str,
        target_language: str,
        reason: str = "",
    ) -> dict:
        source_name = LANG_NAMES.get(source_language, source_language)
        target_name = LANG_NAMES.get(target_language, target_language)
        prompt = (
            f"Review this {source_name} to {target_name} translation for hallucinations, "
            "omissions, mistranslations, idiom overreach, and invented meaning.\n"
            "Do not reward natural-sounding paraphrases if they change meaning.\n"
            f"Initial concern: {reason or 'provider translation review'}\n"
            f"Original: {original}\n"
            f"Translation: {translation}\n"
            "Reply only: PASS or FAIL: <brief critique>"
        )
        response = self._client_factory.client().chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            max_tokens=90,
        )
        verdict = response.choices[0].message.content.strip()
        if verdict.upper().startswith("PASS"):
            return {"passed": True, "critique": ""}
        return {"passed": False, "critique": verdict.replace("FAIL:", "").strip()}
