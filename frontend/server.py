"""
HTTP/1.1 static file server with range-request support.
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

    def log_message(self, format, *args):
        pass  # suppress per-request access logs


class QuietHTTPServer(HTTPServer):
    def handle_error(self, request, client_address):
        import traceback
        exc = traceback.format_exc()
        if "BrokenPipeError" in exc or "ConnectionResetError" in exc:
            return  # normal browser disconnects — ignore
        super().handle_error(request, client_address)


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = QuietHTTPServer(("0.0.0.0", 3000), HTTP11Handler)

    if CERT.exists() and KEY.exists():
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(str(CERT), str(KEY))
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        print("Serving frontend at https://0.0.0.0:3000  (HTTPS — iPhone mic enabled)")
    else:
        print(
            "Serving frontend at http://0.0.0.0:3000\n"
            "  iPhone mic requires HTTPS — run ./make-certs.sh first."
        )

    server.serve_forever()
