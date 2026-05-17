from __future__ import annotations

from threading import Lock


class GroqClientFactory:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self._client = None
        self._lock = Lock()

    def client(self):
        with self._lock:
            if self._client is None:
                from groq import Groq

                self._client = Groq(api_key=self.api_key)
            return self._client
