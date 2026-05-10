"""Voice Clone — standalone cross-lingual voice cloning module.

Self-contained Python module that:

  1. Analyses a reference speaker's voice attributes (pitch contour, jitter,
     shimmer, formants, speech rate) using librosa — pure DSP, no ML.
  2. Clones the speaker's voice using Coqui XTTS-v2 (open-source, on-device,
     17 languages).  Cloning is performed by the model from a 5-15 s reference
     clip; the analysis features are NOT used to drive synthesis (XTTS does
     that internally) — they are exposed for diagnostics and per-speaker
     telemetry.
  3. Synthesises translated text in the cloned voice in any of the languages
     XTTS supports while preserving the original speaker's tone, pitch, and
     rhythm.

Public API (importable as a library):

    import voice_clone
    voice_clone.is_available()                # bool — model loadable?
    voice_clone.analyze_voice(path)           # dict of acoustic features
    voice_clone.enroll(audio_bytes, user_id)  # str — saved reference path
    voice_clone.has_enrollment(user_id)       # bool
    voice_clone.synthesize(text, language, reference_path)  # bytes (WAV)
    voice_clone.synthesize_for_user(text, language, user_id) # bytes (WAV)
    voice_clone.SUPPORTED_LANGUAGES           # frozenset of lang codes

CLI (for ad-hoc testing without the full app):

    python voice_clone.py analyze  --audio sample.wav
    python voice_clone.py enroll   --audio sample.wav --user alice
    python voice_clone.py speak    --text "Hola mundo" --lang es --user alice --out alice_es.wav

Environment variables:

    VOICE_CLONE_ENABLED   "1" to enable (default), "0" to force off.
    VOICE_CLONE_MODEL     XTTS model id (default tts_models/multilingual/multi-dataset/xtts_v2).
    VOICE_CLONE_REF_DIR   Directory for reference WAVs (default /tmp/voice_refs).
    COQUI_TOS_AGREED      "1" to auto-accept the Coqui XTTS-v2 model license
                          on first download (CPML / non-commercial).

Deployment notes:

  • Requires `coqui-tts`, `torch`, `librosa`, `soundfile`, `numpy`.
    Install via: pip install -r requirements-voice.txt
  • XTTS-v2 model is ~1.8 GB on disk and needs ~3 GB RAM at runtime.
  • Render free tier (512 MB) cannot run this — set VOICE_CLONE_ENABLED=0.
    The app will gracefully fall back to the browser's Web Speech API.
  • CPU-only inference is ~3-6 s per sentence; GPU is ~0.3-0.6 s.
"""
from __future__ import annotations

import logging
import os
import tempfile
import wave
from pathlib import Path
from threading import Lock
from typing import Optional

logger = logging.getLogger(__name__)

# ── Configuration ─────────────────────────────────────────────────────────────
_ENABLED       = os.environ.get("VOICE_CLONE_ENABLED", "1") not in ("0", "false", "False", "")
_MODEL_NAME    = os.environ.get("VOICE_CLONE_MODEL",
                                "tts_models/multilingual/multi-dataset/xtts_v2")
_REF_DIR       = Path(os.environ.get("VOICE_CLONE_REF_DIR", "/tmp/voice_refs"))
_TOS_AGREED    = os.environ.get("COQUI_TOS_AGREED", "1") not in ("0", "false", "False", "")

# Languages supported by XTTS-v2 (codes XTTS uses internally)
SUPPORTED_LANGUAGES = frozenset({
    "en", "es", "fr", "de", "it", "pt", "pl", "tr", "ru", "nl",
    "cs", "ar", "zh-cn", "ja", "hu", "ko", "hi",
})

# Map this app's ISO-639-1 language codes → XTTS-v2 codes
_LANG_MAP = {
    "zh": "zh-cn",
    # All others match 1:1 (en, es, fr, de, it, pt, ru, ja, ko, ar, hi, nl, pl, tr).
    # Tagalog ('tl') is not supported by XTTS — caller falls back to browser TTS.
}

