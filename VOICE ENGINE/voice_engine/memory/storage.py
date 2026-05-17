from __future__ import annotations

import hashlib
import math
import os
from pathlib import Path
from typing import Protocol

from .translation_memory import TranslationMemoryEntry, TranslationMemoryMatch


DEFAULT_VECTOR_DIMENSION = 384


def default_memory_path() -> Path:
    configured = os.getenv("VOICE_ENGINE_TRANSLATION_MEMORY_PATH")
    if configured:
        return Path(configured).expanduser()

    package_root = Path(__file__).resolve().parents[2]
    if package_root.name == "VOICE ENGINE":
        return package_root / "data" / "translation_memory" / "approved_corrections.jsonl"

    return Path.home() / ".voice_engine" / "translation_memory" / "approved_corrections.jsonl"


def default_training_path() -> Path:
    configured = os.getenv("VOICE_ENGINE_TRAINING_DATASET_PATH")
    if configured:
        return Path(configured).expanduser()

    package_root = Path(__file__).resolve().parents[2]
    if package_root.name == "VOICE ENGINE":
        return package_root / "data" / "training" / "feedback_corrections.jsonl"

    return Path.home() / ".voice_engine" / "training" / "feedback_corrections.jsonl"


class TextVectorizer:
    """Deterministic local text vectorizer for fast retrieval and Pinecone upsert."""

    def __init__(self, dimension: int = DEFAULT_VECTOR_DIMENSION):
        self.dimension = dimension

    def vectorize(self, text: str) -> list[float]:
        vector = [0.0] * self.dimension
        normalized = " ".join(text.lower().split())
        if not normalized:
            return vector
        tokens = normalized.split()
        for token in tokens:
            self._add_token(vector, token, 1.0)
        for left, right in zip(tokens, tokens[1:]):
            self._add_token(vector, f"{left} {right}", 0.65)
        norm = math.sqrt(sum(value * value for value in vector))
        if norm <= 0:
            return vector
        return [value / norm for value in vector]

    def similarity(self, left: list[float], right: list[float]) -> float:
        return sum(a * b for a, b in zip(left, right))

    def _add_token(self, vector: list[float], token: str, weight: float) -> None:
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
        index = int.from_bytes(digest[:4], "big") % self.dimension
        sign = 1.0 if digest[4] % 2 == 0 else -1.0
        vector[index] += sign * weight


class VectorMemoryStore(Protocol):
    def upsert(self, entry: TranslationMemoryEntry) -> None:
        ...

    def query(
        self,
        source_text: str,
        source_language: str,
        target_language: str,
        namespace: str,
        domain: str,
        top_k: int = 3,
    ) -> list[TranslationMemoryMatch]:
        ...


class LocalVectorMemoryStore:
    """In-process vector index backed by the same persistent JSONL memory file."""

    def __init__(self, vectorizer: TextVectorizer | None = None, min_similarity: float = 0.82):
        self.vectorizer = vectorizer or TextVectorizer()
        self.min_similarity = min_similarity
        self._records: list[tuple[TranslationMemoryEntry, list[float]]] = []

    def load(self, entries: tuple[TranslationMemoryEntry, ...]) -> None:
        self._records = []
        for entry in entries:
            self.upsert(entry)

    def upsert(self, entry: TranslationMemoryEntry) -> None:
        self._records.append((entry, self.vectorizer.vectorize(entry.source_text)))

    def query(
        self,
        source_text: str,
        source_language: str,
        target_language: str,
        namespace: str,
        domain: str,
        top_k: int = 3,
    ) -> list[TranslationMemoryMatch]:
        query_vector = self.vectorizer.vectorize(source_text)
        source_lang = source_language.strip().lower()
        target_lang = target_language.strip().lower()
        matches: list[TranslationMemoryMatch] = []
        for entry, vector in self._records:
            if entry.normalized_source_language != source_lang:
                continue
            if entry.normalized_target_language != target_lang:
                continue
            if entry.namespace not in {namespace, "global"}:
                continue
            if entry.domain not in {domain, "general"}:
                continue
            similarity = self.vectorizer.similarity(query_vector, vector)
            if similarity < self.min_similarity:
                continue
            matches.append(
                TranslationMemoryMatch(
                    entry=entry,
                    similarity=similarity,
                    confidence=min(1.0, max(entry.confidence, similarity)),
                    exact=False,
                )
            )
        matches.sort(key=lambda match: match.confidence, reverse=True)
        return matches[:top_k]


