#!/bin/bash
# Generates a self-signed TLS certificate for local HTTPS development.
# The certificate covers localhost, 127.0.0.1, and your current Wi-Fi / hotspot IP.
# Run this once; then restart both servers.  iPhone must trust the cert (see below).

set -e

mkdir -p certs

# Detect the hotspot / LAN IP (prefer en0/en1 on Mac)
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")

SAN="IP:127.0.0.1,DNS:localhost"
if [ -n "$LAN_IP" ]; then
    SAN="IP:${LAN_IP},${SAN}"
    echo "Including LAN/hotspot IP: $LAN_IP"
fi

openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout certs/server.key \
    -out    certs/server.crt \
    -subj   "/CN=AI-Translate-Local" \
    -addext "subjectAltName=${SAN}"

echo ""
echo "Certificate written to certs/server.crt"
echo ""
echo "── iPhone trust steps ──────────────────────────────────────────────────"
echo "1. AirDrop  certs/server.crt  to your iPhone  (or email it to yourself)"
echo "2. iPhone: Settings → General → VPN & Device Management → install profile"
echo "3. iPhone: Settings → General → About → Certificate Trust Settings"
echo "   → toggle AI-Translate-Local  ON"
echo "4. Restart both servers:  ./backend/startback.sh  and  ./frontend/startfront.sh"
echo "5. Open  https://${LAN_IP:-<MacBook-IP>}:3000  on iPhone"
echo "────────────────────────────────────────────────────────────────────────"
