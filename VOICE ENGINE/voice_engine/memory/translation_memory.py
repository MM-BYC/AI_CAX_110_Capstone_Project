from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from time import time
from typing import Any

from voice_engine.engines.translation import TranslationEngine
from voice_engine.models import CommittedPhrase, TranslationEvent


_SPACE_RE = re.compile(r"\s+")
_NUMBER_RE = re.compile(r"\b\d+(?:[.,]\d+)?\b")
_WORD_RE = re.compile(r"[\w']+", re.UNICODE)


def _normalize_text(value: str) -> str:
    return _SPACE_RE.sub(" ", value.strip().lower())


def _normalize_language(value: str) -> str:
    return value.strip().lower()


@dataclass(frozen=True)
class TranslationMemoryEntry:
    source_text: str
    target_text: str
    source_language: str
    target_language: str
    namespace: str = "global"
    domain: str = "general"
    approved: bool = True
    confidence: float = 1.0
    created_at: float = field(default_factory=time)
    metadata: dict[str, str] = field(default_factory=dict)

    @property
    def normalized_source_text(self) -> str:
        return _normalize_text(self.source_text)

    @property
    def normalized_source_language(self) -> str:
        return _normalize_language(self.source_language)

    @property
    def normalized_target_language(self) -> str:
        return _normalize_language(self.target_language)


@dataclass(frozen=True)
class TranslationMemoryMatch:
    entry: TranslationMemoryEntry
    similarity: float
    confidence: float
    exact: bool = False


@dataclass(frozen=True)
class ConfidenceDecision:
    confidence: float
    accepted: bool
    reason: str
    metadata: dict[str, str] = field(default_factory=dict)