_model = None
_model_lock = Lock()
_synth_lock = Lock()
_load_error: Optional[Exception] = None


# ── Model bootstrap ───────────────────────────────────────────────────────────

def is_available() -> bool:
    """True iff the cloning model can actually be loaded right now."""
    if not _ENABLED:
        return False
    return _try_load() is not None


def _try_load():
    """Lazy-load the XTTS model. Returns the model instance or None."""
    global _model, _load_error
    if _model is not None:
        return _model
    if _load_error is not None:
        return None
    with _model_lock:
        if _model is not None:
            return _model
        if _load_error is not None:
            return None
        try:
            if _TOS_AGREED:
                # Coqui's TTS package prompts on stdin for license agreement
                # the first time XTTS-v2 is downloaded.  We auto-accept here
                # so server-side code never blocks waiting for input.
                os.environ.setdefault("COQUI_TOS_AGREED", "1")
            from TTS.api import TTS  # heavy import — only here  # noqa: WPS433
            logger.info("Loading XTTS-v2 (first run downloads ~1.8 GB)…")
            _model = TTS(model_name=_MODEL_NAME, progress_bar=False)
            logger.info("XTTS-v2 ready")
            return _model
        except Exception as e:
            _load_error = e
            logger.warning("Voice clone unavailable (%s) — caller should fall back.", e)
            return None


# ── Reference voice management ────────────────────────────────────────────────

def _ref_path(user_id: str) -> Path:
    _REF_DIR.mkdir(parents=True, exist_ok=True)
    safe = "".join(c for c in user_id if c.isalnum() or c in "_-") or "default"
    return _REF_DIR / f"{safe}.wav"


def enroll(audio_bytes: bytes, user_id: str) -> str:
    """Persist a reference voice sample for *user_id*.

    The bytes are written verbatim — caller is responsible for ensuring the
    file is a mono PCM WAV at 16-24 kHz, 5-15 seconds long.  The frontend
    recorder produces this format via MediaRecorder + a WebM-to-WAV decode
    on upload.
    """
    if not audio_bytes:
        raise ValueError("audio_bytes is empty")
    path = _ref_path(user_id)
    path.write_bytes(audio_bytes)
    logger.info("Enrolled voice reference for %s (%.1f KB)", user_id, len(audio_bytes) / 1024)
    return str(path)


def has_enrollment(user_id: str) -> bool:
    return _ref_path(user_id).exists()


def remove_enrollment(user_id: str) -> bool:
    p = _ref_path(user_id)
    if p.exists():
        p.unlink()
        return True
    return False


# ── Voice analysis (diagnostic) ───────────────────────────────────────────────

