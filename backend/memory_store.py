"""Translation memory and optional Pinecone semantic retrieval.

Exact matches are served from MongoDB/local JSON for lowest latency. Pinecone is
optional and used only for semantic context when these are configured:

  PINECONE_API_KEY
  PINECONE_INDEX_HOST

The Pinecone index must support integrated embedding with a text field named by
PINECONE_TEXT_FIELD, defaulting to "chunk_text".
"""
import json
import logging
import os
import time
import uuid
from pathlib import Path

import requests

import mongo_store

logger = logging.getLogger(__name__)

_MEMORY_FILE = Path(__file__).parent / "translation_memory.json"
_PINECONE_API_VERSION = "2025-10"
_TEXT_FIELD = os.getenv("PINECONE_TEXT_FIELD", "chunk_text")
_NAMESPACE = os.getenv("PINECONE_NAMESPACE", "ai-translate")


def _norm(text: str) -> str:
    return " ".join((text or "").strip().lower().split())


def _load_local() -> list[dict]:
    if not _MEMORY_FILE.exists():
        return []
    try:
        return json.loads(_MEMORY_FILE.read_text())
    except Exception:
        return []


def _save_local(rows: list[dict]) -> None:
    try:
        _MEMORY_FILE.write_text(json.dumps(rows, indent=2, ensure_ascii=False))
    except Exception as exc:
        logger.warning("Translation memory save failed: %s", exc)


def _pinecone_ready() -> bool:
    return bool(os.getenv("PINECONE_API_KEY") and os.getenv("PINECONE_INDEX_HOST"))


def _pinecone_url(path: str) -> str:
    host = os.getenv("PINECONE_INDEX_HOST", "").rstrip("/")
    if not host.startswith("http"):
        host = f"https://{host}"
    return f"{host}{path}"


def _pinecone_headers() -> dict:
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Api-Key": os.getenv("PINECONE_API_KEY", ""),
        "X-Pinecone-Api-Version": _PINECONE_API_VERSION,
    }


def _pinecone_upsert(record: dict) -> None:
    if not _pinecone_ready():
        return
    text = (
        f'{record["source_lang"]}->{record["target_lang"]}: '
        f'{record["source_text"]} => {record["translated_text"]}'
    )
    payload = {
        "_id": record["id"],
        _TEXT_FIELD: text,
        "kind": record.get("kind", "translation_memory"),
        "source_lang": record["source_lang"],
        "target_lang": record["target_lang"],
        "source_text": record["source_text"],
        "translated_text": record["translated_text"],
    }
    try:
        headers = _pinecone_headers()
        headers["Content-Type"] = "application/x-ndjson"
        res = requests.post(
            _pinecone_url(f"/records/namespaces/{_NAMESPACE}/upsert"),
            headers=headers,
            data=json.dumps(payload) + "\n",
            timeout=2.5,
        )
        res.raise_for_status()
    except Exception as exc:
        logger.warning("Pinecone memory upsert skipped: %s", exc)


def upsert_vocabulary(entry: dict) -> None:
    if not _pinecone_ready() or not entry.get("id"):
        return
    translations = entry.get("translations") or {}
    preferred = "; ".join(f"{lang}: {value}" for lang, value in translations.items())
    text = " | ".join(
        part for part in [
            f"term: {entry.get('term', '')}",
            f"definition: {entry.get('definition', '')}",
            f"variants: {', '.join(entry.get('variants') or [])}",
            f"preferred translations: {preferred}",
        ]
        if part and not part.endswith(": ")
    )
    payload = {
        "_id": f"vocab-{entry['id']}",
        _TEXT_FIELD: text,
        "kind": "vocabulary",
        "term": entry.get("term", ""),
        "definition": entry.get("definition", ""),
        "source_lang": entry.get("language", ""),
        "target_lang": "",
        "translations_json": json.dumps(translations, ensure_ascii=False),
    }
    try:
        headers = _pinecone_headers()
        headers["Content-Type"] = "application/x-ndjson"
        res = requests.post(
            _pinecone_url(f"/records/namespaces/{_NAMESPACE}/upsert"),
            headers=headers,
            data=json.dumps(payload) + "\n",
            timeout=2.5,
        )
        res.raise_for_status()
    except Exception as exc:
        logger.warning("Pinecone vocabulary upsert skipped: %s", exc)


def find_exact(text: str, source_lang: str, target_lang: str) -> dict | None:
    source_norm = _norm(text)
    if not source_norm:
        return None

    coll = mongo_store.collection("translation_memory")
    if coll is not None:
        return mongo_store.strip_id(coll.find_one({
            "source_norm": source_norm,
            "source_lang": source_lang,
            "target_lang": target_lang,
        }))

    for row in _load_local():
        if (
            row.get("source_norm") == source_norm
            and row.get("source_lang") == source_lang
            and row.get("target_lang") == target_lang
        ):
            return dict(row)
    return None


def add(
    source_text: str,
    translated_text: str,
    source_lang: str,
    target_lang: str,
    *,
    kind: str = "translation_memory",
) -> dict:
    source_norm = _norm(source_text)
    if not source_norm or not translated_text:
        return {}
    record = {
        "id": str(uuid.uuid4())[:12],
        "source_text": source_text,
        "source_norm": source_norm,
        "translated_text": translated_text,
        "source_lang": source_lang,
        "target_lang": target_lang,
        "kind": kind,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    coll = mongo_store.collection("translation_memory")
    if coll is not None:
        coll.update_one(
            {
                "source_norm": source_norm,
                "source_lang": source_lang,
                "target_lang": target_lang,
            },
            {"$set": record},
            upsert=True,
        )
    else:
        rows = [
            r for r in _load_local()
            if not (
                r.get("source_norm") == source_norm
                and r.get("source_lang") == source_lang
                and r.get("target_lang") == target_lang
            )
        ]
        rows.append(record)
        _save_local(rows[-2000:])

    _pinecone_upsert(record)
    return dict(record)


def semantic_search(text: str, source_lang: str, target_lang: str, limit: int = 3) -> list[dict]:
    if not text.strip() or not _pinecone_ready():
        return []
    payload = {
        "query": {"inputs": {"text": text}, "top_k": limit},
        "fields": [_TEXT_FIELD, "kind", "source_lang", "target_lang", "source_text", "translated_text", "term", "definition", "translations_json"],
    }
    try:
        res = requests.post(
            _pinecone_url(f"/records/namespaces/{_NAMESPACE}/search"),
            headers=_pinecone_headers(),
            data=json.dumps(payload),
            timeout=2.5,
        )
        res.raise_for_status()
        hits = res.json().get("result", {}).get("hits", [])
    except Exception as exc:
        logger.warning("Pinecone semantic search skipped: %s", exc)
        return []

    results = []
    for hit in hits:
        fields = hit.get("fields") or {}
        if fields.get("source_lang") not in ("", source_lang, None):
            continue
        if fields.get("target_lang") not in ("", target_lang, None):
            continue
        fields["_score"] = hit.get("_score", 0)
        results.append(fields)
    return results


def to_context(rows: list[dict]) -> str:
    if not rows:
        return ""
    lines = ["Translation memory — prefer these prior approved examples when relevant:"]
    for row in rows[:3]:
        if row.get("source_text") and row.get("translated_text"):
            lines.append(f'  • "{row["source_text"]}" → "{row["translated_text"]}"')
    return "\n".join(lines) if len(lines) > 1 else ""