class TranslationMemory:
    """Fast approved phrase memory for live translation.

    This is intentionally a local in-process index for the realtime path. A
    remote vector database can mirror these entries asynchronously, but network
    lookup should not be required before live audio can continue.
    """

    def __init__(
        self,
        entries: list[TranslationMemoryEntry] | None = None,
        min_similarity: float = 0.92,
        storage_path: Path | None = None,
        vector_store: Any | None = None,
    ):
        self.min_similarity = min_similarity
        self.storage_path = storage_path
        self._entries: list[TranslationMemoryEntry] = []
        if storage_path and storage_path.exists():
            self.load(storage_path)
        self.vector_store = vector_store
        if self.vector_store is not None:
            if hasattr(self.vector_store, "load"):
                self.vector_store.load(self.entries)
            else:
                for entry in self.entries:
                    self.vector_store.upsert(entry)
        for entry in entries or []:
            self.add(entry)

    @classmethod
    def create_default(
        cls,
        min_similarity: float = 0.92,
        enable_pinecone: bool = True,
    ) -> TranslationMemory:
        from .storage import (
            CompositeVectorMemoryStore,
            LocalVectorMemoryStore,
            PineconeVectorMemoryStore,
            default_memory_path,
        )

        local_vector_store = LocalVectorMemoryStore(min_similarity=max(0.70, min_similarity - 0.10))
        mirrors = []
        if enable_pinecone:
            pinecone_store = PineconeVectorMemoryStore.from_environment()
            if pinecone_store is not None:
                mirrors.append(pinecone_store)
        return cls(
            min_similarity=min_similarity,
            storage_path=default_memory_path(),
            vector_store=CompositeVectorMemoryStore(local=local_vector_store, mirrors=mirrors),
        )

    @classmethod
    def from_phrase_table(
        cls,
        phrase_table: dict[tuple[str, str, str], str],
        min_similarity: float = 0.92,
        namespace: str = "global",
        domain: str = "general",
    ) -> TranslationMemory:
        entries = [
            TranslationMemoryEntry(
                source_language=source_language,
                target_language=target_language,
                source_text=source_text,
                target_text=target_text,
                namespace=namespace,
                domain=domain,
            )
            for (source_language, target_language, source_text), target_text in phrase_table.items()
        ]
        return cls(entries=entries, min_similarity=min_similarity)

    def add(self, entry: TranslationMemoryEntry) -> None:
        if not entry.approved:
            return
        self._entries.append(entry)
        if getattr(self, "vector_store", None) is not None:
            self.vector_store.upsert(entry)

    @property
    def entries(self) -> tuple[TranslationMemoryEntry, ...]:
        return tuple(self._entries)

    def learn_correction(
        self,
        source_text: str,
        target_text: str,
        source_language: str,
        target_language: str,
        namespace: str = "global",
        domain: str = "general",
        metadata: dict[str, str] | None = None,
    ) -> TranslationMemoryEntry:
        entry = TranslationMemoryEntry(
            source_text=source_text,
            target_text=target_text,
            source_language=source_language,
            target_language=target_language,
            namespace=namespace,
            domain=domain,
            approved=True,
            confidence=1.0,
            metadata=metadata or {},
        )
        self.add(entry)
        if self.storage_path:
            self.save(self.storage_path)
        return entry

    def lookup(
        self,
        source_text: str,
        source_language: str,
        target_language: str,
        namespace: str = "global",
        domain: str = "general",
    ) -> TranslationMemoryMatch | None:
        normalized_source = _normalize_text(source_text)
        source_lang = _normalize_language(source_language)
        target_lang = _normalize_language(target_language)
        candidates = [
            entry
            for entry in self._entries
            if entry.normalized_source_language == source_lang
            and entry.normalized_target_language == target_lang
            and entry.namespace in {namespace, "global"}
            and entry.domain in {domain, "general"}
        ]
        best: TranslationMemoryMatch | None = None
        for entry in candidates:
            similarity = self._similarity(normalized_source, entry.normalized_source_text)
            exact = normalized_source == entry.normalized_source_text
            if similarity < self.min_similarity and not exact:
                continue
            confidence = min(1.0, max(entry.confidence, similarity))
            match = TranslationMemoryMatch(entry=entry, similarity=similarity, confidence=confidence, exact=exact)
            if best is None or match.confidence > best.confidence:
                best = match
        if best is None and getattr(self, "vector_store", None) is not None:
            vector_matches = self.vector_store.query(
                source_text=source_text,
                source_language=source_language,
                target_language=target_language,
                namespace=namespace,
                domain=domain,
                top_k=1,
            )
            if vector_matches:
                best = vector_matches[0]
        return best

    def save(self, path: Path | None = None) -> None:
        target = path or self.storage_path
        if target is None:
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("w", encoding="utf-8") as file:
            for entry in self._entries:
                file.write(json.dumps(asdict(entry), ensure_ascii=False) + "\n")

    def load(self, path: Path) -> None:
        with path.open("r", encoding="utf-8") as file:
            for line in file:
                if not line.strip():
                    continue
                self.add(TranslationMemoryEntry(**json.loads(line)))

    def _similarity(self, left: str, right: str) -> float:
        sequence = SequenceMatcher(None, left, right).ratio()
        left_tokens = set(_WORD_RE.findall(left))
        right_tokens = set(_WORD_RE.findall(right))
        if not left_tokens or not right_tokens:
            return sequence
        token_overlap = len(left_tokens & right_tokens) / max(len(left_tokens), len(right_tokens))
        return max(sequence, token_overlap)


class GrammarProfile:
    """Lightweight structural scorer learned from approved examples."""

    def __init__(self) -> None:
        self._length_ratios: dict[tuple[str, str], list[float]] = {}

    def learn(self, entry: TranslationMemoryEntry) -> None:
        source_words = max(1, len(_WORD_RE.findall(entry.source_text)))
        target_words = max(1, len(_WORD_RE.findall(entry.target_text)))
        key = (entry.normalized_source_language, entry.normalized_target_language)
        self._length_ratios.setdefault(key, []).append(target_words / source_words)

    def score(self, event: TranslationEvent) -> float:
        source_words = max(1, len(_WORD_RE.findall(event.source_text)))
        target_words = max(1, len(_WORD_RE.findall(event.target_text)))
        target_ratio = target_words / source_words
        ratios = self._length_ratios.get(
            (_normalize_language(event.source_language), _normalize_language(event.target_language)),
            [],
        )
        if not ratios:
            return self._generic_score(event, target_ratio)
        expected = sum(ratios) / len(ratios)
        distance = abs(target_ratio - expected)
        return max(0.0, min(1.0, 1.0 - (distance / max(expected, 0.1))))

    def _generic_score(self, event: TranslationEvent, target_ratio: float) -> float:
        if not event.target_text.strip():
            return 0.0
        if target_ratio < 0.25 or target_ratio > 4.0:
            return 0.45
        source_numbers = _NUMBER_RE.findall(event.source_text)
        target_numbers = _NUMBER_RE.findall(event.target_text)
        if any(number not in target_numbers for number in source_numbers):
            return 0.5
        return 0.86


