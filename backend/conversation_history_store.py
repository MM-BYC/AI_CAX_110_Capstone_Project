"""Conversation history persistence for summarized chat-board sessions.

The public functions keep MongoDB details out of the main API module. When
MongoDB is not configured, a local JSON fallback is used so development flows
remain testable without changing callers.
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

import mongo_store

STORE_FILE = Path(__file__).parent / "conversation_history.json"
SETTINGS_KEY = "conversation_history"
DEFAULT_RETENTION_DAYS = 90


def _utc_date(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(ts or time.time()))


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _load() -> dict:
    if not STORE_FILE.exists():
        return {"records": [], "settings": {"retention_days": DEFAULT_RETENTION_DAYS}}
    try:
        data = json.loads(STORE_FILE.read_text())
    except Exception:
        data = {}
    return {
        "records": data.get("records", []),
        "full_chats": data.get("full_chats", []),
        "settings": {
            "retention_days": int(
                data.get("settings", {}).get("retention_days", DEFAULT_RETENTION_DAYS)
            )
        },
    }


def _save(data: dict) -> None:
    STORE_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))


def _records():
    return mongo_store.collection("conversation_history")


def _full_chat_records():
    return mongo_store.collection("conversation_full_chat")


def _settings():
    return mongo_store.collection("app_settings")


def ensure_indexes() -> None:
    coll = _records()
    if coll is None:
        return
    try:
        coll.create_index([("id", 1)], unique=True)
        coll.create_index([("owner_email", 1), ("local_date", 1)])
        coll.create_index([("created_at_ts", 1)])
        full_chat = _full_chat_records()
        if full_chat is not None:
            full_chat.create_index([("summary_record_id", 1)], unique=True)
            full_chat.create_index([("owner_email", 1), ("local_date", 1)])
            full_chat.create_index([("created_at_ts", 1)])
    except Exception:
        pass


def get_retention_days() -> int:
    coll = _settings()
    if coll is not None:
        doc = mongo_store.strip_id(coll.find_one({"key": SETTINGS_KEY}))
        if doc:
            return int(doc.get("retention_days", DEFAULT_RETENTION_DAYS))
        coll.update_one(
            {"key": SETTINGS_KEY},
            {"$set": {"key": SETTINGS_KEY, "retention_days": DEFAULT_RETENTION_DAYS}},
            upsert=True,
        )
        return DEFAULT_RETENTION_DAYS
    return _load()["settings"]["retention_days"]


def set_retention_days(days: int) -> dict:
    days = max(1, min(int(days), 3650))
    coll = _settings()
    if coll is not None:
        coll.update_one(
            {"key": SETTINGS_KEY},
            {"$set": {"key": SETTINGS_KEY, "retention_days": days, "updated_at": _now_iso()}},
            upsert=True,
        )
    else:
        data = _load()
        data["settings"]["retention_days"] = days
        _save(data)
    deleted = purge_expired()
    return {"retention_days": days, "purged_records": deleted}


def purge_expired(now_ts: float | None = None) -> int:
    retention_days = get_retention_days()
    cutoff = (now_ts or time.time()) - retention_days * 86400
    coll = _records()
    if coll is not None:
        result = coll.delete_many({"created_at_ts": {"$lt": cutoff}})
        deleted = int(result.deleted_count)
        full_chat = _full_chat_records()
        if full_chat is not None:
            deleted += int(full_chat.delete_many({"created_at_ts": {"$lt": cutoff}}).deleted_count)
        return deleted

    data = _load()
    before = len(data["records"])
    data["records"] = [r for r in data["records"] if r.get("created_at_ts", 0) >= cutoff]
    data["full_chats"] = [r for r in data.get("full_chats", []) if r.get("created_at_ts", 0) >= cutoff]
    _save(data)
    return before - len(data["records"])


def save_record(
    *,
    owner_email: str,
    room_id: str,
    participants: list[str],
    participant_emails: list[str],
    participant_language: str,
    summary: dict,
    messages: list[dict],
    model: str,
    summary_prompt_version: str,
) -> dict:
    ensure_indexes()
    purge_expired()
    now = time.time()
    record = {
        "id": uuid.uuid4().hex,
        "owner_email": owner_email.lower(),
        "room_id": room_id,
        "local_date": _utc_date(now),
        "created_at": _now_iso(),
        "created_at_ts": now,
        "participants": participants,
        "participant_emails": _unique_emails(participant_emails),
        "participant_language": participant_language,
        "summary": summary,
        "chat_messages": messages,
        "metadata": {
            "message_count": len(messages),
            "model": model,
            "summary_prompt_version": summary_prompt_version,
            "source": "conversation_chat_board",
        },
    }
    coll = _records()
    if coll is not None:
        coll.insert_one(dict(record))
    else:
        data = _load()
        data["records"].append(record)
        _save(data)
    return record


def upsert_record_for_date(
    *,
    owner_email: str,
    room_id: str,
    participants: list[str],
    participant_emails: list[str],
    participant_language: str,
    summary: dict,
    messages: list[dict],
    model: str,
    summary_prompt_version: str,
) -> dict:
    ensure_indexes()
    purge_expired()
    now = time.time()
    owner_email = owner_email.lower()
    local_date = _utc_date(now)
    query = {"owner_email": owner_email, "local_date": local_date}
    if room_id:
        query["room_id"] = room_id

    existing = None
    coll = _records()
    if coll is not None:
        existing = mongo_store.strip_id(coll.find_one(query))
    else:
        for item in _load()["records"]:
            if _match_record(item, query):
                existing = item
                break

    record = {
        "id": (existing or {}).get("id") or uuid.uuid4().hex,
        "owner_email": owner_email,
        "room_id": room_id,
        "local_date": local_date,
        "created_at": (existing or {}).get("created_at") or _now_iso(),
        "created_at_ts": (existing or {}).get("created_at_ts") or now,
        "updated_at": _now_iso(),
        "updated_at_ts": now,
        "participants": participants,
        "participant_emails": _unique_emails(participant_emails),
        "participant_language": participant_language,
        "summary": summary,
        "chat_messages": messages,
        "metadata": {
            "message_count": len(messages),
            "model": model,
            "summary_prompt_version": summary_prompt_version,
            "source": "conversation_chat_board",
            "save_mode": "manual_upsert_by_owner_date_room",
        },
    }
    if coll is not None:
        coll.replace_one(query, dict(record), upsert=True)
    else:
        data = _load()
        replaced = False
        for idx, item in enumerate(data["records"]):
            if _match_record(item, query):
                data["records"][idx] = record
                replaced = True
                break
        if not replaced:
            data["records"].append(record)
        _save(data)
    upsert_full_chat_for_record(record, messages)
    return record


def upsert_full_chat_for_record(summary_record: dict, messages: list[dict]) -> dict:
    chat_record = {
        "id": f"chat_{summary_record['id']}",
        "summary_record_id": summary_record["id"],
        "owner_email": summary_record["owner_email"],
        "room_id": summary_record.get("room_id", ""),
        "local_date": summary_record["local_date"],
        "created_at": summary_record.get("created_at"),
        "created_at_ts": summary_record.get("created_at_ts"),
        "updated_at": summary_record.get("updated_at") or _now_iso(),
        "updated_at_ts": summary_record.get("updated_at_ts") or time.time(),
        "participants": summary_record.get("participants", []),
        "participant_emails": summary_record.get("participant_emails", []),
        "chat_messages": messages,
        "metadata": {
            "message_count": len(messages),
            "source": "conversation_chat_board_truth_source",
            "save_mode": "manual_upsert_by_summary_record",
        },
    }
    coll = _full_chat_records()
    if coll is not None:
        coll.replace_one(
            {"summary_record_id": summary_record["id"]},
            dict(chat_record),
            upsert=True,
        )
    else:
        data = _load()
        full_chats = data.setdefault("full_chats", [])
        replaced = False
        for idx, item in enumerate(full_chats):
            if item.get("summary_record_id") == summary_record["id"]:
                full_chats[idx] = chat_record
                replaced = True
                break
        if not replaced:
            full_chats.append(chat_record)
        _save(data)
    return chat_record


def list_dates(owner_email: str, start_date: str = "", end_date: str = "") -> list[dict]:
    purge_expired()
    query = {"owner_email": owner_email.lower()}
    return _list_dates_query(query, start_date, end_date)


def list_all_dates(start_date: str = "", end_date: str = "") -> list[dict]:
    purge_expired()
    return _list_dates_query({}, start_date, end_date)


def _list_dates_query(query: dict, start_date: str = "", end_date: str = "") -> list[dict]:
    date_query = {}
    if start_date:
        date_query["$gte"] = start_date
    if end_date:
        date_query["$lte"] = end_date
    if date_query:
        query["local_date"] = date_query

    coll = _records()
    grouped: dict[str, dict] = {}
    if coll is not None:
        docs = (mongo_store.strip_id(d) for d in coll.find(query).sort("local_date", -1))
    else:
        docs = [r for r in _load()["records"] if _match_record(r, query)]

    for doc in docs:
        if not doc:
            continue
        date = doc.get("local_date", "")
        if not date:
            continue
        item = grouped.setdefault(
            date,
            {"date": date, "count": 0, "latest_created_at": "", "participants": [], "participant_emails": []},
        )
        item["count"] += 1
        item["latest_created_at"] = max(item["latest_created_at"], doc.get("created_at", ""))
        for p in doc.get("participants", []):
            if p and p not in item["participants"]:
                item["participants"].append(p)
        for e in doc.get("participant_emails", []):
            if e and e not in item["participant_emails"]:
                item["participant_emails"].append(e)
    return sorted(grouped.values(), key=lambda r: r["date"], reverse=True)


def list_records_for_date(owner_email: str, date: str) -> list[dict]:
    query = {"owner_email": owner_email.lower(), "local_date": date}
    return _list_records_query(query)


def list_all_records_for_date(date: str) -> list[dict]:
    return _list_records_query({"local_date": date})


def _list_records_query(query: dict) -> list[dict]:
    coll = _records()
    if coll is not None:
        docs = coll.find(query).sort("created_at_ts", -1)
        records = [mongo_store.strip_id(d) for d in docs]
    else:
        records = [r for r in _load()["records"] if _match_record(r, query)]
        records.sort(key=lambda r: r.get("created_at_ts", 0), reverse=True)
    return [_summary_record(r) for r in records if r]


def get_record(owner_email: str, record_id: str) -> dict | None:
    query = {"owner_email": owner_email.lower(), "id": record_id}
    return _get_record_query(query)


def get_record_any(record_id: str) -> dict | None:
    return _get_record_query({"id": record_id})


def _get_record_query(query: dict) -> dict | None:
    coll = _records()
    if coll is not None:
        return mongo_store.strip_id(coll.find_one(query))
    for record in _load()["records"]:
        if _match_record(record, query):
            return record
    return None


def delete_date(owner_email: str, date: str) -> int:
    query = {"owner_email": owner_email.lower(), "local_date": date}
    return _delete_query(query)


def delete_date_all(date: str) -> int:
    return _delete_query({"local_date": date})


def _delete_query(query: dict) -> int:
    coll = _records()
    if coll is not None:
        existing = [mongo_store.strip_id(d) for d in coll.find(query)]
        summary_ids = [d["id"] for d in existing if d and d.get("id")]
        result = coll.delete_many(query)
        deleted = int(result.deleted_count)
        full_chat = _full_chat_records()
        if full_chat is not None and summary_ids:
            deleted += int(full_chat.delete_many({"summary_record_id": {"$in": summary_ids}}).deleted_count)
        return deleted
    data = _load()
    before = len(data["records"])
    deleted_summary_ids = [
        r.get("id") for r in data["records"] if _match_record(r, query) and r.get("id")
    ]
    data["records"] = [r for r in data["records"] if not _match_record(r, query)]
    data["full_chats"] = [
        r for r in data.get("full_chats", [])
        if r.get("summary_record_id") not in deleted_summary_ids
    ]
    _save(data)
    return before - len(data["records"])


def _summary_record(record: dict) -> dict:
    return {
        "id": record.get("id"),
        "room_id": record.get("room_id"),
        "local_date": record.get("local_date"),
        "created_at": record.get("created_at"),
        "participants": record.get("participants", []),
        "participant_emails": record.get("participant_emails", []),
        "participant_language": record.get("participant_language", ""),
        "summary": record.get("summary", {}),
        "metadata": record.get("metadata", {}),
    }


def _match_record(record: dict, query: dict) -> bool:
    for key, expected in query.items():
        actual = record.get(key)
        if isinstance(expected, dict):
            if "$gte" in expected and actual < expected["$gte"]:
                return False
            if "$lte" in expected and actual > expected["$lte"]:
                return False
            continue
        if actual != expected:
            return False
    return True


def _unique_emails(emails: list[str]) -> list[str]:
    seen = set()
    result = []
    for email in emails:
        email = (email or "").strip().lower()
        if not email or email in seen:
            continue
        seen.add(email)
        result.append(email)
    return result
