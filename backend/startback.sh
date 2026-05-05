#!/bin/bash
CERT="../certs/server.crt"
KEY="../certs/server.key"

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
    echo "Starting backend with HTTPS (iPhone mic enabled)"
    uv run uvicorn main:app --reload --host 0.0.0.0 \
        --ssl-certfile "$CERT" --ssl-keyfile "$KEY"
else
    echo "Starting backend with HTTP (iPhone mic requires HTTPS — run ./make-certs.sh)"
    uv run uvicorn main:app --reload --host 0.0.0.0
fi
