"""HTTP/1.1 static file server with range-request support for video playback."""
import os
import errno
from http.server import HTTPServer, SimpleHTTPRequestHandler


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
    server = QuietHTTPServer(("", 3000), HTTP11Handler)
    print("Serving frontend at http://localhost:3000")
    server.serve_forever()
