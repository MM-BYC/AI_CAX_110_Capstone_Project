"""Pricing configuration store.

MongoDB is used when MONGODB_URI is configured. pricing.json remains the local
development/default seed so deploys can start with sane pricing before an admin
updates MongoDB.
"""
import json
from pathlib import Path

import mongo_store

_PRICING_FILE = Path(__file__).parent / "pricing.json"
_DEFAULT = {
    "currency": "USD",
    "monthly_price": 7.99,
    "yearly_price": 79.00,
    "trial_days": 3,
}


def _json_pricing() -> dict:
    if not _PRICING_FILE.exists():
        return dict(_DEFAULT)
    try:
        data = json.loads(_PRICING_FILE.read_text())
        return {**_DEFAULT, **data}
    except Exception:
        return dict(_DEFAULT)


def get_pricing() -> dict:
    coll = mongo_store.collection("pricing")
    if coll is None:
        return _json_pricing()

    doc = mongo_store.strip_id(coll.find_one({"key": "current"}))
    if doc:
        doc.pop("key", None)
        return {**_DEFAULT, **doc}

    seed = {"key": "current", **_json_pricing()}
    coll.update_one({"key": "current"}, {"$setOnInsert": seed}, upsert=True)
    seed.pop("key", None)
    return seed


def update_pricing(updates: dict) -> dict:
    allowed = {"currency", "monthly_price", "yearly_price", "trial_days"}
    clean = {k: v for k, v in updates.items() if k in allowed}
    coll = mongo_store.collection("pricing")
    if coll is None:
        current = _json_pricing()
        current.update(clean)
        _PRICING_FILE.write_text(json.dumps(current, indent=2))
        return current
    coll.update_one({"key": "current"}, {"$set": clean}, upsert=True)
    return get_pricing()
