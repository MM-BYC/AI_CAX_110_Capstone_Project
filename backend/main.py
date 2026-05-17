import os
import json
import asyncio
import base64
import hmac
import queue as _queue
import random
import secrets
import string
import logging
import tempfile
import threading
import time
import hashlib
import sys
from collections import deque
from pathlib import Path
from contextlib import asynccontextmanager
from dotenv import load_dotenv

try:
    from google.cloud import speech as _google_speech
    from google.oauth2 import service_account as _gsa
    _GOOGLE_STT_AVAILABLE = True
except ImportError:
    _google_speech = None
    _gsa = None
    _GOOGLE_STT_AVAILABLE = False


def _make_speech_client():
    """Return a SpeechClient using whichever credentials are available.

    Priority:
      1. GOOGLE_CREDENTIALS_JSON env var — JSON string set in Render (or any
         host without gcloud). Accepts both 'service_account' and
         'authorized_user' types so the ADC file from
         `gcloud auth application-default login` can be pasted directly.
      2. Application Default Credentials — gcloud CLI on local dev machines.
    """
    raw = os.getenv("GOOGLE_CREDENTIALS_JSON", "").strip()
    if raw:
        info = json.loads(raw)
        cred_type = info.get("type", "")
        if cred_type == "service_account":
            creds = _gsa.Credentials.from_service_account_info(
                info,
                scopes=["https://www.googleapis.com/auth/cloud-platform"],
            )
        elif cred_type == "authorized_user":
            from google.oauth2.credentials import Credentials as _UserCreds
            creds = _UserCreds.from_authorized_user_info(info)
        else:
            raise ValueError(f"Unsupported credential type: {cred_type!r}")
        return _google_speech.SpeechClient(credentials=creds)
    # ADC path — local dev with `gcloud auth application-default login`
    return _google_speech.SpeechClient()

# ISO 639-1 → BCP-47 language tags for Google STT
_GOOGLE_LANG = {
    "en": "en-US", "es": "es-ES", "fr": "fr-FR", "de": "de-DE",
    "it": "it-IT", "pt": "pt-BR", "zh": "zh-CN", "ja": "ja-JP",
    "ko": "ko-KR", "ar": "ar-SA", "ru": "ru-RU", "hi": "hi-IN",
    "nl": "nl-NL", "pl": "pl-PL", "tr": "tr-TR", "tl": "fil-PH",
}

# Languages that support the high-accuracy `latest_long` model.
# fil-PH does not — Google rejects it with a 400.
_LATEST_LONG_LANGS = {
    "en-US", "es-ES", "fr-FR", "de-DE", "it-IT", "pt-BR",
    "zh-CN", "ja-JP", "ko-KR", "ar-SA", "ru-RU", "hi-IN",
    "nl-NL", "pl-PL", "tr-TR",
}

# Common Google STT hallucinations that show up when the mic picks up
# background noise.  Lower-cased, stripped, punctuation removed — checked
# in inject path.
_STT_HALLUCINATIONS = {
    "you", "the", "a", "an", "i", "is", "it", "to", "of",
    "mom", "mommy", "mama", "dad", "daddy", "papa",
    "yeah", "yes", "no", "okay", "ok", "uh", "um", "hmm", "huh",
    "thank you", "thanks", "bye", "goodbye", "hello", "hi",
    "are you", "are you mom", "you mom", "mom you",
    "oo", "hindi", "sige",  # very short Tagalog one-word noise hits
}


def _is_likely_hallucination(text: str) -> bool:
    """Cheap check for common Google STT hallucinations from background noise."""
    if not text:
        return True
    norm = text.strip().lower().rstrip(".!?,").strip()
    if len(norm) < 4:
        return True
    return norm in _STT_HALLUCINATIONS


# Per-room ring buffer of recently broadcast originals + translations.
# Used to suppress echo: when the iPhone mic picks up the Mac's TTS playback,
# Google STT will transcribe the translated text — we drop it.
_ECHO_WINDOW_SEC = 10.0
_recent_broadcasts: dict = {}  # room_id → deque[(monotonic_ts, normalized_text)]


def _normalize_for_echo(text: str) -> str:
    return text.strip().lower().rstrip(".!?,").strip()


def _record_broadcast(room_id: str, *texts: str) -> None:
    bucket = _recent_broadcasts.setdefault(room_id, deque(maxlen=40))
    now = time.monotonic()
    for t in texts:
        norm = _normalize_for_echo(t)
        if norm:
            bucket.append((now, norm))


def _is_echo(room_id: str, text: str) -> bool:
    bucket = _recent_broadcasts.get(room_id)
    if not bucket:
        return False
    now = time.monotonic()
    while bucket and now - bucket[0][0] > _ECHO_WINDOW_SEC:
        bucket.popleft()
    norm = _normalize_for_echo(text)
    return any(b == norm for _, b in bucket)

# Load environment variables BEFORE importing agents (they need GROQ_API_KEY)
load_dotenv(override=False)

from fastapi import FastAPI, Request, UploadFile, WebSocket, WebSocketDisconnect, HTTPException  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from groq import Groq  # noqa: E402
from pydantic import BaseModel  # noqa: E402
from agents.orchestrator import run_text_pipeline, run_audio_pipeline, run_conversation_pipeline  # noqa: E402
from agents import language_detection_agent, transcription_agent  # noqa: E402
import vocabulary_store  # noqa: E402
import users_store  # noqa: E402
import pricing_store  # noqa: E402
import mongo_store  # noqa: E402
import email_service  # noqa: E402
import conversation_history_store  # noqa: E402
import admin_store  # noqa: E402
import style_profiler  # noqa: E402
import security  # noqa: E402
import voice_clone  # noqa: E402  # standalone XTTS-v2 voice cloning module

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
_summary_client = None
SUMMARY_PROMPT_VERSION = "meeting-minutes-v2"

SUMMARY_LANG_NAMES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German",
    "it": "Italian", "pt": "Portuguese", "zh": "Chinese", "ja": "Japanese",
    "ko": "Korean", "ar": "Arabic", "ru": "Russian", "hi": "Hindi",
    "nl": "Dutch", "pl": "Polish", "tr": "Turkish", "tl": "Tagalog",
}

# Frontend directory - works whether run from project root or from backend directory
_current_file = Path(__file__).resolve()
if _current_file.parent.name == "backend":
    PROJECT_ROOT = _current_file.parent.parent
    FRONTEND_DIR = _current_file.parent.parent / "frontend"
else:
    PROJECT_ROOT = _current_file.parent
    FRONTEND_DIR = _current_file.parent / "frontend"

LOCAL_VOICE_ENGINE_DIR = PROJECT_ROOT / "VOICE ENGINE"

try:
    from voice_engine import EngineConfig, ParticipantConfig, VoiceEngineOrchestrator  # noqa: E402
    from voice_engine.audio.frames import synth_sine_pcm16  # noqa: E402
    from voice_engine.engines.neural_tts import VoiceEngineNeuralTTSPlatform  # noqa: E402
    from voice_engine.models import AudioFrame, SynthAudioEvent  # noqa: E402
    _VOICE_ENGINE_AVAILABLE = True
except Exception as e:
    # Production should install VOICE ENGINE as a normal Python package.
    # This fallback only supports local capstone development before packaging.
    if LOCAL_VOICE_ENGINE_DIR.exists() and str(LOCAL_VOICE_ENGINE_DIR) not in sys.path:
        sys.path.insert(0, str(LOCAL_VOICE_ENGINE_DIR))
    try:
        from voice_engine import EngineConfig, ParticipantConfig, VoiceEngineOrchestrator  # noqa: E402
        from voice_engine.audio.frames import synth_sine_pcm16  # noqa: E402
        from voice_engine.engines.neural_tts import VoiceEngineNeuralTTSPlatform  # noqa: E402
        from voice_engine.models import AudioFrame, SynthAudioEvent  # noqa: E402
        _VOICE_ENGINE_AVAILABLE = True
    except Exception as fallback_error:
        EngineConfig = ParticipantConfig = VoiceEngineOrchestrator = None
        VoiceEngineNeuralTTSPlatform = None
        AudioFrame = SynthAudioEvent = None
        synth_sine_pcm16 = None
        _VOICE_ENGINE_AVAILABLE = False
        logging.getLogger(__name__).warning(
            "VOICE ENGINE package unavailable: %s; local fallback unavailable: %s",
            e,
            fallback_error,
        )


_EMPTY_ROOM_TTL_SEC = 300
_voice_engine_tts_platform = None


def _get_voice_engine_tts_platform():
    global _voice_engine_tts_platform
    if not _VOICE_ENGINE_AVAILABLE or VoiceEngineNeuralTTSPlatform is None:
        return None
    if _voice_engine_tts_platform is not None:
        return _voice_engine_tts_platform

    vendor_dir = LOCAL_VOICE_ENGINE_DIR / "vendor"
    _voice_engine_tts_platform = VoiceEngineNeuralTTSPlatform(
        base_dir=LOCAL_VOICE_ENGINE_DIR if LOCAL_VOICE_ENGINE_DIR.exists() else PROJECT_ROOT,
        vendor_dir=vendor_dir if vendor_dir.exists() else None,
    )
    return _voice_engine_tts_platform


class _ConversationVoiceTTS:
    """Adapter from room TTS calls to the VOICE ENGINE package synthesizer."""

    def __init__(self, sample_rate_hz: int):
        self.sample_rate_hz = sample_rate_hz

    async def synthesize(self, translation, speaker_profile, recipient_id: str):
        audio = b""
        audio_format = "none"
        method = ""

        platform = _get_voice_engine_tts_platform()
        if platform is not None:
            try:
                wav_path = Path(tempfile.gettempdir()) / (
                    f"voice_engine_{speaker_profile.participant_id}_{recipient_id}_{secrets.token_hex(8)}.wav"
                )
                result = await asyncio.to_thread(
                    platform.synthesize_to_wav,
                    translation.target_text,
                    translation.target_language,
                    wav_path,
                    speaker_profile.profile_id,
                )
                method = result.method
                if result.audio_bytes > 0 and "fallback_tone" not in result.method:
                    audio = wav_path.read_bytes()
                    audio_format = "wav"
                wav_path.unlink(missing_ok=True)
                wav_path.with_suffix(".mp3").unlink(missing_ok=True)
                wav_path.with_suffix(".aiff").unlink(missing_ok=True)
            except Exception as e:
                logger.warning("VOICE ENGINE package synthesis skipped: %s", e)
                audio = b""
                audio_format = "none"

        if audio_format == "none" and voice_clone.is_available() and voice_clone.has_enrollment(speaker_profile.participant_id):
            try:
                audio = await asyncio.to_thread(
                    voice_clone.synthesize_for_user,
                    translation.target_text,
                    translation.target_language,
                    speaker_profile.participant_id,
                )
                audio_format = "wav" if audio else "none"
                method = "backend_voice_clone"
            except Exception as e:
                logger.warning("Backend voice clone fallback skipped: %s", e)
                audio = b""
                audio_format = "none"

        return SynthAudioEvent(
            recipient_id=recipient_id,
            source_participant_id=speaker_profile.participant_id,
            pcm16=audio,
            sample_rate_hz=self.sample_rate_hz,
            duration_ms=max(120, min(15_000, len(translation.target_text) * 55)),
            text=translation.target_text,
            audio_format=audio_format,
            metadata={
                **getattr(translation, "metadata", {}),
                **({"synthesizer": method} if method else {}),
            },
        )


