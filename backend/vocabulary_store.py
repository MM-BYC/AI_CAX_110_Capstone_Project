"""Enterprise Vocabulary Store.

Domain-specific terminology with optional per-language preferred translations.
Entries are keyword-matched against incoming speech at translation time and
injected as context into the LLM prompt so the model uses the correct
enterprise-specific terminology consistently across all 16 languages.

Storage: JSON file on disk + optional VOCABULARY_JSON env-var for cloud deploys
where the filesystem is ephemeral (Render free tier, etc.).
"""
import json
import logging
import os
import time
import uuid
from pathlib import Path
from threading import Lock
from typing import Optional

import memory_store
import mongo_store

logger = logging.getLogger(__name__)

_VOCAB_FILE = Path(__file__).parent / "vocabulary.json"
_lock = Lock()
_entries: list[dict] = []
_version: int = 0   # incremented on every write; used to invalidate the translation cache


# ── Persistence ────────────────────────────────────────────────────────────────

def _load() -> None:
    global _entries, _version
    coll = mongo_store.collection("vocabulary")
    if coll is not None:
        _entries = [
            e for e in (mongo_store.strip_id(doc) for doc in coll.find({}))
            if e
        ]
        logger.info("Vocabulary: loaded %d entries from MongoDB", len(_entries))
        _version = 0
        return

    # Cloud-deploy path: operator serialises the vocabulary into an env var.
    env_val = os.getenv("VOCABULARY_JSON", "").strip()
    if env_val:
        try:
            _entries = json.loads(env_val)
            logger.info("Vocabulary: loaded %d entries from VOCABULARY_JSON env", len(_entries))
            _version = 0
            return
        except Exception as exc:
            logger.warning("VOCABULARY_JSON parse error: %s", exc)

    if _VOCAB_FILE.exists():
        try:
            with open(_VOCAB_FILE, encoding="utf-8") as fh:
                _entries = json.load(fh)
            logger.info("Vocabulary: loaded %d entries from %s", len(_entries), _VOCAB_FILE)
        except Exception as exc:
            logger.warning("Vocabulary file load error: %s", exc)
            _entries = []
    _version = 0


def _save() -> None:
    coll = mongo_store.collection("vocabulary")
    if coll is not None:
        ids = [e["id"] for e in _entries if e.get("id")]
        if ids:
            coll.delete_many({"id": {"$nin": ids}})
        else:
            coll.delete_many({})
        for entry in _entries:
            coll.replace_one({"id": entry["id"]}, dict(entry), upsert=True)
        return

    try:
        with open(_VOCAB_FILE, "w", encoding="utf-8") as fh:
            json.dump(_entries, fh, indent=2, ensure_ascii=False)
    except Exception as exc:
        logger.warning("Vocabulary save failed: %s", exc)


# ── Public accessors ───────────────────────────────────────────────────────────

def get_version() -> int:
    """Monotonically increasing counter; bumped on every add / update / delete."""
    return _version


def list_all() -> list[dict]:
    with _lock:
        return [dict(e) for e in _entries]


def get(entry_id: str) -> Optional[dict]:
    with _lock:
        for e in _entries:
            if e["id"] == entry_id:
                return dict(e)
    return None


# ── CRUD ───────────────────────────────────────────────────────────────────────

def add(term: str, definition: str, *,
        language: str = "en",
        variants: list = None,
        domain: str = "",
        translations: dict = None) -> dict:
    """Add a new vocabulary entry and return it."""
    global _version
    entry = {
        "id": str(uuid.uuid4())[:8],
        "term": term.strip(),
        "definition": definition.strip(),
        "language": language,
        "variants": variants or [],
        "domain": domain,
        # translations: {lang_code → preferred translation string}
        # e.g. {"es": "Retorno sobre la Inversión", "fr": "Retour sur investissement"}
        "translations": translations or {},
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with _lock:
        _entries.append(entry)
        _version += 1
        _save()
        memory_store.upsert_vocabulary(entry)
    return dict(entry)


def update(entry_id: str, **kwargs) -> Optional[dict]:
    """Update allowed fields on an existing entry. Returns updated entry or None."""
    global _version
    _allowed = {"term", "definition", "language", "variants", "domain", "translations"}
    with _lock:
        for e in _entries:
            if e["id"] == entry_id:
                for k, v in kwargs.items():
                    if k in _allowed:
                        e[k] = v
                _version += 1
                _save()
                memory_store.upsert_vocabulary(e)
                return dict(e)
    return None


def delete(entry_id: str) -> bool:
    global _entries, _version
    with _lock:
        before = len(_entries)
        _entries = [e for e in _entries if e["id"] != entry_id]
        if len(_entries) < before:
            _version += 1
            _save()
            return True
    return False


def bulk_import(rows: list[dict]) -> int:
    """Import multiple entries at once. Returns count of entries added."""
    global _version
    added = 0
    with _lock:
        for raw in rows:
            term = (raw.get("term") or "").strip()
            definition = (raw.get("definition") or "").strip()
            if not term or not definition:
                continue
            entry = {
                "id": str(uuid.uuid4())[:8],
                "term": term,
                "definition": definition,
                "language": raw.get("language", "en"),
                "variants": raw.get("variants") or [],
                "domain": raw.get("domain") or "",
                "translations": raw.get("translations") or {},
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            _entries.append(entry)
            memory_store.upsert_vocabulary(entry)
            added += 1
        if added:
            _version += 1
            _save()
    return added


# ── Retrieval ──────────────────────────────────────────────────────────────────

def search(text: str, source_lang: str = "en", limit: int = 8) -> list[dict]:
    """Return vocabulary entries whose term or variant appears verbatim in text.

    Word-boundary matching: the term must appear as a standalone word or phrase
    (not as a substring of another word) so 'IT' doesn't match 'iterative'.
    """
    if not text or not _entries:
        return []

    import re
    text_lower = text.lower()
    results = []
    seen: set[str] = set()

    with _lock:
        snapshot = list(_entries)

    for entry in snapshot:
        if entry["id"] in seen:
            continue
        candidates = [entry["term"]] + entry.get("variants", [])
        for cand in candidates:
            if not cand:
                continue
            # Escape the candidate for use in a regex word-boundary pattern.
            # Use \b for pure-ASCII terms; fall back to space/start/end anchors
            # for terms with non-ASCII characters (CJK, accented chars, etc.).
            cand_lower = cand.lower()
            try:
                pattern = r"(?<!\w)" + re.escape(cand_lower) + r"(?!\w)"
                if re.search(pattern, text_lower):
                    results.append(dict(entry))
                    seen.add(entry["id"])
                    break
            except re.error:
                if cand_lower in text_lower:
                    results.append(dict(entry))
                    seen.add(entry["id"])
                    break

        if len(results) >= limit:
            break

    return results


def to_context(entries: list[dict], target_lang: str) -> str:
    """Build a terminology context block to inject into the translation prompt.

    For entries that have a pre-defined translation for target_lang, the
    instruction is explicit: "translate X as Y".  For entries without a
    preferred translation, the definition is supplied so the LLM can infer
    the correct term rather than inventing a generic one.
    """
    if not entries:
        return ""
    lines = ["Enterprise terminology — apply these definitions consistently:"]
    for e in entries:
        preferred = (e.get("translations") or {}).get(target_lang, "")
        if preferred:
            lines.append(
                f'  • "{e["term"]}" → use exactly "{preferred}"'
                f' ({e["definition"]})'
            )
        else:
            lines.append(f'  • "{e["term"]}": {e["definition"]}')
    return "\n".join(lines)


# Load on import
_load()
