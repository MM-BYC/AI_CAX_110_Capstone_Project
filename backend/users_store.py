import json
import os
import time
import uuid
from pathlib import Path

import mongo_store

STORE_FILE = Path(__file__).parent / "users.json"

def _load():
    if not STORE_FILE.exists():
        return {}
    try:
        return json.loads(STORE_FILE.read_text())
    except:
        return {}

def _save(data):
    STORE_FILE.write_text(json.dumps(data, indent=2))

def get_user(email):
    coll = mongo_store.collection("users")
    if coll is not None:
        return mongo_store.strip_id(coll.find_one({"email": email.lower()}))
    users = _load()
    return users.get(email.lower())

def list_users():
    coll = mongo_store.collection("users")
    if coll is not None:
        return {
            u["email"]: u
            for u in (mongo_store.strip_id(doc) for doc in coll.find({}))
            if u and u.get("email")
        }
    return _load()

def create_user(
    email,
    phone,
    password_hash,
    trial_days=3,
    first_name="",
    last_name="",
    plan="trial",
    billing_address=None,
    payment_method=None,
    accepted_terms_at=None,
):
    email = email.lower()
    now = time.time()
    trial_ends_at = now + (trial_days * 86400)
    user = {
        "email": email,
        "first_name": first_name,
        "last_name": last_name,
        "phone": phone,
        "password_hash": password_hash,
        "created_at": now,
        "trial_ends_at": trial_ends_at,
        "is_subscriber": False,
        "plan": plan,
        "billing_address": billing_address or {},
        "payment_method": payment_method or {},
        "accepted_terms_at": accepted_terms_at,
        "cancelled_at": None,
        "refund_requested_at": None,
        "refunded_at": None,
        "charged_at": None,
        "invoice_number": None,
        "invoice_sent_at": None
    }
    coll = mongo_store.collection("users")
    if coll is not None:
        try:
            coll.insert_one(dict(user))
            return dict(user)
        except Exception:
            return None

    users = _load()
    if email in users:
        return None
    users[email] = user
    _save(users)
    return user

def update_user(email, updates):
    coll = mongo_store.collection("users")
    if coll is not None:
        email = email.lower()
        updated = coll.find_one_and_update(
            {"email": email},
            {"$set": updates},
            return_document=True,
        )
        return mongo_store.strip_id(updated)

    users = _load()
    email = email.lower()
    if email not in users:
        return None
    users[email].update(updates)
    _save(users)
    return users[email]

def update_subscription(email, is_subscriber=True):
    coll = mongo_store.collection("users")
    if coll is not None:
        result = coll.update_one(
            {"email": email.lower()},
            {"$set": {"is_subscriber": is_subscriber}},
        )
        return result.matched_count > 0

    users = _load()
    email = email.lower()
    if email in users:
        users[email]["is_subscriber"] = is_subscriber
        _save(users)
        return True
    return False

def check_access(email):
    user = get_user(email)
    if not user:
        return False, "User not found"
    
    if user.get("is_subscriber"):
        return True, "Active subscription"
    
    if time.time() < user.get("trial_ends_at", 0):
        return True, "Trial active"
    
    return False, "Trial expired"

def mark_charged(email):
    coll = mongo_store.collection("users")
    if coll is not None:
        email = email.lower()
        user = get_user(email)
        if not user:
            return None
        now = time.time()
        invoice_number = user.get("invoice_number") or f"INV-{uuid.uuid4().hex[:8].upper()}"
        updated = coll.find_one_and_update(
            {"email": email},
            {
                "$set": {
                    "is_subscriber": True,
                    "charged_at": now,
                    "invoice_number": invoice_number,
                }
            },
            return_document=True,
        )
        return mongo_store.strip_id(updated)

    users = _load()
    email = email.lower()
    if email not in users:
        return None
    now = time.time()
    users[email]["is_subscriber"] = True
    users[email]["charged_at"] = now
    users[email]["invoice_number"] = users[email].get("invoice_number") or f"INV-{uuid.uuid4().hex[:8].upper()}"
    _save(users)
    return users[email]