_voice_engine_rooms: dict = {}


def _voice_engine_participant(user_id: str, info: dict):
    language = info.get("language") or "en"
    return ParticipantConfig(
        participant_id=user_id,
        display_name=info.get("name") or user_id,
        source_language=language,
        target_language=language,
        voice_profile_id=user_id,
    )


def _get_voice_engine_orchestrator(room_id: str):
    if not _VOICE_ENGINE_AVAILABLE:
        return None
    orchestrator = _voice_engine_rooms.get(room_id)
    if orchestrator is not None:
        return orchestrator

    room = _rooms.get(room_id)
    participants = []
    if room:
        participants = [
            _voice_engine_participant(uid, info)
            for uid, info in room.get("info", {}).items()
        ]
    config = EngineConfig(jitter_buffer_ms=20)
    orchestrator = VoiceEngineOrchestrator(
        room_id=room_id,
        participants=participants,
        config=config,
        tts=_ConversationVoiceTTS(config.sample_rate_hz),
    )
    _voice_engine_rooms[room_id] = orchestrator
    return orchestrator


def _voice_engine_register_participant(room_id: str, user_id: str, info: dict, replace: bool = False) -> None:
    orchestrator = _get_voice_engine_orchestrator(room_id)
    if orchestrator is None:
        return
    if user_id in orchestrator.participant_ids:
        if replace:
            orchestrator.remove_participant(user_id)
        else:
            return
    orchestrator.add_participant(_voice_engine_participant(user_id, info))


def _voice_engine_remove_participant(room_id: str, user_id: str) -> None:
    orchestrator = _voice_engine_rooms.get(room_id)
    if orchestrator is not None:
        orchestrator.remove_participant(user_id)


def _voice_engine_dispose_room(room_id: str) -> None:
    _voice_engine_rooms.pop(room_id, None)


def _voice_engine_learn_translation_correction(
    room_id: str,
    source_participant_id: str,
    recipient_id: str,
    source_text: str,
    target_text: str,
    source_language: str,
    target_language: str,
    metadata: dict | None = None,
) -> bool:
    if not _VOICE_ENGINE_AVAILABLE:
        return False
    learned = False
    if room_id and source_participant_id and recipient_id:
        orchestrator = _get_voice_engine_orchestrator(room_id)
        if orchestrator is not None:
            try:
                room = _rooms.get(room_id) or {}
                info = room.get("info", {})
                if source_participant_id in info:
                    _voice_engine_register_participant(room_id, source_participant_id, info[source_participant_id])
                if recipient_id in info:
                    _voice_engine_register_participant(room_id, recipient_id, info[recipient_id])
                orchestrator.learn_translation_correction(
                    source_participant_id=source_participant_id,
                    recipient_id=recipient_id,
                    source_text=source_text,
                    target_text=target_text,
                    metadata=metadata,
                )
                learned = True
            except Exception as e:
                logger.warning("VOICE ENGINE room correction skipped: room=%s error=%s", room_id, e)

    if not learned and VoiceEngineOrchestrator is not None:
        try:
            config = EngineConfig(jitter_buffer_ms=20)
            orchestrator = VoiceEngineOrchestrator(
                room_id=room_id or "corrections",
                participants=[
                    ParticipantConfig(
                        participant_id=source_participant_id or "source",
                        display_name=source_participant_id or "source",
                        source_language=source_language,
                        target_language=target_language,
                    ),
                    ParticipantConfig(
                        participant_id=recipient_id or "recipient",
                        display_name=recipient_id or "recipient",
                        source_language=target_language,
                        target_language=target_language,
                    ),
                ],
                config=config,
                tts=_ConversationVoiceTTS(config.sample_rate_hz),
            )
            orchestrator.learn_translation_correction(
                source_participant_id=source_participant_id or "source",
                recipient_id=recipient_id or "recipient",
                source_text=source_text,
                target_text=target_text,
                metadata=metadata,
            )
            learned = True
        except Exception as e:
            logger.warning("VOICE ENGINE persistent correction skipped: %s", e)
    return learned


async def _voice_engine_accept_transcript(room_id: str, user_id: str, text: str):
    orchestrator = _get_voice_engine_orchestrator(room_id)
    if orchestrator is None:
        return None
    room = _rooms.get(room_id)
    info = (room or {}).get("info", {}).get(user_id)
    if info:
        _voice_engine_register_participant(room_id, user_id, info)
    frame_ms = orchestrator.config.frame_ms
    pcm16 = synth_sine_pcm16(440.0, frame_ms, orchestrator.config.sample_rate_hz)
    return await orchestrator.accept_audio(
        AudioFrame(
            participant_id=user_id,
            pcm16=pcm16,
            sample_rate_hz=orchestrator.config.sample_rate_hz,
            timestamp_ms=int(time.time() * 1000),
            duration_ms=frame_ms,
            metadata={
                "room_id": room_id,
                "debug_text": text,
                "debug_confidence": "0.99",
            },
        )
    )


async def _voice_engine_accept_pcm_frame(
    room_id: str,
    user_id: str,
    pcm16: bytes,
    sample_rate_hz: int,
    timestamp_ms: int,
    sequence: int,
):
    """Feed live caller PCM into the room VOICE ENGINE pipeline.

    The packaged ASR is pluggable. In this app the Google final transcript is
    still used as the committed phrase until the native package ASR is swapped
    in, but the room engine now receives the continuous mic stream directly.
    """
    orchestrator = _get_voice_engine_orchestrator(room_id)
    if orchestrator is None:
        return None
    room = _rooms.get(room_id)
    info = (room or {}).get("info", {}).get(user_id)
    if info:
        _voice_engine_register_participant(room_id, user_id, info)
    try:
        return await orchestrator.accept_audio(
            AudioFrame(
                participant_id=user_id,
                pcm16=pcm16,
                sample_rate_hz=sample_rate_hz,
                timestamp_ms=timestamp_ms,
                duration_ms=max(1, int((len(pcm16) / 2) * 1000 / max(1, sample_rate_hz))),
                metadata={
                    "room_id": room_id,
                    "sequence": str(sequence),
                },
            )
        )
    except Exception as e:
        logger.warning("VOICE ENGINE live PCM frame skipped: room=%s user=%s error=%s", room_id, user_id, e)
        return None


async def _send_voice_engine_room_outputs(room_id: str, user_id: str, text: str, speaker_name: str) -> bool:
    room = _rooms.get(room_id)
    orchestrator = _get_voice_engine_orchestrator(room_id)
    if not room or orchestrator is None:
        return False

    result = await _voice_engine_accept_transcript(room_id, user_id, text)
    if result is None:
        return False
    if result.blocked_reason:
        logger.warning("VOICE ENGINE blocked room=%s user=%s: %s", room_id, user_id, result.blocked_reason)
        return False

    events_by_recipient = {
        event.recipient_id: event
        for event in result.output_events
        if event.source_participant_id == user_id
    }
    delivered = False
    for other_id, other_ws in list(room["conns"].items()):
        if other_id == user_id or not other_ws:
            continue
        event = events_by_recipient.get(other_id)
        if event is None:
            continue

        has_engine_audio = bool(event.pcm16) and getattr(event, "audio_format", "") == "wav"
        _record_broadcast(room_id, event.text)
        try:
            await other_ws.send_json({
                "type": "message",
                "from_id": user_id,
                "from": speaker_name,
                "original": text,
                "translation": event.text,
                "is_self": False,
                "voice_engine_audio": has_engine_audio,
            })
            if has_engine_audio:
                await other_ws.send_json({
                    "type": "voice_audio",
                    "from_id": user_id,
                    "format": "wav",
                    "audio_b64": base64.b64encode(event.pcm16).decode("ascii"),
                    "engine": "voice_engine",
                    "synthesizer": event.metadata.get("synthesizer", ""),
                })
            delivered = True
        except Exception as e:
            logger.error("VOICE ENGINE delivery error for %s: %s", other_id, e)
    return delivered


async def _send_voice_clone_audio(ws, speaker_id: str, text: str, target_lang: str) -> None:
    """Synthesise *text* in *speaker_id*'s cloned voice and push it to *ws*.

    Best-effort: any failure is swallowed silently so the text path is never
    affected.  Listener-side timeout (~1.5 s) decides whether to use this
    audio or fall back to browser TTS.
    """
    if not text or not text.strip():
        return
    try:
        wav = await asyncio.to_thread(
            voice_clone.synthesize_for_user, text, target_lang, speaker_id,
        )
    except Exception as e:
        logger.warning("voice clone synth skipped (%s)", e)
        return
    if not wav:
        return
    try:
        await ws.send_json({
            "type":      "voice_audio",
            "from_id":   speaker_id,
            "format":    "wav",
            "audio_b64": base64.b64encode(wav).decode("ascii"),
        })
    except Exception:
        pass


async def _cleanup_empty_rooms():
    while True:
        try:
            await asyncio.sleep(60)
            now = time.time()
            for rid in list(_rooms.keys()):
                room = _rooms[rid]
                if room.get("info"):
                    room["empty_since"] = None
                    continue
                empty_since = room.get("empty_since")
                if empty_since and now - empty_since > _EMPTY_ROOM_TTL_SEC:
                    _rooms.pop(rid, None)
                    _recent_broadcasts.pop(rid, None)
                    _voice_engine_dispose_room(rid)
                    logger.info("Cleaned up empty room: %s", rid)
            # Prune idle rate-limit buckets to keep memory bounded
            security._prune_rate_windows()
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.warning("_cleanup_empty_rooms iteration failed: %s", e)


def _get_pricing():
    return pricing_store.get_pricing()

class SignupRequest(BaseModel):
    first_name: str = ""
    last_name: str = ""
    email: str
    phone: str
    password: str
    plan: str = "trial"
    billing_address: dict = {}
    payment_method: dict = {}
    accepted_terms: bool = False

class LoginRequest(BaseModel):
    email: str
    password: str

class CancelSubscriptionRequest(BaseModel):
    email: str
    reason: str = ""

def _check_trial_access(email: str):
    """Middleware helper to block access if trial expired."""
    allowed, reason = users_store.check_access(email)
    if not allowed:
        pricing = _get_pricing()
        raise HTTPException(
            status_code=402, 
            detail={
                "message": reason,
                "pricing": pricing
            }
        )
    return True


def _bearer_email(request: Request) -> str:
    auth = request.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Login required")
    email = auth.split(" ", 1)[1].strip().lower()
    if not email or not users_store.get_user(email):
        raise HTTPException(status_code=401, detail="Invalid login")
    _check_trial_access(email)
    return email