def analyze_voice(audio_path: str) -> dict:
    """Extract acoustic attributes of a reference clip.

    Returns a JSON-friendly dict with:
      duration_s        Length of the clip.
      pitch_mean_hz     Mean F0 over voiced frames (~120 Hz male, ~210 Hz female).
      pitch_std_hz      Pitch variability — wide range = expressive speaker.
      pitch_range_hz    [min, max] over voiced frames.
      jitter            Mean cycle-to-cycle pitch deviation (Hz).
      shimmer           Mean cycle-to-cycle amplitude deviation (RMS units).
      hnr_db            Harmonics-to-noise ratio (higher = clearer voice).
      speech_rate_sps   Estimated syllables per second (energy peaks / s).
      voiced_ratio      Fraction of frames classified as voiced.
      formants_hz       Approximate F1/F2/F3 from the LPC envelope.
    """
    try:
        import librosa  # noqa: WPS433
        import numpy as np  # noqa: WPS433
    except ImportError as e:
        return {"error": f"librosa not installed: {e}"}

    try:
        y, sr = librosa.load(audio_path, sr=None, mono=True)
    except Exception as e:
        return {"error": f"could not read audio: {e}"}

    if y.size == 0:
        return {"error": "empty audio"}

    # ── Pitch (F0) via probabilistic YIN ──
    f0, voiced_flag, _ = librosa.pyin(y, fmin=70, fmax=400, sr=sr)
    voiced = f0[~np.isnan(f0)] if f0 is not None else np.array([])

    pitch_mean = float(np.mean(voiced)) if voiced.size else 0.0
    pitch_std  = float(np.std(voiced))  if voiced.size else 0.0
    pitch_min  = float(np.min(voiced))  if voiced.size else 0.0
    pitch_max  = float(np.max(voiced))  if voiced.size else 0.0

    # ── Jitter (pitch perturbation) ──
    jitter = float(np.mean(np.abs(np.diff(voiced)))) if voiced.size > 1 else 0.0

    # ── Shimmer (amplitude perturbation) via per-frame RMS ──
    rms = librosa.feature.rms(y=y)[0]
    shimmer = float(np.mean(np.abs(np.diff(rms)))) if rms.size > 1 else 0.0

    # ── Harmonics-to-Noise Ratio ──
    try:
        harm, perc = librosa.effects.hpss(y)
        h_pow = float(np.mean(harm ** 2)) + 1e-12
        n_pow = float(np.mean(perc ** 2)) + 1e-12
        hnr_db = float(10.0 * np.log10(h_pow / n_pow))
    except Exception:
        hnr_db = 0.0

    # ── Speech rate proxy (syllabic energy peaks / second) ──
    try:
        env = librosa.onset.onset_strength(y=y, sr=sr)
        peaks = librosa.util.peak_pick(env, pre_max=3, post_max=3,
                                        pre_avg=3, post_avg=5,
                                        delta=0.5, wait=2)
        duration = max(1e-3, len(y) / sr)
        speech_rate = float(len(peaks) / duration)
    except Exception:
        speech_rate = 0.0

    # ── Approximate formants from LPC envelope on a single voiced frame ──
    formants = _estimate_formants(y, sr)

    voiced_ratio = float(voiced.size / max(1, len(f0))) if f0 is not None else 0.0

    return {
        "duration_s":      round(float(len(y) / sr), 2),
        "sample_rate_hz":  int(sr),
        "pitch_mean_hz":   round(pitch_mean, 1),
        "pitch_std_hz":    round(pitch_std, 1),
        "pitch_range_hz":  [round(pitch_min, 1), round(pitch_max, 1)],
        "jitter":          round(jitter, 4),
        "shimmer":         round(shimmer, 5),
        "hnr_db":          round(hnr_db, 2),
        "speech_rate_sps": round(speech_rate, 2),
        "voiced_ratio":    round(voiced_ratio, 3),
        "formants_hz":     formants,
    }