class PineconeVectorMemoryStore:
    """Optional Pinecone vector mirror for approved translation memory."""

    def __init__(
        self,
        api_key: str,
        index_name: str | None = None,
        host: str | None = None,
        namespace: str = "voice-engine-translation-memory",
        vectorizer: TextVectorizer | None = None,
        min_similarity: float = 0.82,
    ):
        self.namespace = namespace
        self.vectorizer = vectorizer or TextVectorizer()
        self.min_similarity = min_similarity
        self._index = self._connect(api_key=api_key, index_name=index_name, host=host)

    @classmethod
    def from_environment(cls) -> PineconeVectorMemoryStore | None:
        api_key = os.getenv("VOICE_ENGINE_PINECONE_API_KEY")
        index_name = os.getenv("VOICE_ENGINE_PINECONE_INDEX")
        host = os.getenv("VOICE_ENGINE_PINECONE_HOST")
        if not api_key or not (index_name or host):
            return None
        namespace = os.getenv("VOICE_ENGINE_PINECONE_NAMESPACE", "voice-engine-translation-memory")
        return cls(api_key=api_key, index_name=index_name, host=host, namespace=namespace)

    def upsert(self, entry: TranslationMemoryEntry) -> None:
        vector_id = self._entry_id(entry)
        metadata = {
            "record_type": "voice_engine_translation_memory",
            "source_text": entry.source_text,
            "target_text": entry.target_text,
            "source_language": entry.source_language,
            "target_language": entry.target_language,
            "normalized_source_language": entry.normalized_source_language,
            "normalized_target_language": entry.normalized_target_language,
            "namespace": entry.namespace,
            "domain": entry.domain,
            "approved": entry.approved,
            "confidence": entry.confidence,
            "created_at": entry.created_at,
        }
        for key, value in entry.metadata.items():
            metadata[f"meta_{key}"] = str(value)
        self._index.upsert(
            vectors=[
                {
                    "id": vector_id,
                    "values": self.vectorizer.vectorize(entry.source_text),
                    "metadata": metadata,
                }
            ],
            namespace=self.namespace,
        )

    def query(
        self,
        source_text: str,
        source_language: str,
        target_language: str,
        namespace: str,
        domain: str,
        top_k: int = 3,
    ) -> list[TranslationMemoryMatch]:
        response = self._index.query(
            vector=self.vectorizer.vectorize(source_text),
            top_k=top_k,
            include_metadata=True,
            namespace=self.namespace,
            filter={
                "normalized_source_language": {"$eq": source_language.strip().lower()},
                "normalized_target_language": {"$eq": target_language.strip().lower()},
            },
        )
        raw_matches = response.get("matches", []) if isinstance(response, dict) else getattr(response, "matches", [])
        matches: list[TranslationMemoryMatch] = []
        for raw in raw_matches:
            score = raw.get("score", 0.0) if isinstance(raw, dict) else getattr(raw, "score", 0.0)
            if score < self.min_similarity:
                continue
            metadata = raw.get("metadata", {}) if isinstance(raw, dict) else getattr(raw, "metadata", {})
            entry = self._entry_from_metadata(metadata)
            if entry is None:
                continue
            if entry.namespace not in {namespace, "global"}:
                continue
            if entry.domain not in {domain, "general"}:
                continue
            matches.append(
                TranslationMemoryMatch(
                    entry=entry,
                    similarity=float(score),
                    confidence=min(1.0, max(entry.confidence, float(score))),
                    exact=False,
                )
            )
        return matches

    def _connect(self, api_key: str, index_name: str | None, host: str | None):
        try:
            from pinecone.grpc import PineconeGRPC as Pinecone
        except Exception:
            from pinecone import Pinecone

        client = Pinecone(api_key=api_key)
        if host:
            return client.Index(host=host)
        if not index_name:
            raise ValueError("Pinecone index_name or host is required")
        return client.Index(index_name)

    def _entry_id(self, entry: TranslationMemoryEntry) -> str:
        raw = "|".join(
            [
                entry.namespace,
                entry.domain,
                entry.normalized_source_language,
                entry.normalized_target_language,
                entry.normalized_source_text,
            ]
        )
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _entry_from_metadata(self, metadata: dict) -> TranslationMemoryEntry | None:
        required = {"source_text", "target_text", "source_language", "target_language"}
        if not required.issubset(metadata):
            return None
        user_metadata = {
            key.removeprefix("meta_"): str(value)
            for key, value in metadata.items()
            if str(key).startswith("meta_")
        }
        return TranslationMemoryEntry(
            source_text=str(metadata["source_text"]),
            target_text=str(metadata["target_text"]),
            source_language=str(metadata["source_language"]),
            target_language=str(metadata["target_language"]),
            namespace=str(metadata.get("namespace", "global")),
            domain=str(metadata.get("domain", "general")),
            approved=bool(metadata.get("approved", True)),
            confidence=float(metadata.get("confidence", 1.0)),
            created_at=float(metadata.get("created_at", 0.0)),
            metadata=user_metadata,
        )


class CompositeVectorMemoryStore:
    """Local-first vector store with optional external mirrors."""

    def __init__(self, local: LocalVectorMemoryStore, mirrors: list[VectorMemoryStore] | None = None):
        self.local = local
        self.mirrors = mirrors or []

    def upsert(self, entry: TranslationMemoryEntry) -> None:
        self.local.upsert(entry)
        for mirror in self.mirrors:
            try:
                mirror.upsert(entry)
            except Exception:
                continue

    def query(
        self,
        source_text: str,
        source_language: str,
        target_language: str,
        namespace: str,
        domain: str,
        top_k: int = 3,
    ) -> list[TranslationMemoryMatch]:
        local_matches = self.local.query(source_text, source_language, target_language, namespace, domain, top_k)
        if local_matches:
            return local_matches
        matches: list[TranslationMemoryMatch] = []
        for mirror in self.mirrors:
            try:
                matches.extend(mirror.query(source_text, source_language, target_language, namespace, domain, top_k))
            except Exception:
                continue
        matches.sort(key=lambda match: match.confidence, reverse=True)
        return matches[:top_k]
