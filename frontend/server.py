"""HTTP/1.1 static file server with range-request support for video playback."""
import os
from http.server import HTTPServer, SimpleHTTPRequestHandler


class HTTP11Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send_response(self, code, message=None):
        super().send_response(code, message)
        self.send_header("Accept-Ranges", "bytes")


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = HTTPServer(("", 3000), HTTP11Handler)
    print("Serving frontend at http://localhost:3000")
    server.serve_forever()