def _b64url_json(data: dict) -> str:
    raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _env_diagnostic(name: str) -> dict:
    raw = os.getenv(name)
    value = raw or ""
    stripped = value.strip()
    return {
        "name": name,
        "present": raw is not None,
        "raw_length": len(value),
        "trimmed_length": len(stripped),
        "leading_space": value != value.lstrip(),
        "trailing_space": value != value.rstrip(),
        "blank_after_trim": stripped == "",
    }


def _livekit_env_diagnostics() -> list[dict]:
    return [
        _env_diagnostic("LIVEKIT_URL"),
        _env_diagnostic("LIVEKIT_API_KEY"),
        _env_diagnostic("LIVEKIT_API_SECRET"),
    ]


def _livekit_token(identity: str, name: str, room_id: str) -> str:
    api_key = os.getenv("LIVEKIT_API_KEY", "").strip()
    api_secret = os.getenv("LIVEKIT_API_SECRET", "").strip()
    missing = []
    if not api_key:
        missing.append("LIVEKIT_API_KEY")
    if not api_secret:
        missing.append("LIVEKIT_API_SECRET")
    if missing:
        logger.error(
            "LiveKit configuration missing: %s diagnostics=%s",
            ", ".join(missing),
            json.dumps(_livekit_env_diagnostics(), ensure_ascii=False),
        )
        raise HTTPException(
            status_code=503,
            detail=f"LiveKit missing environment variable(s): {', '.join(missing)}",
        )

    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "iss": api_key,
        "sub": identity,
        "name": name,
        "nbf": now - 10,
        "exp": now + 60 * 60,
        "video": {
            "room": room_id,
            "roomJoin": True,
            "canPublish": True,
            "canSubscribe": True,
            "canPublishData": False,
        },
    }
    signing_input = f"{_b64url_json(header)}.{_b64url_json(payload)}"
    sig = hmac.new(
        api_secret.encode("utf-8"),
        signing_input.encode("ascii"),
        hashlib.sha256,
    ).digest()
    signature = base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")
    return f"{signing_input}.{signature}"


_active_admin_tokens: dict[str, dict] = {}


def _hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def _require_admin(request: Request) -> dict:
    token = request.headers.get("X-Admin-Token", "").strip()
    admin = _active_admin_tokens.get(token)
    if not token or not admin:
        raise HTTPException(status_code=403, detail="Admin login required")
    return admin

def _format_trial_charge_date(trial_ends_at: float) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(trial_ends_at))

def _plan_amount(plan: str, pricing: dict) -> float:
    return pricing["yearly_price"] if plan == "annual" else pricing["monthly_price"]

def _send_account_emails(user: dict, pricing: dict) -> None:
    charge_date = _format_trial_charge_date(user["trial_ends_at"])
    amount = _plan_amount(user.get("plan", "trial"), pricing)
    has_payment_token = bool(user.get("payment_method", {}).get("token"))
    email_service.send_email(
        user["email"],
        "AI Translate account confirmation",
        (
            "Your AI Translate account has been created.\n\n"
            f"Trial length: {pricing['trial_days']} days\n"
            f"Plan: {user.get('plan', 'trial')}\n"
            f"Refund policy: You may cancel within 10 days after your first charge "
            "if you are not satisfied. After that period, no refund will be made.\n"
        ),
    )
    if not has_payment_token:
        email_service.send_email(
            user["email"],
            "AI Translate test trial notice",
            (
                "Your AI Translate test trial is active.\n\n"
                "No payment information was collected for this testing signup, "
                "so no automatic charge will be processed when the trial ends."
            ),
        )
        return
    email_service.send_email(
        user["email"],
        "AI Translate trial and billing notice",
        (
            f"Your card on file will be charged ${amount:.2f} {pricing['currency']} "
            f"on {charge_date}, after your three-day trial period ends.\n\n"
            "You can cancel before the charge date to avoid billing."
        ),
    )

def _send_invoice_email(user: dict, pricing: dict) -> None:
    amount = _plan_amount(user.get("plan", "trial"), pricing)
    email_service.send_email(
        user["email"],
        f"AI Translate invoice {user['invoice_number']}",
        (
            f"Invoice: {user['invoice_number']}\n"
            f"Amount charged: ${amount:.2f} {pricing['currency']}\n"
            f"Plan: {user.get('plan', 'trial')}\n"
            "Payment status: Paid\n"
        ),
    )
    users_store.update_user(user["email"], {"invoice_sent_at": time.time()})

async def _process_trial_charges():
    while True:
        try:
            await asyncio.sleep(60)
            pricing = _get_pricing()
            now = time.time()
            for email, user in users_store.list_users().items():
                if user.get("cancelled_at") or user.get("charged_at"):
                    continue
                if now < user.get("trial_ends_at", 0):
                    continue
                # Payment is represented by a processor token in this scaffold.
                # Never store raw card numbers in this app.
                if not user.get("payment_method", {}).get("token"):
                    continue
                charged = users_store.mark_charged(email)
                if charged:
                    _send_invoice_email(charged, pricing)
                    logger.info("Processed trial charge for %s", email)
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.warning("_process_trial_charges iteration failed: %s", e)

@asynccontextmanager
async def lifespan(app):
    cleanup_task = asyncio.create_task(_cleanup_empty_rooms())
    billing_task = asyncio.create_task(_process_trial_charges())
    try:
        yield
    finally:
        cleanup_task.cancel()
        billing_task.cancel()
        try:
            await cleanup_task
        except (asyncio.CancelledError, Exception):
            pass
        try:
            await billing_task
        except (asyncio.CancelledError, Exception):
            pass

app = FastAPI(title="AI Translate", version="2.0.0", lifespan=lifespan)

# CORS — restricted to configured origins in production; open in dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=security.get_allowed_origins(),
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["X-Response-Time-Ms"],
)

# API key auth + rate limiting for /api/v1/ routes
app.middleware("http")(security.api_guard)

# Security headers on every response (must be added last = outermost wrapper)
app.middleware("http")(security.security_headers_middleware)


@app.middleware("http")
async def _no_cache_static(request, call_next):
    """Force fresh fetches of frontend assets so iPhone Safari can't pin
    a stale app.js / styles.css / index.html across deploys.
    """
    response = await call_next(request)
    p = request.url.path
    if p == "/" or p.endswith((".js", ".css", ".html")):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# Conversation rooms: room_id → {
#   "conns":      {user_id: WebSocket},
#   "info":       {user_id: {name, language, is_host, mic_on, camera_on}},
#   "host_id":    str | None,
#   "empty_since": float | None,
#   "speaking":   {user_id: float}   ← monotonic ts; active utterance tracking
# }
_rooms: dict = {}


# ── Authentication API ────────────────────────────────────────────────────────

@app.get("/api/pricing")
async def pricing():
    return _get_pricing()


@app.post("/api/v1/auth/signup")
async def signup(body: SignupRequest):
    import hashlib
    pricing = _get_pricing()
    if not body.accepted_terms:
        raise HTTPException(status_code=400, detail="Billing and refund terms must be accepted")
    h = hashlib.sha256(body.password.encode()).hexdigest()
    user = users_store.create_user(
        body.email,
        body.phone,
        h,
        trial_days=pricing["trial_days"],
        first_name=body.first_name,
        last_name=body.last_name,
        plan=body.plan,
        billing_address=body.billing_address,
        payment_method=body.payment_method,
        accepted_terms_at=time.time(),
    )
    if not user:
        raise HTTPException(status_code=400, detail="User already exists")
    _send_account_emails(user, pricing)
    return {
        "status": "success",
        "email": user["email"],
        "first_name": user.get("first_name", ""),
        "last_name": user.get("last_name", ""),
        "access_token": user["email"],
        "trial_ends_at": user["trial_ends_at"],
    }

@app.post("/api/v1/auth/login")
async def login(body: LoginRequest):
    import hashlib
    user = users_store.get_user(body.email)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    h = hashlib.sha256(body.password.encode()).hexdigest()
    if user["password_hash"] != h:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    
    allowed, reason = users_store.check_access(body.email)
    return {
        "status": "success", 
        "email": user["email"], 
        "first_name": user.get("first_name", ""),
        "last_name": user.get("last_name", ""),
        "access_token": user["email"],
        "trial_ends_at": user.get("trial_ends_at"),
        "is_subscriber": bool(user.get("is_subscriber")),
        "access": {"allowed": allowed, "reason": reason}
    }

@app.post("/api/v1/auth/forgot-password")
async def forgot_password(email: str):
    # Avoid revealing whether an email address has an account.
    return {"message": "If this email exists, a reset link has been sent."}

@app.post("/api/v1/billing/cancel")
async def cancel_subscription(body: CancelSubscriptionRequest):
    user = users_store.get_user(body.email)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    now = time.time()
    updates = {
        "cancelled_at": now,
        "refund_requested_at": now,
        "is_subscriber": False,
    }

    charged_at = user.get("charged_at")
    refund_eligible = bool(charged_at and now - charged_at <= 10 * 86400)
    if refund_eligible:
        updates["refunded_at"] = now

    updated = users_store.update_user(body.email, updates)
    email_service.send_email(
        updated["email"],
        "AI Translate cancellation confirmation",
        (
            "Your AI Translate subscription has been cancelled.\n\n"
            + (
                "Your cancellation is within the 10-day satisfaction period, so a refund has been recorded.\n"
                if refund_eligible
                else "This cancellation is outside the 10-day satisfaction period or occurred before a paid charge; no refund is due.\n"
            )
        ),
    )
    return {
        "status": "cancelled",
        "refund_eligible": refund_eligible,
        "message": (
            "Cancellation recorded and refund marked."
            if refund_eligible
            else "Cancellation recorded. No refund is available under the agreed terms."
        ),
    }

# ── Vocabulary Pydantic schemas ────────────────────────────────────────────────

class VocabEntry(BaseModel):
    term: str
    definition: str
    language: str = "en"
    variants: list[str] = []
    domain: str = ""
    translations: dict[str, str] = {}


class VocabUpdate(BaseModel):
    term: str | None = None
    definition: str | None = None
    language: str | None = None
    variants: list[str] | None = None
    domain: str | None = None
    translations: dict[str, str] | None = None


class TranslationCorrection(BaseModel):
    source_text: str
    source_lang: str
    target_lang: str
    correct_translation: str
    bad_translation: str = ""
    room_id: str = ""
    source_participant_id: str = ""
    recipient_id: str = ""


class ConversationSummaryMessage(BaseModel):
    speaker: str
    original: str = ""
    translation: str = ""
    shown_text: str = ""
    is_self: bool = False
    source: str = ""
    timestamp: str = ""


class ConversationSummaryRequest(BaseModel):
    messages: list[ConversationSummaryMessage]
    participants: list[str] = []
    participant_emails: list[str] = []
    target_language: str = "en"
    room_id: str = ""


class ConversationHistorySaveRequest(ConversationSummaryRequest):
    summary: dict


class HistoryDateRangeRequest(BaseModel):
    start_date: str = ""
    end_date: str = ""


