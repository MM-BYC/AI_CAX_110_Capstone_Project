"""Enterprise security layer.

Three responsibilities:
  1. API key authentication — all /api/v1/ routes require X-API-Key when
     TRANSLATE_API_KEY env var is set.  Dev mode (key not set) allows open
     access so local development never breaks.

  2. Rate limiting — sliding-window per client (API key hash or IP).
     Configurable via RATE_LIMIT_RPM env var (default 120 req/min).

  3. Security headers — HSTS, CSP, X-Frame-Options, X-Content-Type-Options,
     Referrer-Policy, Permissions-Policy applied to every HTTP response.

  4. Audit logging — structured JSON entries for every API call; never logs
     text content (PII).  Consumed by log-drain services (Datadog, Splunk, etc.)

Environment variables:
  TRANSLATE_API_KEY   Secret key clients must send as X-API-Key header.
                      Leave unset for dev mode (no auth).
  RATE_LIMIT_RPM      Max requests per minute per client (default 120).
  ALLOWED_ORIGINS     Comma-separated CORS origins (default * for dev).
                      Example: https://app.acme.com,https://admin.acme.com
"""
import hashlib
import hmac
import json
import logging
import os
import time
from collections import deque
from threading import Lock

from fastapi import Request
from fastapi.responses import JSONResponse

# ── Configuration (read once at import time) ──────────────────────────────────
_API_KEY: str  = os.getenv("TRANSLATE_API_KEY", "").strip()
_RATE_LIMIT_RPM: int = int(os.getenv("RATE_LIMIT_RPM", "120"))
_ALLOWED_ORIGINS: str = os.getenv("ALLOWED_ORIGINS", "*")

logger = logging.getLogger(__name__)
_audit = logging.getLogger("audit")


def is_production() -> bool:
    """True when an API key is configured (stricter behaviour applies)."""
    return bool(_API_KEY)


def get_api_key() -> str:
    return _API_KEY


def get_allowed_origins() -> list[str]:
    if _ALLOWED_ORIGINS.strip() == "*":
        return ["*"]
    return [o.strip() for o in _ALLOWED_ORIGINS.split(",") if o.strip()]


# ── API key verification ───────────────────────────────────────────────────────

def verify_api_key(request: Request) -> bool:
    """Return True if the request is authorised.

    Always True in dev mode (no key configured).
    Uses constant-time comparison to prevent timing-oracle attacks.
    """
    if not _API_KEY:
        return True
    provided = (
        request.headers.get("X-API-Key", "")
        or request.query_params.get("api_key", "")  # WebSocket query-param path
    )
    if not provided:
        return False
    return hmac.compare_digest(
        provided.encode("utf-8", errors="replace"),
        _API_KEY.encode("utf-8"),
    )


# ── Rate limiter (sliding window) ─────────────────────────────────────────────
_rate_windows: dict[str, deque] = {}
_rate_lock = Lock()


def _client_key(request: Request) -> str:
    """Stable, non-reversible client identifier for rate-limit bucketing."""
    api_key_header = (
        request.headers.get("X-API-Key", "")
        or request.query_params.get("api_key", "")
    )
    if api_key_header:
        return "key:" + hashlib.sha256(api_key_header.encode()).hexdigest()[:16]
    forwarded = request.headers.get("X-Forwarded-For", "")
    ip = (
        forwarded.split(",")[0].strip()
        if forwarded
        else (request.client.host if request.client else "unknown")
    )
    return "ip:" + hashlib.sha256(ip.encode()).hexdigest()[:16]


def check_rate_limit(request: Request, rpm: int | None = None) -> bool:
    """Return True if the request should proceed; False if rate limited."""
    limit = rpm or _RATE_LIMIT_RPM
    key = _client_key(request)
    now = time.monotonic()
    window_start = now - 60.0

    with _rate_lock:
        if key not in _rate_windows:
            _rate_windows[key] = deque()
        window = _rate_windows[key]
        while window and window[0] < window_start:
            window.popleft()
        if len(window) >= limit:
            return False
        window.append(now)

    return True


