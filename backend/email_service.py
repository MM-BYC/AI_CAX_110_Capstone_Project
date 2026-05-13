"""Transactional email helper.

Uses SMTP when configured, otherwise writes messages to backend/email_outbox.json
so local/dev flows remain inspectable without a mail provider.
"""
import json
import os
import smtplib
import time
from email.message import EmailMessage
from pathlib import Path

OUTBOX_FILE = Path(__file__).parent / "email_outbox.json"


def _append_outbox(message: dict) -> None:
    messages = []
    if OUTBOX_FILE.exists():
        try:
            messages = json.loads(OUTBOX_FILE.read_text())
        except Exception:
            messages = []
    messages.append(message)
    OUTBOX_FILE.write_text(json.dumps(messages, indent=2))


def send_email(
    to_email: str,
    subject: str,
    body: str,
    *,
    cc: list[str] | None = None,
    from_email: str = "",
) -> dict:
    cc = [e.strip() for e in (cc or []) if e and e.strip()]
    message = {
        "to": to_email,
        "cc": cc,
        "from": from_email,
        "subject": subject,
        "body": body,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    host = os.getenv("SMTP_HOST", "").strip()
    sender = os.getenv("SMTP_FROM", "").strip() or os.getenv("SMTP_USER", "").strip()
    if not host or not sender:
        message["delivery"] = "outbox"
        _append_outbox(message)
        return message

    port = int(os.getenv("SMTP_PORT", "587"))
    username = os.getenv("SMTP_USER", "").strip()
    password = os.getenv("SMTP_PASSWORD", "").strip()
    use_tls = os.getenv("SMTP_TLS", "true").lower() != "false"

    email = EmailMessage()
    email["From"] = from_email.strip() or sender
    email["To"] = to_email
    if cc:
        email["Cc"] = ", ".join(cc)
    email["Subject"] = subject
    email.set_content(body)

    with smtplib.SMTP(host, port, timeout=15) as smtp:
        if use_tls:
            smtp.starttls()
        if username and password:
            smtp.login(username, password)
        smtp.send_message(email)

    message["delivery"] = "smtp"
    return message