class HistoryEmailRequest(BaseModel):
    recipient: str = ""
    content_type: str = "both"


class AdminSignupRequest(BaseModel):
    email: str
    password: str
    role: str = "admin"


class AdminLoginRequest(BaseModel):
    email: str
    password: str


class RetentionRequest(BaseModel):
    retention_days: int


_ROOM_ID_ALPHABET = "0123456789"


def _gen_room_id() -> str:
    return "".join(random.choices(_ROOM_ID_ALPHABET, k=6))


def _gen_user_id() -> str:
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=8))


@app.get("/")
async def root():
    """Serve index.html for the SPA."""
    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"message": "AI Translate API"}


@app.get("/api/health")
async def health_check():
    """API health check endpoint."""
    return {"status": "ok"}


@app.get("/create_room")
async def create_room():
    """Generate a new room ID for live conversation."""
    room_id = _gen_room_id()
    while room_id in _rooms:
        room_id = _gen_room_id()
    # Allocate the room immediately so that subsequent /ws/conversation/{id}
    # joins can validate the ID exists. Without this, a participant typing
    # a wrong (or stale) room ID would silently create a brand-new room
    # and become its host.
    _rooms[room_id] = {"conns": {}, "info": {}, "host_id": None, "empty_since": time.time(), "speaking": {}}
    return {"room_id": room_id}


@app.get("/api/livekit/token")
async def livekit_video_token(room_id: str, identity: str, name: str, request: Request):
    """Issue a short-lived LiveKit token for conversation video only."""
    _bearer_email(request)
    livekit_url = os.getenv("LIVEKIT_URL", "").strip()
    if not livekit_url:
        logger.error(
            "LiveKit configuration missing: LIVEKIT_URL diagnostics=%s",
            json.dumps(_livekit_env_diagnostics(), ensure_ascii=False),
        )
        raise HTTPException(
            status_code=503,
            detail="LiveKit missing environment variable(s): LIVEKIT_URL",
        )
    if not room_id or not identity:
        raise HTTPException(status_code=400, detail="room_id and identity are required")
    return {
        "url": livekit_url,
        "token": _livekit_token(identity[:128], name[:128] or identity[:128], room_id[:128]),
    }


@app.get("/api/livekit/diagnostics")
async def livekit_diagnostics(request: Request):
    """Report LiveKit env var shape without exposing any secret values."""
    _bearer_email(request)
    return {"livekit_env": _livekit_env_diagnostics()}


# ── Enterprise Vocabulary API  (/api/v1/vocabulary) ───────────────────────────

@app.get("/api/v1/vocabulary")
async def vocab_list():
    """List all enterprise vocabulary entries."""
    return {"entries": vocabulary_store.list_all(), "version": vocabulary_store.get_version()}


@app.post("/api/v1/vocabulary", status_code=201)
async def vocab_add(body: VocabEntry):
    """Add a new enterprise vocabulary entry."""
    entry = vocabulary_store.add(
        body.term, body.definition,
        language=body.language,
        variants=body.variants,
        domain=body.domain,
        translations=body.translations,
    )
    return entry


@app.put("/api/v1/vocabulary/{entry_id}")
async def vocab_update(entry_id: str, body: VocabUpdate):
    """Update an existing vocabulary entry."""
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    updated = vocabulary_store.update(entry_id, **updates)
    if not updated:
        raise HTTPException(status_code=404, detail="Entry not found")
    return updated


@app.delete("/api/v1/vocabulary/{entry_id}")
async def vocab_delete(entry_id: str):
    """Delete a vocabulary entry."""
    if not vocabulary_store.delete(entry_id):
        raise HTTPException(status_code=404, detail="Entry not found")
    return {"deleted": entry_id}


@app.post("/api/v1/vocabulary/bulk", status_code=201)
async def vocab_bulk(rows: list[VocabEntry]):
    """Bulk-import vocabulary entries."""
    added = vocabulary_store.bulk_import([r.model_dump() for r in rows])
    return {"added": added, "version": vocabulary_store.get_version()}


@app.post("/api/v1/translation/correction", status_code=201)
async def translation_correction(body: TranslationCorrection):
    """Record a user-supplied correction so future translations of the same
    source phrase get the right rendering injected as authoritative context.

    Stored as a vocabulary entry with domain='correction' so corrections
    can be audited/managed separately from curated terminology.
    """
    source_text = body.source_text.strip()
    correct = body.correct_translation.strip()
    if not source_text or not correct:
        raise HTTPException(status_code=400, detail="source_text and correct_translation required")
    entry = vocabulary_store.add(
        term=source_text,
        definition=f"User correction (was: {body.bad_translation[:120]})" if body.bad_translation else "User correction",
        language=body.source_lang,
        domain="correction",
        translations={body.target_lang: correct},
    )
    voice_engine_saved = _voice_engine_learn_translation_correction(
        room_id=body.room_id.strip(),
        source_participant_id=body.source_participant_id.strip(),
        recipient_id=body.recipient_id.strip(),
        source_text=source_text,
        target_text=correct,
        source_language=body.source_lang,
        target_language=body.target_lang,
        metadata={
            "source": "conversation_correct_button",
            "bad_translation": body.bad_translation[:240],
            "vocabulary_entry_id": entry.get("id", ""),
        },
    )
    logger.info("Translation correction saved: %r [%s→%s] = %r voice_engine=%s",
                source_text[:60], body.source_lang, body.target_lang, correct[:60], voice_engine_saved)
    return {**entry, "voice_engine_memory_saved": voice_engine_saved}


def _get_summary_client() -> Groq:
    global _summary_client
    if _summary_client is None:
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY environment variable is not set")
        _summary_client = Groq(api_key=api_key)
    return _summary_client


def _extract_json_object(text: str) -> dict:
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:].strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        raw = raw[start:end + 1]
    return json.loads(raw)


def _history_participants(
    *,
    owner_email: str,
    room_id: str,
    participants: list[str],
    participant_emails: list[str],
) -> tuple[list[str], list[str]]:
    room_info = _rooms.get(room_id, {}).get("info", {}) if room_id else {}
    emails = list(participant_emails or [])
    names = list(participants or [])
    for info in room_info.values():
        if info.get("email"):
            emails.append(info["email"])
        if info.get("name") and info["name"] not in names:
            names.append(info["name"])
    emails.append(owner_email)
    return names, emails


def _message_value(message, field: str) -> str:
    if isinstance(message, dict):
        return message.get(field, "") or ""
    return getattr(message, field, "") or ""


def _generate_conversation_summary(rows: list, participants: list[str], target_language_code: str) -> dict:
    transcript_lines = []
    for m in rows:
        shown_text = _message_value(m, "shown_text")
        original_text = _message_value(m, "original")
        translated_text = _message_value(m, "translation")
        text = shown_text or original_text or translated_text
        original = original_text if original_text and original_text != text else ""
        translated = translated_text if translated_text and translated_text != text else ""
        source = "chat board" if _message_value(m, "source") == "discussion_board" else "transcript"
        line = f"{_message_value(m, 'speaker')}: {text.strip()} [{source}]"
        if original:
            line += f" | Original: {original.strip()}"
        if translated:
            line += f" | Translation shown: {translated.strip()}"
        transcript_lines.append(line[:1200])
    transcript = "\n".join(transcript_lines)[-14000:]
    participant_text = ", ".join(p for p in participants if p) or "Not provided"
    target_language = SUMMARY_LANG_NAMES.get(target_language_code, target_language_code or "English")

    prompt = (
        "You are writing professional meeting minutes from a live conversation chat board. "
        "Use the chat board transcript as the source of truth, but do not merely restate each message. "
        "Synthesize what happened like a human editor: combine repeated points, preserve the intent, "
        "use neutral business language, and make each bullet useful to someone who was not present. "
        f"Write every user-visible JSON value in {target_language}. "
        "Keep JSON keys exactly in English as specified. "
        "Return valid JSON only. The JSON must map exactly to these predefined sections: "
        "main_goal string; important_discussions array of strings; takeaways array of strings; "
        "action_items array of objects with owner, task, deliverable, due_date; "
        "follow_ups array of objects with owner, with_whom, reason, timing; "
        "second_meeting string; reconvene_notes array of strings. "
        "For main_goal, write one concise sentence describing the purpose or topic of the exchange; "
        "use the local-language equivalent of 'Not identified' only when no purpose can be reasonably inferred. "
        "For important_discussions, write 1-5 editorial bullets covering the substantive topics discussed. "
        "For takeaways, write 1-5 outcome-oriented bullets explaining what was learned, agreed, clarified, or left unresolved. "
        "For reconvene_notes, write concise notes about unresolved issues, missing decisions, or why no further meeting is needed. "
        "If the chat is a language or translation check, capture the language identification or usage under "
        "important_discussions and takeaways even when there is no business meeting goal. "
        "Use the local-language equivalent of 'Not identified' for unknown string fields. "
        "Create action_items only when a participant explicitly accepts or is assigned work; do not turn observations into tasks. "
        "Create follow_ups only when someone explicitly needs to contact or respond to someone else. "
        "Use exact dates only if stated; otherwise use the local-language equivalent of 'Not identified'. "
        "Do not invent facts, decisions, owners, deadlines, or meetings not supported by the chat board transcript. "
        "Do not quote the transcript unless a short exact phrase is necessary for clarity.\n\n"
        f"Participants: {participant_text}\n\nChat board transcript:\n{transcript}"
    )

    model = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
    response = _get_summary_client().chat.completions.create(
        model=model,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a senior meeting-minutes editor. Produce concise, professional, "
                    "evidence-based minutes as JSON only."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        temperature=0,
        max_tokens=1800,
    )
    return _extract_json_object(response.choices[0].message.content)


@app.post("/api/v1/conversation/summary")
async def conversation_summary(body: ConversationSummaryRequest, request: Request):
    rows = [
        m for m in body.messages[-120:]
        if (m.original or m.translation or m.shown_text).strip()
    ]
    if not rows:
        raise HTTPException(status_code=400, detail="No conversation messages to summarize")

    try:
        return _generate_conversation_summary(rows, body.participants, body.target_language)
    except Exception as exc:
        logger.error("Conversation summary failed: %s", exc)
        raise HTTPException(status_code=500, detail="Conversation summary failed")


@app.post("/api/v1/conversation/history/save")
async def conversation_history_save(body: ConversationHistorySaveRequest, request: Request):
    owner_email = _bearer_email(request)
    rows = [
        m for m in body.messages[-120:]
        if (m.original or m.translation or m.shown_text).strip()
    ]
    if not rows:
        raise HTTPException(status_code=400, detail="No conversation messages to save")
    participants, participant_emails = _history_participants(
        owner_email=owner_email,
        room_id=body.room_id,
        participants=body.participants,
        participant_emails=body.participant_emails,
    )
    record = conversation_history_store.upsert_record_for_date(
        owner_email=owner_email,
        room_id=body.room_id,
        participants=participants,
        participant_emails=participant_emails,
        participant_language=body.target_language,
        summary=body.summary,
        messages=[m.model_dump() for m in rows],
        model=os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile"),
        summary_prompt_version=SUMMARY_PROMPT_VERSION,
    )
    return {
        "status": "saved",
        "record_id": record["id"],
        "full_chat_record_id": f"chat_{record['id']}",
        "local_date": record["local_date"],
        "updated_at": record.get("updated_at") or record.get("created_at"),
    }