def _estimate_formants(y, sr) -> list[float]:
    """Cheap formant estimate from LPC roots over the full clip."""
    try:
        import numpy as np  # noqa: WPS433
        from scipy.signal import lfilter  # noqa: WPS433
    except ImportError:
        return []
    try:
        # Pre-emphasise and window
        emphasised = lfilter([1.0, -0.97], 1, y)
        order = 2 + int(sr / 1000)
        # Autocorrelation LPC
        r = np.correlate(emphasised, emphasised, mode="full")
        r = r[len(r) // 2:]
        if r[0] == 0 or order >= len(r):
            return []
        R = np.zeros((order, order))
        for i in range(order):
            for j in range(order):
                R[i, j] = r[abs(i - j)]
        try:
            a = np.linalg.solve(R, -r[1:order + 1])
        except np.linalg.LinAlgError:
            return []
        coeffs = np.concatenate([[1.0], a])
        roots = np.roots(coeffs)
        roots = roots[np.imag(roots) >= 0]
        angles = np.arctan2(np.imag(roots), np.real(roots))
        freqs = sorted(angles * (sr / (2 * np.pi)))
        formants = [round(f, 1) for f in freqs if 90 < f < 5000]
        return formants[:3]
    except Exception:
        return []


# ── Synthesis ─────────────────────────────────────────────────────────────────

def synthesize(text: str, language: str, reference_path: str) -> bytes:
    """Generate WAV bytes of *text* spoken in *language* using *reference_path*.

    Raises:
      RuntimeError   if the model can't load (caller should fall back to TTS).
      ValueError     if *language* isn't supported by the model.
      FileNotFoundError if the reference clip is missing.
    """
    if not text or not text.strip():
        return b""

    model = _try_load()
    if model is None:
        raise RuntimeError(f"Voice clone unavailable: {_load_error}")

    if not Path(reference_path).exists():
        raise FileNotFoundError(reference_path)

    xtts_lang = _LANG_MAP.get(language, language)
    if xtts_lang not in SUPPORTED_LANGUAGES:
        raise ValueError(f"Language {language!r} not supported by XTTS-v2")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out_path = tmp.name
    try:
        with _synth_lock:
            model.tts_to_file(
                text=text.strip(),
                speaker_wav=reference_path,
                language=xtts_lang,
                file_path=out_path,
            )
        return Path(out_path).read_bytes()
    finally:
        try:
            Path(out_path).unlink()
        except FileNotFoundError:
            pass


def synthesize_for_user(text: str, language: str, user_id: str) -> bytes:
    """Convenience: look up the reference clip by user_id and synthesise."""
    ref = _ref_path(user_id)
    if not ref.exists():
        raise FileNotFoundError(f"No enrolled reference for user {user_id!r}")
    return synthesize(text, language, str(ref))


# ── Sanity helper ─────────────────────────────────────────────────────────────

def reference_is_valid_wav(path: str) -> bool:
    """Quick check that a saved reference is a readable WAV — used by the
    enrollment endpoint to fail fast on malformed uploads."""
    try:
        with wave.open(path, "rb") as wf:
            return wf.getnframes() > 0
    except Exception:
        return False


# ── CLI ───────────────────────────────────────────────────────────────────────

def _cli() -> None:
    import argparse
    import json as _json

    parser = argparse.ArgumentParser(description="Voice Clone CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_a = sub.add_parser("analyze", help="Print voice attributes for a WAV")
    p_a.add_argument("--audio", required=True)

    p_e = sub.add_parser("enroll", help="Save a reference WAV for a user")
    p_e.add_argument("--audio", required=True)
    p_e.add_argument("--user", required=True)

    p_s = sub.add_parser("speak", help="Synthesise cloned speech to a WAV")
    p_s.add_argument("--text", required=True)
    p_s.add_argument("--lang", required=True)
    p_s.add_argument("--user", help="Enrolled user id (alternative to --reference)")
    p_s.add_argument("--reference", help="Path to reference WAV")
    p_s.add_argument("--out", required=True)

    p_status = sub.add_parser("status", help="Check whether the model is loadable")

    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    if args.cmd == "analyze":
        print(_json.dumps(analyze_voice(args.audio), indent=2))
    elif args.cmd == "enroll":
        path = enroll(Path(args.audio).read_bytes(), args.user)
        print(f"Enrolled at {path}")
    elif args.cmd == "speak":
        if args.user:
            wav = synthesize_for_user(args.text, args.lang, args.user)
        elif args.reference:
            wav = synthesize(args.text, args.lang, args.reference)
        else:
            parser.error("--user or --reference is required for `speak`")
        Path(args.out).write_bytes(wav)
        print(f"Wrote {args.out} ({len(wav)} bytes)")
    elif args.cmd == "status":
        print(_json.dumps({
            "enabled":     _ENABLED,
            "available":   is_available(),
            "model":       _MODEL_NAME,
            "load_error":  str(_load_error) if _load_error else None,
            "ref_dir":     str(_REF_DIR),
        }, indent=2))


if __name__ == "__main__":
    _cli()
