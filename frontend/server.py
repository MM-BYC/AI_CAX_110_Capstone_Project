"""
Static file server with HTTP/1.1 + range-request support.
If certs/server.crt and certs/server.key exist at the project root,
the server starts in HTTPS mode (required for getUserMedia on iPhone/iPad).
"""
import os
import ssl
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
CERT = PROJECT_ROOT / "certs" / "server.crt"
KEY  = PROJECT_ROOT / "certs" / "server.key"


class HTTP11Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send_response(self, code, message=None):
        super().send_response(code, message)
        self.send_header("Accept-Ranges", "bytes")

    def log_message(self, fmt, *args):
        pass  # suppress per-request noise


if __name__ == "__main__":
    os.chdir(Path(__file__).parent)
    server = HTTPServer(("0.0.0.0", 3000), HTTP11Handler)

    if CERT.exists() and KEY.exists():
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(str(CERT), str(KEY))
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        print(f"Serving frontend at https://0.0.0.0:3000  (HTTPS — iPhone mic enabled)")
    else:
        print(
            "Serving frontend at http://0.0.0.0:3000\n"
            "  iPhone mic requires HTTPS — run ./make-certs.sh first."
        )

    server.serve_forever()