def _format_history_summary_lines(record: dict) -> list[str]:
    summary = record.get("summary", {})
    lines = [
        "Summary",
        f"Main Goal: {summary.get('main_goal', 'Not identified')}",
        "",
        "Important Discussions:",
        *[f"- {item}" for item in summary.get("important_discussions", [])],
        "",
        "Takeaways:",
        *[f"- {item}" for item in summary.get("takeaways", [])],
        "",
        "Action Items:",
    ]
    action_items = summary.get("action_items", [])
    lines.extend(
        [
            f"- {i.get('owner', 'Not identified')}: {i.get('task', 'Not identified')} "
            f"(Deliverable: {i.get('deliverable', 'Not identified')}; Due: {i.get('due_date', 'Not identified')})"
            for i in action_items
        ]
        or ["- Not identified"]
    )
    lines.extend(["", "Follow-ups:"])
    follow_ups = summary.get("follow_ups", [])
    lines.extend(
        [
            f"- {i.get('owner', 'Not identified')} -> {i.get('with_whom', 'Not identified')}: "
            f"{i.get('reason', 'Not identified')} (Timing: {i.get('timing', 'Not identified')})"
            for i in follow_ups
        ]
        or ["- Not identified"]
    )
    lines.extend(
        [
            "",
            f"Second Meeting: {summary.get('second_meeting', 'Not identified')}",
            "",
            "Reconvene Notes:",
            *[f"- {item}" for item in summary.get("reconvene_notes", [])],
        ]
    )
    return lines


def _format_history_chat_lines(record: dict) -> list[str]:
    lines = ["Full Chat Source:"]
    for m in record.get("chat_messages", []):
        text = m.get("shown_text") or m.get("original") or m.get("translation") or ""
        lines.append(f"- {m.get('speaker', 'Unknown')}: {text}")
        if m.get("original") and m.get("original") != text:
            lines.append(f"  Original: {m.get('original')}")
        if m.get("translation") and m.get("translation") != text:
            lines.append(f"  Translation shown: {m.get('translation')}")
    return lines


def _format_history_email(
    record: dict,
    content_type: str = "both",
    *,
    admin_email: str = "",
    cc: list[str] | None = None,
) -> str:
    content_type = content_type if content_type in {"both", "summary", "chat"} else "both"
    lines = [
        "AI Translate conversation history",
        "",
        f"Conversation Date: {record.get('local_date', 'Not identified')}",
        f"Created: {record.get('created_at', 'Not identified')}",
        f"Room: {record.get('room_id') or 'Not identified'}",
        f"Participants: {', '.join(record.get('participants', [])) or 'Not identified'}",
        f"Participant Emails: {', '.join(record.get('participant_emails', [])) or 'Not identified'}",
        f"To/From Admin: {admin_email or 'Not identified'}",
        f"Cc Participants: {', '.join(cc or []) or 'None'}",
        f"Included Content: {content_type}",
        "",
    ]
    if content_type in {"both", "summary"}:
        lines.extend(_format_history_summary_lines(record))
    if content_type == "both":
        lines.append("")
    if content_type in {"both", "chat"}:
        lines.extend(_format_history_chat_lines(record))
    return "\n".join(lines)


@app.get("/api/v1/conversation/history/dates")
async def conversation_history_dates(request: Request, start_date: str = "", end_date: str = ""):
    owner_email = _bearer_email(request)
    return {
        "retention_days": conversation_history_store.get_retention_days(),
        "dates": conversation_history_store.list_dates(owner_email, start_date, end_date),
    }


@app.get("/api/v1/conversation/history/record/{record_id}")
async def conversation_history_record(record_id: str, request: Request):
    owner_email = _bearer_email(request)
    record = conversation_history_store.get_record(owner_email, record_id)
    if not record:
        raise HTTPException(status_code=404, detail="History record not found")
    return record


@app.get("/api/v1/conversation/history/date/{date}")
async def conversation_history_by_date(date: str, request: Request):
    owner_email = _bearer_email(request)
    return {"date": date, "records": conversation_history_store.list_records_for_date(owner_email, date)}


@app.delete("/api/v1/conversation/history/date/{date}")
async def conversation_history_delete_date(date: str, request: Request):
    owner_email = _bearer_email(request)
    deleted = conversation_history_store.delete_date(owner_email, date)
    return {"date": date, "deleted_records": deleted}


@app.post("/api/v1/conversation/history/record/{record_id}/email")
async def conversation_history_email(record_id: str, body: HistoryEmailRequest, request: Request):
    owner_email = _bearer_email(request)
    record = conversation_history_store.get_record(owner_email, record_id)
    if not record:
        raise HTTPException(status_code=404, detail="History record not found")
    if not body.recipient.strip():
        raise HTTPException(status_code=400, detail="Recipient email is required")
    content_type = body.content_type if body.content_type in {"both", "summary", "chat"} else "both"
    subject_content = {
        "both": "summary and full chat",
        "summary": "summary",
        "chat": "full chat",
    }[content_type]
    sent = email_service.send_email(
        body.recipient,
        f"AI Translate {subject_content} - {record.get('local_date', '')}",
        _format_history_email(record, content_type),
    )
    return {"status": "sent", "delivery": sent.get("delivery", "unknown")}


@app.post("/api/v1/admin/signup")
async def admin_signup(body: AdminSignupRequest):
    if not body.email.strip() or not body.password:
        raise HTTPException(status_code=400, detail="Admin email and password are required")
    admin = admin_store.create_admin(
        body.email,
        _hash_password(body.password),
        role=body.role or "admin",
    )
    if not admin:
        raise HTTPException(status_code=400, detail="Admin account already exists")
    return {
        "status": "success",
        "email": admin["email"],
        "role": admin.get("role", "admin"),
        "privileges": admin.get("privileges", {}),
    }


@app.post("/api/v1/admin/login")
async def admin_login(body: AdminLoginRequest):
    admin = admin_store.get_admin(body.email)
    if not admin or not secrets.compare_digest(admin.get("password_hash", ""), _hash_password(body.password)):
        raise HTTPException(status_code=401, detail="Invalid admin password")
    token = secrets.token_urlsafe(32)
    _active_admin_tokens[token] = {
        "email": admin["email"],
        "role": admin.get("role", "admin"),
        "privileges": admin.get("privileges", {}),
    }
    return {
        "status": "success",
        "admin_token": token,
        "email": admin["email"],
        "role": admin.get("role", "admin"),
        "privileges": admin.get("privileges", {}),
        "retention_days": conversation_history_store.get_retention_days(),
    }


@app.get("/api/v1/admin/conversation-history/dates")
async def admin_history_dates(
    request: Request,
    start_date: str = "",
    end_date: str = "",
    participant_email: str = "",
    room_id: str = "",
):
    _require_admin(request)
    return {
        "retention_days": conversation_history_store.get_retention_days(),
        "dates": conversation_history_store.list_all_dates(
            start_date,
            end_date,
            participant_email,
            room_id,
        ),
    }


@app.get("/api/v1/admin/conversation-history/date/{date}")
async def admin_history_by_date(date: str, request: Request):
    _require_admin(request)
    return {"date": date, "records": conversation_history_store.list_all_records_for_date(date)}


@app.get("/api/v1/admin/conversation-history/record/{record_id}")
async def admin_history_record(record_id: str, request: Request):
    _require_admin(request)
    record = conversation_history_store.get_record_any(record_id)
    if not record:
        raise HTTPException(status_code=404, detail="History record not found")
    return record


@app.delete("/api/v1/admin/conversation-history/date/{date}")
async def admin_history_delete_date(date: str, request: Request):
    _require_admin(request)
    deleted = conversation_history_store.delete_date_all(date)
    return {"date": date, "deleted_records": deleted}


@app.post("/api/v1/admin/conversation-history/record/{record_id}/regenerate")
async def admin_history_regenerate(record_id: str, request: Request):
    _require_admin(request)
    record = conversation_history_store.get_record_any(record_id)
    if not record:
        raise HTTPException(status_code=404, detail="History record not found")
    rows = [
        m for m in record.get("chat_messages", [])[-120:]
        if (m.get("original") or m.get("translation") or m.get("shown_text"))
    ]
    if not rows:
        raise HTTPException(status_code=400, detail="No full chat source to regenerate from")
    try:
        summary = _generate_conversation_summary(
            rows,
            record.get("participants", []),
            record.get("participant_language", "en"),
        )
    except Exception as exc:
        logger.error("Admin summary regeneration failed: %s", exc)
        raise HTTPException(status_code=500, detail="Summary regeneration failed")
    updated = conversation_history_store.upsert_record_for_date(
        owner_email=record["owner_email"],
        room_id=record.get("room_id", ""),
        participants=record.get("participants", []),
        participant_emails=record.get("participant_emails", []),
        participant_language=record.get("participant_language", "en"),
        summary=summary,
        messages=rows,
        model=os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile"),
        summary_prompt_version=SUMMARY_PROMPT_VERSION,
    )
    return {"status": "regenerated", "record_id": updated["id"], "summary": summary}


@app.post("/api/v1/admin/conversation-history/record/{record_id}/email")
async def admin_history_email(record_id: str, body: HistoryEmailRequest, request: Request):
    admin = _require_admin(request)
    record = conversation_history_store.get_record_any(record_id)
    if not record:
        raise HTTPException(status_code=404, detail="History record not found")
    content_type = body.content_type if body.content_type in {"both", "summary", "chat"} else "both"
    subject_content = {
        "both": "summary and full chat",
        "summary": "summary",
        "chat": "full chat",
    }[content_type]
    admin_email = admin["email"]
    cc = [e for e in record.get("participant_emails", []) if e.lower() != admin_email.lower()]
    sent = email_service.send_email(
        admin_email,
        f"AI Translate {subject_content} - {record.get('local_date', '')}",
        _format_history_email(record, content_type, admin_email=admin_email, cc=cc),
        cc=cc,
        from_email=admin_email,
    )
    return {"status": "sent", "delivery": sent.get("delivery", "unknown"), "cc": cc}


@app.get("/api/v1/admin/conversation-history/retention")
async def admin_get_retention(request: Request):
    _require_admin(request)
    return {"retention_days": conversation_history_store.get_retention_days()}


@app.put("/api/v1/admin/conversation-history/retention")
async def admin_set_retention(body: RetentionRequest, request: Request):
    admin = _require_admin(request)
    if not admin.get("privileges", {}).get("maintain_retention_days"):
        raise HTTPException(status_code=403, detail="Admin lacks retention privilege")
    return conversation_history_store.set_retention_days(body.retention_days)


# ── Translation cache stats (API-first observability) ─────────────────────────

