import asyncio
import json
import os
import tempfile
from typing import TYPE_CHECKING

from speech import speech_to_text
from translator import translate

if TYPE_CHECKING:
    from room_manager import RoomManager, Participant


class SpeakerOrchestrator:
    """
    One instance per speaking event per participant.

    Pipeline for each unmute → mute cycle:
      1. receive full audio bytes
      2. Whisper STT  → transcript
      3. Groq translate (in parallel, one task per listener)
      4. Deliver translated text + trigger TTS on each listener's client

    Create a new instance each time a participant starts speaking.
    Call process() once with the complete audio recording.
    Blocking STT and translate calls run in the default executor so
    the event loop stays free to handle other WebSocket messages.
    """

    def __init__(
        self,
        speaker_id: str,
        speaker_name: str,
        speaker_lang: str,
        room_code: str,
        room_manager: "RoomManager",
    ):
        self.speaker_id = speaker_id
        self.speaker_name = speaker_name
        self.speaker_lang = speaker_lang
        self.room_code = room_code
        self.room_manager = room_manager

    async def process(self, audio_bytes: bytes):
        """Transcribe → translate per listener → deliver.  Returns immediately if audio is silent/empty."""
        transcript = await self._transcribe(audio_bytes)
        if not transcript:
            return

        room = self.room_manager.get_room(self.room_code)
        if not room:
            return

        listeners = [
            p for pid, p in room.participants.items()
            if pid != self.speaker_id
        ]
        if not listeners:
            return

        await asyncio.gather(
            *[self._translate_and_deliver(listener, transcript) for listener in listeners],
            return_exceptions=True,
        )

    async def _transcribe(self, audio_bytes: bytes) -> str:
        loop = asyncio.get_event_loop()
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
                tmp.write(audio_bytes)
                tmp_path = tmp.name
            result = await loop.run_in_executor(None, speech_to_text, tmp_path)
            return result.get("text", "").strip()
        except Exception:
            return ""
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)

    async def _translate_and_deliver(self, listener: "Participant", transcript: str):
        target_lang = listener.lang
        loop = asyncio.get_event_loop()
        try:
            if target_lang == self.speaker_lang:
                translated = transcript
            else:
                translated = await loop.run_in_executor(
                    None, translate, transcript, self.speaker_lang, target_lang
                )
            await listener.ws.send_text(json.dumps({
                "type": "speaker_translation",
                "speaker_id": self.speaker_id,
                "speaker_name": self.speaker_name,
                "original": transcript,
                "translation": translated,
                "target_lang": target_lang,
            }))
        except Exception:
            pass
