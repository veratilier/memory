"""Loopback-only development server. Do not expose directly to the Internet."""
import argparse
import json
import secrets
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from memory import Memory


def make_server(db_path, port=8787):
    memory = Memory(db_path)
    token = secrets.token_urlsafe(32)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Never print chat bodies or tokens.

        def send(self, status, data, content_type='application/json; charset=utf-8'):
            body = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'DENY')
            self.end_headers()
            self.wfile.write(body)

        def valid_host(self):
            return self.headers.get('Host') in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}')

        def do_GET(self):
            if not self.valid_host():
                return self.send(403, {'error': 'Invalid host'})
            if self.path == '/':
                page = Path(__file__).with_name('static').joinpath('index.html').read_text()
                return self.send(200, page.replace('__TOKEN__', token).encode(), 'text/html; charset=utf-8')
            if self.headers.get('X-Memory-Token') != token:
                return self.send(403, {'error': 'Forbidden'})
            if self.path == '/api/memories':
                return self.send(200, memory.listing())
            return self.send(404, {'error': 'Not found'})

        def do_POST(self):
            if not self.valid_host() or self.headers.get('X-Memory-Token') != token:
                return self.send(403, {'error': 'Forbidden'})
            try:
                n = int(self.headers.get('Content-Length', '0'))
                if not 0 < n <= 32768:
                    raise ValueError('请求大小超出限制')
                data = json.loads(self.rfile.read(n))
                if not isinstance(data, dict):
                    raise ValueError('请求应为JSON对象')
                if self.path == '/api/memories':
                    result = memory.add(**data)
                elif self.path == '/api/chat':
                    result = memory.chat(**data)
                else:
                    return self.send(404, {'error': 'Not found'})
                self.send(200, result)
            except (ValueError, TypeError, KeyError) as err:
                self.send(400, {'error': str(err)})
            except Exception:
                self.send(500, {'error': '内部错误；未确认操作成功。'})
    return HTTPServer(('127.0.0.1', port), Handler)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', default='data/memory.sqlite3')
    parser.add_argument('--port', default=8787, type=int)
    args = parser.parse_args()
    server = make_server(args.db, args.port)
    print(f'Open http://127.0.0.1:{server.server_port} — local prototype', flush=True)
    server.serve_forever()
