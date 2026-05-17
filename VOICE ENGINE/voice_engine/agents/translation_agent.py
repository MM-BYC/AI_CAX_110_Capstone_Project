from __future__ import annotations

from .groq_client import GroqClientFactory
from .languages import LANG_NAMES


_FEW_SHOT: dict[tuple[str, str], list[tuple[str, str]]] = {
    ("tl", "en"): [
        ("Ano ang umaga sa iyo?", "What is morning to you?"),
        ("Kailan ka papasyal?", "When will you visit?"),
        ("Magkano ang pamasahe?", "How much is the fare?"),
        ("Saan ka pupunta?", "Where are you going?"),
    ],
    ("en", "tl"): [
        ("What is morning to you?", "Ano ang umaga sa iyo?"),
        ("When will you visit?", "Kailan ka papasyal?"),
        ("How much is the fare?", "Magkano ang pamasahe?"),
        ("Where are you going?", "Saan ka pupunta?"),
    ],
}


class VoiceEngineGroqTranslationAgent:
    """VOICE ENGINE package-local translation and correction agent."""

    def __init__(self, api_key: str, model: str):
        self.model = model
        self._client_factory = GroqClientFactory(api_key)

    def translate(self, text: str, source_language: str, target_language: str) -> str:
        source_name = LANG_NAMES.get(source_language, source_language)
        target_name = LANG_NAMES.get(target_language, target_language)
        prompt_parts = [
            "You are the translation agent inside a realtime voice engine.",
            f"Translate from {source_name} to {target_name}.",
            "Preserve meaning exactly. Do not add, remove, summarize, explain, or conversationally reinterpret.",
            "If the source is literal or awkward, keep the target faithful instead of replacing it with an idiom.",
            "Output only the translated text.",
        ]
        few_shot = self._few_shot_block(source_language, target_language)
        if few_shot:
            prompt_parts.extend(["", few_shot])
        prompt_parts.extend(["", f"Source: {text}", "Translation:"])
        return self._complete("\n".join(prompt_parts), max_tokens=180)

    def correct(
        self,
        source_text: str,
        bad_translation: str,
        critique: str,
        source_language: str,
        target_language: str,
    ) -> str:
        source_name = LANG_NAMES.get(source_language, source_language)
        target_name = LANG_NAMES.get(target_language, target_language)
        prompt = (
            "You are the correction agent inside a realtime voice engine.\n"
            f"Translate the original {source_name} text into {target_name} faithfully.\n"
            "Preserve meaning. Do not add, remove, summarize, or explain. Output only the corrected translation.\n"
            f"Original: {source_text}\n"
            f"Bad translation: {bad_translation}\n"
            f"Reviewer critique: {critique}\n"
            "Corrected translation:"
        )
        return self._complete(prompt, max_tokens=180)

    def _complete(self, prompt: str, max_tokens: int) -> str:
        response = self._client_factory.client().chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            max_tokens=max_tokens,
        )
        return response.choices[0].message.content.strip().strip('"')

    def _few_shot_block(self, source_language: str, target_language: str) -> str:
        pairs = _FEW_SHOT.get((source_language, target_language))
        if not pairs:
            return ""
        lines = ["Reference translations:"]
        for source, target in pairs:
            lines.append(f'  - "{source}" -> "{target}"')
        return "\n".join(lines)
