"""Admin account persistence.

Admin users are intentionally stored outside the regular users collection so
history-retention privileges can be managed independently from subscribers.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import mongo_store

STORE_FILE = Path(__file__).parent / "admin_accounts.json"


def _load() -> dict:
    if not STORE_FILE.exists():
        return {}
    try:
        return json.loads(STORE_FILE.read_text())
    except Exception:
        return {}


def _save(data: dict) -> None:
    STORE_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))


def _coll():
    return mongo_store.collection("admin_accounts")


def ensure_indexes() -> None:
    coll = _coll()
    if coll is None:
        return
    try:
        coll.create_index([("email", 1)], unique=True)
    except Exception:
        pass


def create_admin(email: str, password_hash: str, role: str = "admin") -> dict | None:
    ensure_indexes()
    email = email.lower().strip()
    now = time.time()
    admin = {
        "email": email,
        "password_hash": password_hash,
        "role": role or "admin",
        "privileges": {"maintain_retention_days": True},
        "created_at": now,
        "updated_at": now,
    }
    coll = _coll()
    if coll is not None:
        try:
            coll.insert_one(dict(admin))
            return dict(admin)
        except Exception:
            return None
    data = _load()
    if email in data:
        return None
    data[email] = admin
    _save(data)
    return admin


def get_admin(email: str) -> dict | None:
    email = email.lower().strip()
    coll = _coll()
    if coll is not None:
        return mongo_store.strip_id(coll.find_one({"email": email}))
    return _load().get(email)