class MemoryAugmentedTranslator:
    """Translator wrapper that applies approved memory and confidence scoring."""

    def __init__(
        self,
        base_translator: TranslationEngine,
        memory: TranslationMemory | None = None,
        grammar_profile: GrammarProfile | None = None,
        min_accept_confidence: float = 0.78,
        direct_match_confidence: float = 0.96,
        namespace: str = "global",
        domain: str = "general",
    ):
        self.base_translator = base_translator
        self.memory = memory or TranslationMemory()
        self.grammar_profile = grammar_profile or GrammarProfile()
        self.min_accept_confidence = min_accept_confidence
        self.direct_match_confidence = direct_match_confidence
        self.namespace = namespace
        self.domain = domain
        for entry in self.memory.entries:
            self.grammar_profile.learn(entry)

    async def translate(
        self,
        phrase: CommittedPhrase,
        source_language: str,
        target_language: str,
    ) -> TranslationEvent:
        match = self.memory.lookup(
            phrase.source_text,
            source_language=source_language,
            target_language=target_language,
            namespace=self.namespace,
            domain=self.domain,
        )
        if match and (match.exact or match.confidence >= self.direct_match_confidence):
            event = TranslationEvent(
                source_text=phrase.source_text,
                target_text=match.entry.target_text,
                confidence=min(1.0, (phrase.confidence * 0.55) + (match.confidence * 0.45)),
                source_language=source_language,
                target_language=target_language,
                metadata=self._metadata("memory", match, None),
            )
            return event

        base_event = await self.base_translator.translate(phrase, source_language, target_language)
        decision = self.score(phrase, base_event, match)
        return TranslationEvent(
            source_text=base_event.source_text,
            target_text=base_event.target_text,
            confidence=decision.confidence,
            source_language=base_event.source_language,
            target_language=base_event.target_language,
            metadata=decision.metadata,
        )

    def score(
        self,
        phrase: CommittedPhrase,
        event: TranslationEvent,
        match: TranslationMemoryMatch | None = None,
    ) -> ConfidenceDecision:
        grammar_score = self.grammar_profile.score(event)
        memory_score = match.confidence if match else 0.0
        confidence = (
            (phrase.confidence * 0.35)
            + (event.confidence * 0.35)
            + (grammar_score * 0.20)
            + (memory_score * 0.10)
        )
        confidence = max(0.0, min(1.0, confidence))
        accepted = confidence >= self.min_accept_confidence
        reason = "accepted" if accepted else "low memory-augmented confidence"
        return ConfidenceDecision(
            confidence=confidence,
            accepted=accepted,
            reason=reason,
            metadata=self._metadata("translator", match, reason, grammar_score=grammar_score),
        )

    def learn_correction(
        self,
        source_text: str,
        target_text: str,
        source_language: str,
        target_language: str,
        metadata: dict[str, str] | None = None,
    ) -> TranslationMemoryEntry:
        entry = self.memory.learn_correction(
            source_text=source_text,
            target_text=target_text,
            source_language=source_language,
            target_language=target_language,
            namespace=self.namespace,
            domain=self.domain,
            metadata=metadata,
        )
        self.grammar_profile.learn(entry)
        return entry

    def _metadata(
        self,
        source: str,
        match: TranslationMemoryMatch | None,
        reason: str | None,
        grammar_score: float | None = None,
    ) -> dict[str, str]:
        metadata = {
            "confidence_source": source,
            "memory_namespace": self.namespace,
            "memory_domain": self.domain,
        }
        if reason:
            metadata["confidence_reason"] = reason
        if grammar_score is not None:
            metadata["grammar_score"] = f"{grammar_score:.3f}"
        if match:
            metadata["memory_similarity"] = f"{match.similarity:.3f}"
            metadata["memory_exact"] = str(match.exact).lower()
        return metadata
