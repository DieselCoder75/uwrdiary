#!/bin/bash
cd "$(dirname "$0")"
exec /usr/bin/python3 -c "
import http.server, socketserver, os
os.chdir('/Users/janne.lind/Documents/My Apps/Uppis')
class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
with socketserver.TCPServer(('', 3000), Handler) as httpd:
    httpd.serve_forever()
"