@app.get("/api/v1/stats")
async def api_stats():
    """Live runtime counters for observability / SLA dashboards."""
    from agents import translation_agent as _ta
    return {
        "rooms_active": len(_rooms),
        "translation_cache_size": _ta.cache_size(),
        "vocabulary_entries": len(vocabulary_store.list_all()),
        "vocabulary_version": vocabulary_store.get_version(),
        "mongodb_enabled": mongo_store.is_enabled(),
        "pinecone_enabled": bool(os.getenv("PINECONE_API_KEY") and os.getenv("PINECONE_INDEX_HOST")),
        "production_mode": security.is_production(),
        "rate_limit_rpm": int(os.getenv("RATE_LIMIT_RPM", "120")),
    }


# ── /api/v1/ aliases for core translation endpoints ───────────────────────────
# Versioned surface for SDK / enterprise API clients.
# Legacy root-level routes kept for backward compatibility.

@app.post("/api/v1/translate/text")
async def api_translate_text(source: str, target: str, text: str, email: str = "guest", request: Request = None):
    _check_trial_access(email)
    """Translate text (SDK/API-first endpoint)."""
    if request:
        security.audit("translate_text", request, source=source, target=target,
                       chars=len(text))
    result = run_text_pipeline(text, source, target)
    return result


@app.post("/api/v1/translate/audio")
async def api_translate_audio(source: str, target: str, file: UploadFile,
                               request: Request = None):
    """Translate an uploaded audio file (SDK/API-first endpoint)."""
    filepath = f"temp_api_{file.filename}"
    with open(filepath, "wb") as f:
        f.write(await file.read())
    try:
        result = run_audio_pipeline(filepath, source, target)
    finally:
        if os.path.exists(filepath):
            os.remove(filepath)
    if request:
        security.audit("translate_audio", request, source=source, target=target)
    return result


@app.post("/api/v1/detect")
async def api_detect_language(text: str, request: Request = None):
    """Detect language (SDK/API-first endpoint)."""
    detected = language_detection_agent.run(text)
    return {"detected_language": detected}


# ── Voice Cloning API  (/api/v1/voices)  ──────────────────────────────────────
# Backed by the standalone `voice_clone` module (Coqui XTTS-v2).
# Gracefully reports 503 when the model can't load (e.g. on Render free tier
# where torch+XTTS won't fit in 512 MB) so the frontend can fall back to the
# browser's Web Speech API.

@app.get("/api/v1/voices/status")
async def voices_status():
    """Whether voice cloning is available on this deployment."""
    return {
        "available":          voice_clone.is_available(),
        "supported_languages": sorted(voice_clone.SUPPORTED_LANGUAGES),
    }


@app.post("/api/v1/voices/enroll", status_code=201)
async def voices_enroll(user_id: str, file: UploadFile, request: Request = None):
    """Enroll a reference voice clip for *user_id*.

    Accepts a multipart audio upload (5-15 s of clean speech recommended).
    The bytes are stored verbatim under VOICE_CLONE_REF_DIR.  The frontend
    is responsible for sending a mono PCM WAV — the recorder pipeline does
    a WebM→WAV decode before upload.
    """
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="empty upload")
    path = voice_clone.enroll(audio_bytes, user_id)
    if request:
        security.audit("voice_enroll", request, user_id=user_id, bytes=len(audio_bytes))
    # Run the diagnostic analysis on the saved clip — useful for the UI to
    # show the speaker their captured pitch/jitter/etc.
    features = voice_clone.analyze_voice(path)
    return {"user_id": user_id, "reference_path": path, "features": features}


@app.post("/api/v1/voices/analyze")
async def voices_analyze(file: UploadFile):
    """Return acoustic attributes for an uploaded clip without enrolling it."""
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="empty upload")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name
    try:
        return voice_clone.analyze_voice(tmp_path)
    finally:
        try:
            os.remove(tmp_path)
        except FileNotFoundError:
            pass


class VoiceSynthesizeBody(BaseModel):
    text:    str
    language: str
    user_id: str


