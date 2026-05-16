from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from voice_engine.text import normalize_tagalog_for_tts


@dataclass(frozen=True)
class NeuralTTSResult:
    wav_path: Path
    method: str
    audio_bytes: int
    warning: str | None = None


class VoiceEngineNeuralTTSPlatform:
    """VOICE ENGINE speech synthesis platform boundary.

    Production target:
      1. Local neural TTS model.
      2. Tagalog text frontend.
      3. WAV generation from the VOICE ENGINE API.
      4. Speaker-profile conditioning for voice clone.

    Current implementation provides that API and uses the best available local
    or vendored backend. gTTS is supported only as an audible demo fallback when
    a local Tagalog neural model is not installed yet.
    """

    def __init__(self, base_dir: Path, vendor_dir: Path | None = None):
        self.base_dir = base_dir
        self.vendor_dir = vendor_dir
        if vendor_dir and vendor_dir.exists():
            vendor_str = str(vendor_dir)
            if vendor_str not in sys.path:
                sys.path.insert(0, vendor_str)

    def synthesize_to_wav(
        self,
        text: str,
        language_code: str,
        output_wav: Path,
        speaker_profile_id: str | None = None,
    ) -> NeuralTTSResult:
        output_wav.parent.mkdir(parents=True, exist_ok=True)
        normalized = self._normalize(text, language_code)

        result = self._try_gtts(normalized, language_code, output_wav)
        if result:
            return result

        result = self._try_macos_pyttsx3(normalized, output_wav)
        if result:
            return result

        self._fallback_tone(output_wav)
        return NeuralTTSResult(
            wav_path=output_wav,
            method="fallback_tone",
            audio_bytes=self.audio_bytes(output_wav),
            warning="No speech backend produced valid audio; generated audible tone fallback.",
        )

    def play(self, wav_path: Path) -> str:
        try:
            subprocess.run(["afplay", str(wav_path)], check=True)
            return "afplay"
        except Exception:
            subprocess.run(["open", str(wav_path)], check=False)
            return "open"

    def _normalize(self, text: str, language_code: str) -> str:
        if language_code.lower() in {"tl", "fil", "tagalog", "filipino"}:
            return normalize_tagalog_for_tts(text)
        return re.sub(r"\s+", " ", text).strip()

    def _try_gtts(self, text: str, language_code: str, output_wav: Path) -> NeuralTTSResult | None:
        mp3_path = output_wav.with_suffix(".mp3")
        try:
            from gtts import gTTS

            if mp3_path.exists():
                mp3_path.unlink()
            gTTS(text=text, lang=self._gtts_language(language_code)).save(str(mp3_path))
            self._mp3_to_wav(mp3_path, output_wav)
            audio_bytes = self.audio_bytes(output_wav)
            if audio_bytes > 0:
                mp3_path.unlink(missing_ok=True)
                return NeuralTTSResult(
                    wav_path=output_wav,
                    method="voice_engine_platform:gtts_demo_backend",
                    audio_bytes=audio_bytes,
                    warning=(
                        "gTTS is used only for the audible demo because no local "
                        "Tagalog neural voice model is installed yet."
                    ),
                )
        except Exception:
            return None
        return None

    def _try_macos_pyttsx3(self, text: str, output_wav: Path) -> NeuralTTSResult | None:
        aiff_path = output_wav.with_suffix(".aiff")
        try:
            import pyttsx3

            if aiff_path.exists():
                aiff_path.unlink()
            engine = pyttsx3.init()
            engine.setProperty("rate", 150)
            engine.setProperty("volume", 1.0)
            engine.save_to_file(text, str(aiff_path))
            engine.runAndWait()
            if self.audio_bytes(aiff_path) <= 0:
                return None
            self._aiff_to_wav(aiff_path, output_wav)
            audio_bytes = self.audio_bytes(output_wav)
            if audio_bytes > 0:
                aiff_path.unlink(missing_ok=True)
                return NeuralTTSResult(
                    wav_path=output_wav,
                    method="voice_engine_platform:pyttsx3_local_backend",
                    audio_bytes=audio_bytes,
                    warning="macOS local speech backend is not a trained Tagalog neural voice.",
                )
        except Exception:
            return None
        return None

    def _fallback_tone(self, output_wav: Path) -> None:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=523.25:duration=1.4:sample_rate=44100",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=659.25:duration=1.4:sample_rate=44100",
                "-filter_complex",
                "[0:a][1:a]concat=n=2:v=0:a=1[a]",
                "-map",
                "[a]",
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(output_wav),
            ],
            check=True,
        )

    def _mp3_to_wav(self, mp3_path: Path, wav_path: Path) -> None:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(mp3_path),
                "-ac",
                "1",
                "-ar",
                "44100",
                "-c:a",
                "pcm_s16le",
                str(wav_path),
            ],
            check=True,
        )

    def _aiff_to_wav(self, aiff_path: Path, wav_path: Path) -> None:
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", str(aiff_path), str(wav_path)], check=True)

    def audio_bytes(self, path: Path) -> int:
        if not path.exists():
            return 0
        try:
            info = subprocess.run(["afinfo", str(path)], check=True, text=True, capture_output=True).stdout
        except Exception:
            return path.stat().st_size
        match = re.search(r"audio bytes:\s+(\d+)", info)
        return int(match.group(1)) if match else 0

    def _gtts_language(self, language_code: str) -> str:
        if language_code.lower() in {"tagalog", "filipino", "fil"}:
            return "tl"
        return language_code.lower()
