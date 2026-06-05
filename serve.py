#!/usr/bin/env python3
import http.server, socketserver, os

os.chdir(os.path.dirname(os.path.abspath(__file__)))
handler = http.server.SimpleHTTPRequestHandler
handler.log_message = lambda *a: None  # suppress logs

with socketserver.TCPServer(("", 3000), handler) as httpd:
    httpd.serve_forever()