@app.post("/api/v1/voices/synthesize")
async def voices_synthesize(body: VoiceSynthesizeBody, request: Request = None):
    """Synthesise translated text in the cloned voice of *user_id*.

    Returns the audio as a base64-encoded WAV in JSON so it can be embedded
    directly into a `<audio>` element via a data: URL on the frontend.
    """
    if not voice_clone.is_available():
        raise HTTPException(status_code=503, detail="voice cloning not available on this deployment")
    if not voice_clone.has_enrollment(body.user_id):
        raise HTTPException(status_code=404, detail=f"no enrollment for user {body.user_id!r}")
    try:
        wav = await asyncio.to_thread(
            voice_clone.synthesize_for_user, body.text, body.language, body.user_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except (FileNotFoundError, RuntimeError) as e:
        raise HTTPException(status_code=503, detail=str(e))
    if request:
        security.audit("voice_synthesize", request,
                       user_id=body.user_id, language=body.language, chars=len(body.text))
    return {
        "format":   "wav",
        "audio_b64": base64.b64encode(wav).decode("ascii"),
        "bytes":    len(wav),
    }


@app.websocket("/ws/conversation/{room_id}")
async def conversation_ws(websocket: WebSocket, room_id: str):
    """WebSocket endpoint for live multi-user conversation."""
    await websocket.accept()

    # Read the join message FIRST so we can honour `is_creator` before deciding
    # whether to allocate / reject for an unknown room.
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=15)
        data = json.loads(raw)
        if data.get("type") != "join":
            try:
                await websocket.close()
            except Exception:
                pass
            return
    except WebSocketDisconnect:
        return  # client already gone — nothing to close
    except (asyncio.TimeoutError, Exception):
        try:
            await websocket.close()
        except Exception:
            pass
        return

    is_creator = bool(data.get("is_creator", False))

    if room_id not in _rooms:
        if is_creator:
            # Host's frontend remembers it created this room (e.g. the server
            # restarted on a deploy). Recreate the room so they can keep going.
            _rooms[room_id] = {"conns": {}, "info": {}, "host_id": None, "empty_since": time.time(), "speaking": {}}
            logger.info("Re-created room on host reconnect: %s", room_id)
        else:
            try:
                await websocket.send_json({"type": "error", "code": "room_not_found",
                                           "message": f"Room {room_id} does not exist."})
                await websocket.close()
            except Exception:
                pass
            return

    room = _rooms[room_id]
    room["empty_since"] = None

    generated_user_id = _gen_user_id()
    user_id = generated_user_id
    previous_user_id = data.get("previous_user_id", "")
    join_email = data.get("email", "")
    join_name = data.get("name", "")
    join_language = data.get("language", "")

    if previous_user_id and previous_user_id in room["info"]:
        user_id = previous_user_id
    elif join_email:
        for existing_id, info in list(room["info"].items()):
            if info.get("email") == join_email and (existing_id not in room["conns"] or info.get("idle")):
                user_id = existing_id
                break
    if user_id == generated_user_id and join_name and join_language:
        matching_idle_ids = [
            existing_id
            for existing_id, info in list(room["info"].items())
            if (
                info.get("idle")
                and info.get("name") == join_name
                and info.get("language") == join_language
            )
        ]
        if len(matching_idle_ids) == 1:
            user_id = matching_idle_ids[0]

    old_ws = room["conns"].get(user_id)
    if old_ws is not None and old_ws is not websocket:
        room["conns"].pop(user_id, None)

    reconnected_existing_user = user_id != generated_user_id
    is_host = room["host_id"] is None
    if is_host:
        room["host_id"] = user_id

    room["conns"][user_id] = websocket
    existing_info = room["info"].get(user_id, {})
    room["info"][user_id] = {
        "name": data["name"],
        "email": data.get("email", ""),
        "language": data["language"],
        "is_host": is_host or bool(existing_info.get("is_host")),
        "mic_on": False,
        "camera_on": False,
        "idle": False,
        "idle_since": None,
    }
    _voice_engine_register_participant(room_id, user_id, room["info"][user_id], replace=True)
    logger.info(
        "Conversation join: room=%s user=%s name=%r language=%s reconnected=%s",
        room_id, user_id, data["name"], data["language"], reconnected_existing_user,
    )

    # Confirm join with full room snapshot
    def _public_user(uid: str, info: dict) -> dict:
        return {
            "user_id": uid,
            "name": info.get("name", ""),
            "language": info.get("language", "en"),
            "is_host": bool(info.get("is_host")),
            "mic_on": bool(info.get("mic_on")),
            "camera_on": bool(info.get("camera_on")),
            "idle": bool(info.get("idle")),
            "idle_since": info.get("idle_since"),
        }

    async def _broadcast_room_snapshot():
        snapshot = [_public_user(uid, info) for uid, info in room["info"].items()]
        for _, ws in list(room["conns"].items()):
            if not ws:
                continue
            try:
                await ws.send_json({"type": "room_snapshot", "users": snapshot})
            except Exception:
                pass

    await websocket.send_json({
        "type": "joined",
        "user_id": user_id,
        "room": room_id,
        "is_host": bool(room["info"][user_id].get("is_host")),
        "users": [_public_user(uid, info) for uid, info in room["info"].items()],
    })

    # Announce arrival to everyone already in the room
    new_user = _public_user(user_id, room["info"][user_id])
    for uid, ws in list(room["conns"].items()):
        if uid != user_id:
            try:
                if not reconnected_existing_user:
                    await ws.send_json({"type": "user_joined", "user": new_user})
                await ws.send_json({
                    "type": "user_idle_status",
                    "user_id": user_id,
                    "is_idle": False,
                    "idle_since": None,
                })
            except Exception:
                pass

    explicit_leave = False
    try:
        while True:
            raw = await websocket.receive_text()
            if room["conns"].get(user_id) is not websocket:
                break
            data = json.loads(raw)
            msg_type = data.get("type")

            if msg_type == "speech":
                text = data.get("text", "").strip()
                if not text:
                    continue

                my_info = room["info"].get(user_id)
                if not my_info:
                    continue

                # Voice preservation: update style profile from this utterance
                _sample = style_profiler.analyze(text)
                my_info["style_profile"] = style_profiler.accumulate(
                    my_info.get("style_profile"), _sample
                )
                _style_hint = style_profiler.to_prompt_hint(my_info["style_profile"])

                # Echo original back to speaker
                await websocket.send_json({
                    "type": "message",
                    "from_id": user_id,
                    "from": my_info["name"],
                    "original": text,
                    "translation": text,
                    "is_self": True,
                })

                delivered_by_voice_engine = await _send_voice_engine_room_outputs(
                    room_id, user_id, text, my_info["name"],
                )
                if not delivered_by_voice_engine:
                    # Fallback keeps the existing text/browser-TTS path alive
                    # if VOICE ENGINE is unavailable or rejects the utterance.
                    speaker_has_clone = voice_clone.has_enrollment(user_id) and voice_clone.is_available()
                    for other_id, other_ws in list(room["conns"].items()):
                        if other_id == user_id or not other_ws:
                            continue
                        other_info = room["info"].get(other_id)
                        if not other_info:
                            continue
                        try:
                            if other_info["language"] == my_info["language"]:
                                translated = text
                            else:
                                result = await asyncio.to_thread(
                                    run_conversation_pipeline,
                                    text,
                                    my_info["language"],
                                    other_info["language"],
                                    _style_hint,
                                )
                                translated = result.get("translation", text)

                            await other_ws.send_json({
                                "type": "message",
                                "from_id": user_id,
                                "from": my_info["name"],
                                "original": text,
                                "translation": translated,
                                "is_self": False,
                            })

                            if speaker_has_clone:
                                asyncio.create_task(_send_voice_clone_audio(
                                    other_ws, user_id, translated, other_info["language"],
                                ))
                        except Exception as e:
                            logger.error(f"Translation error for {other_id}: {e}")

            elif msg_type == "interim":
                my_info = room["info"].get(user_id)
                if not my_info:
                    continue
                for other_id, other_ws in list(room["conns"].items()):
                    if other_id == user_id or not other_ws:
                        continue
                    try:
                        await other_ws.send_json({
                            "type": "interim",
                            "from_id": user_id,
                            "from": my_info["name"],
                            "text": data.get("text", ""),
                        })
                    except Exception:
                        pass

            elif msg_type == "typing":
                my_info = room["info"].get(user_id)
                if not my_info:
                    continue
                for other_id, other_ws in list(room["conns"].items()):
                    if other_id == user_id or not other_ws:
                        continue
                    try:
                        await other_ws.send_json({
                            "type": "typing",
                            "user_id": user_id,
                            "name": my_info["name"],
                            "is_typing": bool(data.get("is_typing", False)),
                        })
                    except Exception:
                        pass

            elif msg_type == "keyboard":
                text = data.get("text", "").strip()
                if not text:
                    continue

                my_info = room["info"].get(user_id)
                if not my_info:
                    continue

                # Echo original back to sender
                await websocket.send_json({
                    "type": "message",
                    "from_id": user_id,
                    "from": my_info["name"],
                    "original": text,
                    "translation": text,
                    "is_self": True,
                })

                # Translate via conversation pipeline and deliver to every other participant
                for other_id, other_ws in list(room["conns"].items()):
                    if other_id == user_id or not other_ws:
                        continue
                    other_info = room["info"].get(other_id)
                    if not other_info:
                        continue
                    try:
                        if other_info["language"] == my_info["language"]:
                            translated = text
                        else:
                            result = await asyncio.to_thread(
                                run_conversation_pipeline,
                                text,
                                my_info["language"],
                                other_info["language"],
                            )
                            translated = result.get("translation", text)

                        await other_ws.send_json({
                            "type": "message",
                            "from_id": user_id,
                            "from": my_info["name"],
                            "original": text,
                            "translation": translated,
                            "is_self": False,
                        })
                    except Exception as e:
                        logger.error(f"Keyboard translation error for {other_id}: {e}")

            elif msg_type == "mic_status":
                is_on = bool(data.get("is_on", False))
                if user_id in room["info"]:
                    room["info"][user_id]["mic_on"] = is_on
                for other_id, other_ws in list(room["conns"].items()):
                    if other_id == user_id or not other_ws:
                        continue
                    try:
                        await other_ws.send_json({
                            "type": "user_mic_status",
                            "user_id": user_id,
                            "is_on": is_on,
                        })
                    except Exception:
                        pass

            elif msg_type == "camera_status":
                is_on = bool(data.get("is_on", False))
                if user_id in room["info"]:
                    room["info"][user_id]["camera_on"] = is_on
                for other_id, other_ws in list(room["conns"].items()):
                    if other_id == user_id or not other_ws:
                        continue
                    try:
                        await other_ws.send_json({
                            "type": "user_camera_status",
                            "user_id": user_id,
                            "is_on": is_on,
                        })
                    except Exception:
                        pass

            elif msg_type == "presence":
                is_idle = bool(data.get("is_idle", False))
                if user_id in room["info"]:
                    room["info"][user_id]["idle"] = is_idle
                    room["info"][user_id]["idle_since"] = (
                        room["info"][user_id].get("idle_since") or time.time()
                    ) if is_idle else None
                    if is_idle:
                        room["info"][user_id]["mic_on"] = False
                        room["info"][user_id]["camera_on"] = False
                for other_id, other_ws in list(room["conns"].items()):
                    if not other_ws:
                        continue
                    try:
                        await other_ws.send_json({
                            "type": "user_idle_status",
                            "user_id": user_id,
                            "is_idle": is_idle,
                            "idle_since": room["info"].get(user_id, {}).get("idle_since"),
                        })
                    except Exception:
                        pass
                await _broadcast_room_snapshot()

            elif msg_type == "sync_users":
                await websocket.send_json({
                    "type": "room_snapshot",
                    "users": [_public_user(uid, info) for uid, info in room["info"].items()],
                })

            elif msg_type == "leave":
                explicit_leave = True
                break

    except WebSocketDisconnect:
        pass
    finally:
        user_name = (room["info"].get(user_id) or {}).get("name", "Someone")
        user_was_host = room.get("host_id") == user_id

        if room["conns"].get(user_id) is not websocket:
            return

        room["conns"].pop(user_id, None)

        user_info = room["info"].get(user_id)
        preserve_as_idle = bool(user_info) and not explicit_leave
        if preserve_as_idle:
            user_info["idle"] = True
            user_info["idle_since"] = user_info.get("idle_since") or time.time()
            user_info["mic_on"] = False
            user_info["camera_on"] = False
        else:
            room["info"].pop(user_id, None)
            _voice_engine_remove_participant(room_id, user_id)

        if user_was_host:
            # Host left or disconnected: hand off to the next user when
            # participants remain. Only mark ended when the host explicitly
            # leaves and nobody is left in the room.
            remaining = list(room["conns"].keys())
            if remaining:
                new_host_id = remaining[0]
                room["host_id"] = new_host_id
                if new_host_id in room["info"]:
                    room["info"][new_host_id]["is_host"] = True
                if preserve_as_idle and user_id in room["info"]:
                    room["info"][user_id]["is_host"] = False
                try:
                    await room["conns"][new_host_id].send_json({
                        "type": "host_changed",
                        "new_host_id": new_host_id,
                    })
                except Exception:
                    pass
            else:
                room["host_id"] = None
                if explicit_leave:
                    room["host_left"] = True

        # Notify remaining participants. Idle disconnects stay visible in the
        # roster; explicit leaves are removed from the room.
        for uid, ws in list(room["conns"].items()):
            if not ws:
                continue
            try:
                if preserve_as_idle:
                    await ws.send_json({
                        "type": "user_idle_status",
                        "user_id": user_id,
                        "is_idle": True,
                        "idle_since": room["info"].get(user_id, {}).get("idle_since"),
                    })
                else:
                    await ws.send_json({"type": "user_left", "user_id": user_id, "name": user_name})
            except Exception:
                pass
        await _broadcast_room_snapshot()

        if not room["conns"] and not room["info"]:
            room["empty_since"] = time.time()
            _voice_engine_dispose_room(room_id)
        elif room["info"]:
            room["empty_since"] = None


@app.post("/detect_language")
async def detect_language_endpoint(text: str):
    """Routes every keystroke through the Language Detection Agent."""
    detected = language_detection_agent.run(text)
    return {"detected_language": detected}


@app.post("/translate_text")
async def translate_text(source: str, target: str, text: str):
    result = run_text_pipeline(text, source, target)
    return result


@app.post("/translate_audio")
async def translate_audio(source: str, target: str, file: UploadFile):
    filepath = f"temp_{file.filename}"
    with open(filepath, "wb") as f:
        f.write(await file.read())

    result = run_audio_pipeline(filepath, source, target)

    if os.path.exists(filepath):
        os.remove(filepath)

    return result


async def inject_speech(room_id: str, user_id: str, text: str,
                        fallback_name: str = "", fallback_language: str = "en"):
    """Inject a Google-STT transcript into a conversation room.
    Echoes the original to the speaker and runs the per-participant
    translation pipeline for every other participant.

    `fallback_name`/`fallback_language` come from the STT WebSocket's own
    config so translations still flow when the speaker's conversation WS
    has briefly dropped (e.g. just after a Render redeploy wiped state)."""
    if _is_echo(room_id, text):
        logger.info("inject_speech: echo dropped room=%s user=%s text=%r",
                    room_id, user_id, text[:60])
        return
    logger.info("inject_speech: room=%s user=%s text=%r", room_id, user_id, text[:60])
    room = _rooms.get(room_id)
    if not room:
        logger.warning("inject_speech: room %s not found", room_id)
        return
    my_info = room["info"].get(user_id)
    info_missing = my_info is None
    if info_missing:
        logger.warning("inject_speech: user %s not in room %s — using STT fallback name=%r lang=%s. known=%s",
                       user_id, room_id, fallback_name, fallback_language,
                       list(room["info"].keys()))
        my_info = {
            "name": fallback_name or "Speaker",
            "language": fallback_language or "en",
            "style_profile": None,
        }

    # ── Interruption detection ──────────────────────────────────────────────────
    # If another participant's utterance is still being processed, broadcast an
    # `interrupted` event so all clients can visually flag the overlap.
    speaking = room.setdefault("speaking", {})
    other_speakers = [uid for uid in list(speaking.keys()) if uid != user_id]
    if other_speakers:
        interrupted_id = other_speakers[0]
        interrupted_name = (room["info"].get(interrupted_id) or {}).get("name", "")
        if interrupted_name:
            for ws in list(room["conns"].values()):
                try:
                    await ws.send_json({
                        "type": "interrupted",
                        "interrupted_user_id": interrupted_id,
                        "interrupted_by_id": user_id,
                        "interrupted_name": interrupted_name,
                        "by_name": (room["info"].get(user_id) or {}).get("name", ""),
                    })
                except Exception:
                    pass
        speaking.pop(interrupted_id, None)
    speaking[user_id] = time.monotonic()

    # ── Voice preservation: update speaker style profile ──────────────────────
    sample = style_profiler.analyze(text)
    my_info["style_profile"] = style_profiler.accumulate(
        my_info.get("style_profile"), sample
    )
    style_hint = style_profiler.to_prompt_hint(my_info["style_profile"])

    # Record the original now so any STT pickup of our own speech is detected.
    _record_broadcast(room_id, text)

    speaker_ws = room["conns"].get(user_id)
    if speaker_ws:
        try:
            await speaker_ws.send_json({
                "type": "message", "from_id": user_id,
                "from": my_info["name"], "original": text,
                "translation": text, "is_self": True,
            })
        except Exception:
            pass

    delivered_by_voice_engine = await _send_voice_engine_room_outputs(
        room_id, user_id, text, my_info["name"],
    )
    if not delivered_by_voice_engine:
        # Fallback keeps the existing text/browser-TTS path alive if VOICE
        # ENGINE is unavailable or rejects the utterance.
        async def _translate_and_send(other_id: str, other_ws, other_info):
            try:
                if other_info["language"] == my_info["language"]:
                    translated = text
                else:
                    result = await asyncio.to_thread(
                        run_conversation_pipeline,
                        text, my_info["language"], other_info["language"],
                        style_hint,
                    )
                    translated = result.get("translation", text)
                _record_broadcast(room_id, translated)
                await other_ws.send_json({
                    "type": "message", "from_id": user_id,
                    "from": my_info["name"], "original": text,
                    "translation": translated, "is_self": False,
                })
            except Exception as e:
                logger.error("Translation error for %s: %s", other_id, e)

        tasks = []
        for other_id, other_ws in list(room["conns"].items()):
            if other_id == user_id or not other_ws:
                continue
            other_info = room["info"].get(other_id)
            if not other_info:
                continue
            tasks.append(_translate_and_send(other_id, other_ws, other_info))
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    # Clear speaking state now that all translations have been delivered
    room.setdefault("speaking", {}).pop(user_id, None)