def _prune_rate_windows() -> None:
    """Evict idle clients (called from background cleanup task)."""
    cutoff = time.monotonic() - 120.0
    with _rate_lock:
        stale = [k for k, w in _rate_windows.items() if not w or w[-1] < cutoff]
        for k in stale:
            del _rate_windows[k]


# ── Security headers ──────────────────────────────────────────────────────────
# Content-Security-Policy designed for this SPA:
#   • scripts from self + unpkg (Lucide CDN) + inline (lucide.createIcons call)
#   • styles from self + Google Fonts + inline
#   • connect to self + any ws:/wss: (WebSocket, same origin enforced at app level)
#   • media from self + blob: (camera/mic streams)
_CSP = (
    "default-src 'self'; "
    "script-src 'self' https://unpkg.com 'unsafe-inline'; "
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; "
    "font-src 'self' https://fonts.gstatic.com; "
    "connect-src 'self' wss: ws:; "
    "img-src 'self' data: https://images.unsplash.com; "
    "media-src 'self' blob:; "
    "frame-ancestors 'none';"
)


def add_security_headers(response, *, is_https: bool = False) -> None:
    """Mutate *response* in-place to add enterprise security headers."""
    h = response.headers
    h["X-Content-Type-Options"]    = "nosniff"
    h["X-Frame-Options"]           = "DENY"
    h["X-XSS-Protection"]          = "1; mode=block"
    h["Referrer-Policy"]           = "strict-origin-when-cross-origin"
    # Allow camera + microphone from same origin only; block geolocation/payment
    h["Permissions-Policy"]        = "camera=(self), microphone=(self), geolocation=(), payment=()"
    h["Content-Security-Policy"]   = _CSP
    if is_https:
        # 2-year HSTS with preload — only set over HTTPS so local dev still works
        h["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload"


# ── Audit logger ──────────────────────────────────────────────────────────────

def audit(event: str, request: Request | None = None, **fields) -> None:
    """Emit a structured audit log entry.

    Rules:
      • Never log text content (source text, translations) — PII risk.
      • Always log event type, timestamp, and a hashed client key.
      • Extra keyword args are included verbatim — caller responsible for
        excluding PII.
    """
    entry: dict = {
        "ts":    time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "event": event,
    }
    if request is not None:
        entry["client"] = _client_key(request)
        entry["path"]   = str(request.url.path)
        entry["method"] = request.method
    entry.update(fields)
    _audit.info(json.dumps(entry, ensure_ascii=False))


# ── FastAPI middleware helpers ─────────────────────────────────────────────────

async def api_guard(request: Request, call_next):
    """Middleware: authenticate + rate-limit all /api/v1/ requests."""
    if request.url.path.startswith("/api/v1/"):
        if not verify_api_key(request):
            audit("auth_failure", request)
            return JSONResponse(
                {"error": "Invalid or missing API key", "hint": "Set X-API-Key header"},
                status_code=403,
            )
        if not check_rate_limit(request):
            audit("rate_limited", request)
            return JSONResponse(
                {"error": "Rate limit exceeded", "retry_after_seconds": 60},
                status_code=429,
                headers={"Retry-After": "60"},
            )
    return await call_next(request)


async def security_headers_middleware(request: Request, call_next):
    """Middleware: attach security headers to every HTTP response."""
    t0 = time.monotonic()
    response = await call_next(request)
    is_https = request.headers.get("x-forwarded-proto", "") == "https" \
               or str(request.url).startswith("https://")
    add_security_headers(response, is_https=is_https)
    # Response-time header — useful for SLA monitoring
    response.headers["X-Response-Time-Ms"] = str(round((time.monotonic() - t0) * 1000))
    return response
