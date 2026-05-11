import json
import os
import time
from pathlib import Path

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
    users = _load()
    return users.get(email.lower())

def create_user(email, phone, password_hash, trial_days=3):
    users = _load()
    email = email.lower()
    if email in users:
        return None
    
    now = time.time()
    user = {
        "email": email,
        "phone": phone,
        "password_hash": password_hash,
        "created_at": now,
        "trial_ends_at": now + (trial_days * 86400),
        "is_subscriber": False
    }
    users[email] = user
    _save(users)
    return user

def update_subscription(email, is_subscriber=True):
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