@app.websocket("/ws/voice-engine/{room_id}/{user_id}")
@app.websocket("/ws/stt/{room_id}/{user_id}")
async def stt_stream_endpoint(websocket: WebSocket, room_id: str, user_id: str,
                               api_key: str = ""):
    """Conversation live-audio endpoint.

    Binary frames arriving from the browser contain raw LINEAR16 PCM audio
    at the device's native sample rate. Frames are fed into the VOICE ENGINE
    room orchestrator immediately. Until the packaged native ASR replaces this
    adapter, a daemon thread also feeds those frames into Google Cloud
    streaming_recognize and commits each final transcript through the same
    VOICE ENGINE room pipeline. Sessions restart automatically every 4.5 min
    to stay before Google's hard 5-min limit.
    """
    if not _GOOGLE_STT_AVAILABLE:
        await websocket.close(code=1011, reason="google-cloud-speech not installed")
        return

    # API key check for STT WebSocket (key passed as ?api_key= query param)
    if security.is_production():
        _stt_key = api_key or websocket.query_params.get("api_key", "")
        import hmac as _hmac
        if not _hmac.compare_digest(
            _stt_key.encode("utf-8", errors="replace"),
            security.get_api_key().encode("utf-8"),
        ):
            await websocket.close(code=4403, reason="Unauthorized")
            return

    await websocket.accept()
    loop = asyncio.get_running_loop()
    audio_q: _queue.Queue = _queue.Queue(maxsize=200)
    stop_evt = threading.Event()

    # First message must be JSON: { "sample_rate": 44100, "language": "tl" }
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)
        cfg = json.loads(raw)
        sample_rate = int(cfg.get("sample_rate", 16000))
        language = cfg.get("language", "en")
    except WebSocketDisconnect:
        return  # client disconnected before sending config — nothing to close
    except Exception as e:
        logger.error("STT config error: %s", e)
        try:
            await websocket.close()
        except Exception:
            pass
        return

    # Validate Google credentials early — fail fast with a clear close reason.
    try:
        _make_speech_client()
    except Exception as e:
        logger.error("Google STT credentials error: %s", e)
        await websocket.close(code=1011, reason="Google STT credentials not configured")
        return

    # Cache the speaker's display name so inject_speech can still label
    # broadcasts if the speaker's conversation WS drops mid-session
    # (e.g. after a Render redeploy wipes _rooms).
    _cached_room = _rooms.get(room_id)
    speaker_name = ""
    if _cached_room:
        speaker_info = _cached_room["info"].get(user_id) or {}
        speaker_name = speaker_info.get("name", "")
        room_language = speaker_info.get("language")
        if room_language and room_language != language:
            logger.warning(
                "STT language override: room=%s user=%s client_lang=%s room_lang=%s",
                room_id, user_id, language, room_language,
            )
            language = room_language

    lang_code = _GOOGLE_LANG.get(language, "en-US")

    logger.info("STT session opening: room=%s user=%s requested_lang=%s lang=%s rate=%d",
                room_id, user_id, language, lang_code, sample_rate)

    def run_stt():
        nonlocal speaker_name
        client = _make_speech_client()
        cfg_kwargs = dict(
            encoding=_google_speech.RecognitionConfig.AudioEncoding.LINEAR16,
            sample_rate_hertz=sample_rate,
            language_code=lang_code,
            enable_automatic_punctuation=True,
        )
        if lang_code in _LATEST_LONG_LANGS:
            cfg_kwargs["model"] = "latest_long"
            cfg_kwargs["use_enhanced"] = True
        stt_cfg = _google_speech.RecognitionConfig(**cfg_kwargs)
        # single_utterance=True is required for fast per-pause finalization.
        # Without it, Google holds all speech in one giant transcript until a
        # very long silence — making subsequent utterances appear "not picked
        # up" until the speaker mutes. With single_utterance=True the inner
        # for-loop ends on each natural pause; the outer while-loop spins up
        # a fresh session so streaming continues through the whole mic-on
        # period. The 270 s deadline below caps a single session length to
        # stay under Google's 5-min hard limit.
        streaming_cfg = _google_speech.StreamingRecognitionConfig(
            config=stt_cfg, interim_results=False, single_utterance=True,
        )
        SESSION_SECS = 270  # restart before Google's 5-min hard limit
        consecutive_errors = 0
        last_emit = {"text": "", "ts": 0.0}
        session_idx = [0]

        while not stop_evt.is_set():
            first_chunk_logged = False
            speech_event_ts = [0.0]  # set when END_OF_SINGLE_UTTERANCE fires

            def _gen():
                nonlocal first_chunk_logged
                deadline = time.monotonic() + SESSION_SECS
                while not stop_evt.is_set():
                    # Safety: if Google sent END_OF_SINGLE_UTTERANCE but never
                    # followed it with a final transcript, end the session so
                    # the outer loop spins up a fresh recognizer instead of
                    # hanging on stale audio.
                    if speech_event_ts[0] and time.monotonic() - speech_event_ts[0] > 1.5:
                        return
                    left = deadline - time.monotonic()
                    if left <= 0:
                        return
                    try:
                        chunk = audio_q.get(timeout=min(0.1, left))
                        if chunk is None:
                            return
                        if not first_chunk_logged:
                            logger.info("STT first audio chunk (room=%s user=%s, %d bytes)",
                                        room_id, user_id, len(chunk))
                            first_chunk_logged = True
                        yield _google_speech.StreamingRecognizeRequest(audio_content=chunk)
                    except _queue.Empty:
                        continue

            session_idx_local = session_idx[0] = session_idx[0] + 1
            logger.info("STT session %d starting (room=%s user=%s)",
                        session_idx_local, room_id, user_id)
            try:
                first_resp_logged = False
                for resp in client.streaming_recognize(config=streaming_cfg, requests=_gen()):
                    if not first_resp_logged:
                        logger.info("STT session %d first Google response", session_idx_local)
                        first_resp_logged = True
                    sev = getattr(resp, "speech_event_type", None)
                    if sev:
                        logger.info("STT session %d speech_event=%s", session_idx_local, sev)
                        if not speech_event_ts[0]:
                            speech_event_ts[0] = time.monotonic()
                    for result in resp.results:
                        if not result.is_final:
                            continue
                        if not result.alternatives:
                            continue
                        alt = result.alternatives[0]
                        transcript = (alt.transcript or "").strip()
                        confidence = float(getattr(alt, "confidence", 0.0) or 0.0)
                        if _is_likely_hallucination(transcript):
                            logger.info("STT dropped hallucination (sess=%d): %r",
                                        session_idx_local, transcript[:80])
                            continue
                        norm = transcript.strip().lower()
                        if confidence and confidence < 0.6:
                            logger.info("STT accepting low-confidence (sess=%d) %.2f: %r",
                                        session_idx_local, confidence, transcript[:80])
                        now_ts = time.monotonic()
                        if norm == last_emit["text"] and now_ts - last_emit["ts"] < 5.0:
                            logger.info("STT dedup duplicate within 5s: %r", transcript[:60])
                            continue
                        last_emit["text"] = norm
                        last_emit["ts"] = now_ts
                        logger.info("STT final (sess=%d): room=%s user=%s conf=%.2f text=%r",
                                    session_idx_local, room_id, user_id, confidence, transcript[:100])
                        # Refresh the cached name if the speaker has since
                        # (re)joined — gives inject_speech the right label
                        # even after a temporary conv-WS drop.
                        _r = _rooms.get(room_id)
                        if _r:
                            _n = (_r["info"].get(user_id) or {}).get("name")
                            if _n:
                                speaker_name = _n
                        asyncio.run_coroutine_threadsafe(
                            inject_speech(room_id, user_id, transcript,
                                          fallback_name=speaker_name,
                                          fallback_language=language),
                            loop,
                        )
                logger.info("STT session %d ended cleanly", session_idx_local)
                consecutive_errors = 0
            except Exception as e:
                if stop_evt.is_set():
                    return
                consecutive_errors += 1
                logger.warning(
                    "STT session reset (%s: %s) [%d], restarting",
                    type(e).__name__, str(e)[:200], consecutive_errors,
                )
                if consecutive_errors >= 5:
                    logger.error("STT giving up after %d consecutive errors", consecutive_errors)
                    return
                time.sleep(min(2.0, 0.2 * consecutive_errors))

    threading.Thread(target=run_stt, daemon=True).start()

    rx_frames = 0
    rx_bytes = 0
    try:
        while True:
            data = await websocket.receive_bytes()
            rx_frames += 1
            rx_bytes += len(data)
            if rx_frames in (1, 25, 250):
                logger.info("STT WS rx: room=%s user=%s frames=%d bytes=%d",
                            room_id, user_id, rx_frames, rx_bytes)
            try:
                audio_q.put_nowait(data)
            except _queue.Full:
                pass  # drop frame — client sent faster than STT can consume
            await _voice_engine_accept_pcm_frame(
                room_id=room_id,
                user_id=user_id,
                pcm16=data,
                sample_rate_hz=sample_rate,
                timestamp_ms=int(time.time() * 1000),
                sequence=rx_frames,
            )
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("STT WS error: %s", e)
    finally:
        logger.info("STT WS closed: room=%s user=%s rx_frames=%d rx_bytes=%d",
                    room_id, user_id, rx_frames, rx_bytes)
        stop_evt.set()
        audio_q.put(None)


@app.post("/transcribe_audio")
async def transcribe_audio_only(source: str, file: UploadFile):
    """Transcribe-only endpoint for the iOS hot-mic pipeline.
    Returns {"text": "..."} — no translation. The caller sends the text
    to the conversation WebSocket as a speech message so the per-participant
    translation pipeline runs normally."""
    filepath = f"temp_conv_{file.filename}"
    with open(filepath, "wb") as f:
        f.write(await file.read())
    try:
        lang = None if source in ("auto", "") else source
        result = await asyncio.to_thread(transcription_agent.run, filepath, lang)
    finally:
        if os.path.exists(filepath):
            os.remove(filepath)
    return {"text": result["text"]}


# Serve the frontend as static files
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=False), name="frontend")
