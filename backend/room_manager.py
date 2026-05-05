import json
import random
import string
from typing import Optional

from fastapi import WebSocket


class Participant:
    def __init__(
        self,
        participant_id: str,
        name: str,
        lang: str,
        ws: WebSocket,
        is_host: bool = False,
    ):
        self.participant_id = participant_id
        self.name = name
        self.lang = lang
        self.ws = ws
        self.is_host = is_host


class Room:
    def __init__(self, code: str):
        self.code = code
        self.participants: dict[str, Participant] = {}

    def to_participant_list(self) -> list[dict]:
        return [
            {
                "id": p.participant_id,
                "name": p.name,
                "lang": p.lang,
                "is_host": p.is_host,
            }
            for p in self.participants.values()
        ]


class RoomManager:
    def __init__(self):
        self._rooms: dict[str, Room] = {}

    def create_room(self) -> str:
        while True:
            code = "".join(random.choices(string.digits, k=6))
            if code not in self._rooms:
                self._rooms[code] = Room(code)
                return code

    def get_room(self, code: str) -> Optional[Room]:
        return self._rooms.get(code)

    def join_room(
        self, code: str, participant: Participant
    ) -> tuple[bool, str, bool]:
        """
        Returns (success, error_message, is_reconnect).

        Reconnect: same participant_id → update WebSocket, allow re-entry.
        Duplicate: different participant_id with same name → reject.
        """
        room = self._rooms.get(code)
        if not room:
            return False, "Room not found", False

        existing = room.participants.get(participant.participant_id)
        if existing:
            existing.ws = participant.ws
            existing.lang = participant.lang
            return True, "", True

        for p in room.participants.values():
            if p.name.strip().lower() == participant.name.strip().lower():
                return False, "Name already taken in this room", False

        room.participants[participant.participant_id] = participant
        return True, "", False

    def leave_room(self, code: str, participant_id: str) -> str:
        """Remove participant and return their name. Cleans up empty rooms."""
        room = self._rooms.get(code)
        if not room:
            return ""
        p = room.participants.pop(participant_id, None)
        if not room.participants:
            del self._rooms[code]
        return p.name if p else ""

    async def broadcast(
        self, code: str, message: dict, exclude_id: Optional[str] = None
    ):
        room = self._rooms.get(code)
        if not room:
            return
        text = json.dumps(message)
        for pid, p in list(room.participants.items()):
            if pid == exclude_id:
                continue
            try:
                await p.ws.send_text(text)
            except Exception:
                pass

    async def send_to(self, code: str, participant_id: str, message: dict):
        room = self._rooms.get(code)
        if not room:
            return
        p = room.participants.get(participant_id)
        if not p:
            return
        try:
            await p.ws.send_text(json.dumps(message))
        except Exception:
            pass


room_manager = RoomManager()
