"""MongoDB persistence helpers with safe local fallbacks.

Set MONGODB_URI to enable MongoDB. Without it, callers keep using their
existing JSON/in-memory fallback paths.
"""
import logging
import os
from functools import lru_cache

logger = logging.getLogger(__name__)

try:
    from pymongo import ASCENDING, MongoClient
except ImportError:  # pragma: no cover - optional dependency on local machines
    ASCENDING = 1
    MongoClient = None


def is_enabled() -> bool:
    return bool(os.getenv("MONGODB_URI")) and MongoClient is not None


@lru_cache(maxsize=1)
def _db():
    if not is_enabled():
        return None
    client = MongoClient(os.getenv("MONGODB_URI"), serverSelectionTimeoutMS=3000)
    db = client[os.getenv("MONGODB_DB", "ai_translate")]
    try:
        db.command("ping")
        db.users.create_index([("email", ASCENDING)], unique=True)
        db.pricing.create_index([("key", ASCENDING)], unique=True)
        db.vocabulary.create_index([("id", ASCENDING)], unique=True)
        db.translation_memory.create_index(
            [("source_norm", ASCENDING), ("source_lang", ASCENDING), ("target_lang", ASCENDING)],
            unique=True,
        )
    except Exception as exc:
        logger.warning("MongoDB unavailable, using local fallback: %s", exc)
        return None
    return db


def collection(name: str):
    db = _db()
    if db is None:
        return None
    return db[name]


def strip_id(doc: dict | None) -> dict | None:
    if not doc:
        return None
    doc = dict(doc)
    doc.pop("_id", None)
    return doc
