"""Spy Rush: static frontend + same-origin JSON API + server-local SQLite."""
import hashlib
import json
import logging
import mimetypes
import os
from pathlib import Path
import secrets
import sqlite3
from http.cookies import SimpleCookie
from socketserver import ThreadingMixIn
from urllib.parse import urlsplit
from uuid import UUID
from wsgiref.simple_server import WSGIServer, make_server

ROOT = Path(__file__).resolve().parent
STATIC = {'index.html', 'classement.html', 'style.css', 'sprites.js', 'game.js',
          'leaderboard.js', 'ranking.js', 'assets/oa-logo.svg', 'robots.txt'}
COOKIE = 'spy_player'


def create_app(db_path=None):
    path = Path(db_path or os.environ.get('SPY_DB_PATH', ROOT / 'data' / 'spy-rush.sqlite3'))
    path.parent.mkdir(parents=True, exist_ok=True)

    def connect():
        db = sqlite3.connect(path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        return db

    with connect() as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
            CREATE TABLE IF NOT EXISTS players (
                token_hash TEXT PRIMARY KEY,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE TABLE IF NOT EXISTS attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                player TEXT NOT NULL REFERENCES players(token_hash),
                attempt_id TEXT NOT NULL,
                name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 16),
                score INTEGER NOT NULL CHECK(score BETWEEN -10000 AND 20000),
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                UNIQUE(player, attempt_id)
            );
            CREATE INDEX IF NOT EXISTS attempts_ranking ON attempts(score DESC, created_at ASC, id ASC);
        ''')
    db.close()

    def app(environ, start_response):
        def reply(status, value, extra=(), content_type='application/json; charset=utf-8'):
            body = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode()
            headers = [('Content-Type', content_type), ('Content-Length', str(len(body))),
                       ('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff'),
                       ('Referrer-Policy', 'same-origin'),
                       ('X-Robots-Tag', 'noindex, nofollow'), *extra]
            start_response(status, headers)
            return [b'' if environ['REQUEST_METHOD'] == 'HEAD' else body]

        route = environ.get('PATH_INFO', '/')
        method = environ['REQUEST_METHOD']
        if not route.startswith('/api/'):
            if method not in ('GET', 'HEAD'):
                return reply('405 Method Not Allowed', {'error': 'Méthode non autorisée.'})
            filename = 'index.html' if route == '/' else route.lstrip('/')
            if filename not in STATIC:
                return reply('404 Not Found', {'error': 'Page introuvable.'})
            return reply('200 OK', (ROOT / filename).read_bytes(),
                         content_type=mimetypes.guess_type(filename)[0] or 'application/octet-stream')
        if method not in ('GET', 'POST'):
            return reply('405 Method Not Allowed', {'error': 'Méthode non autorisée.'})
        if method == 'POST':
            expected_origin = os.environ.get('PUBLIC_ORIGIN') or (
                environ.get('wsgi.url_scheme', 'http') + '://' + environ.get('HTTP_HOST', ''))
            if environ.get('HTTP_ORIGIN', expected_origin) != expected_origin:
                return reply('403 Forbidden', {'error': 'Origine non autorisée.'})
            if environ.get('CONTENT_TYPE', '').split(';')[0] != 'application/json':
                return reply('415 Unsupported Media Type', {'error': 'JSON requis.'})
        db = None
        try:
            db = connect()
            cookie = SimpleCookie()
            try:
                cookie.load(environ.get('HTTP_COOKIE', ''))
            except Exception:
                pass
            token = cookie[COOKIE].value if COOKIE in cookie else ''
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            player = db.execute('SELECT token_hash FROM players WHERE token_hash=?', (token_hash,)).fetchone()
            if route == '/api/session' and method == 'POST':
                if player:
                    return reply('200 OK', {'ok': True})
                token = secrets.token_urlsafe(32)
                token_hash = hashlib.sha256(token.encode()).hexdigest()
                with db:
                    db.execute('INSERT INTO players(token_hash) VALUES (?)', (token_hash,))
                secure = '; Secure' if expected_origin.startswith('https://') else ''
                return reply('200 OK', {'ok': True}, [('Set-Cookie',
                    f'{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000{secure}')])
            if route != '/api/attempts':
                return reply('404 Not Found', {'error': 'API introuvable.'})
            if method == 'GET':
                rows = db.execute('''SELECT id, name, score, created_at, player=? AS is_mine
                    FROM attempts ORDER BY score DESC, created_at ASC, id ASC''',
                    (token_hash if player else '',)).fetchall()
                return reply('200 OK', [dict(row, is_mine=bool(row['is_mine'])) for row in rows])
            if not player:
                return reply('401 Unauthorized', {'error': 'Activez les cookies pour enregistrer votre partie.'})
            try:
                length = int(environ.get('CONTENT_LENGTH') or 0)
                if not 0 < length <= 4096:
                    return reply('413 Content Too Large', {'error': 'Requête trop volumineuse ou vide.'})
                data = json.loads(environ['wsgi.input'].read(length))
                if not isinstance(data, dict) or set(data) != {'name', 'score', 'attempt_id'}:
                    raise ValueError()
                name, score, attempt_id = data.get('name'), data.get('score'), data.get('attempt_id')
                if not isinstance(name, str) or not 1 <= len(name.strip()) <= 16 or any(ord(c) < 32 for c in name):
                    raise ValueError()
                if type(score) is not int or not -10000 <= score <= 20000:
                    raise ValueError()
                attempt_id = str(UUID(attempt_id))
            except (ValueError, TypeError, AttributeError, UnicodeError):
                return reply('400 Bad Request', {'error': 'Pseudo, score ou identifiant de partie invalide.'})
            with db:
                db.execute('''INSERT INTO attempts(player,attempt_id,name,score) VALUES(?,?,?,?)
                    ON CONFLICT(player,attempt_id) DO NOTHING''', (token_hash, attempt_id, name.strip(), score))
                row = db.execute('''SELECT id,name,score,created_at FROM attempts
                    WHERE player=? AND attempt_id=?''', (token_hash, attempt_id)).fetchone()
            if row['name'] != name.strip() or row['score'] != score:
                return reply('409 Conflict', {'error': 'Cette partie a déjà été enregistrée avec un autre résultat.'})
            return reply('200 OK', dict(row, is_mine=True))
        except sqlite3.OperationalError:
            logging.exception('SQLite unavailable')
            return reply('503 Service Unavailable', {'error': 'Base occupée. Réessayez.'}, [('Retry-After', '2')])
        except Exception:
            logging.exception('API error')
            return reply('500 Internal Server Error', {'error': 'Erreur du serveur.'})
        finally:
            if db is not None:
                db.close()
    return app


class ThreadedServer(ThreadingMixIn, WSGIServer):
    daemon_threads = True


if __name__ == '__main__':
    host, port = os.environ.get('HOST', '127.0.0.1'), int(os.environ.get('PORT', '8000'))
    with make_server(host, port, create_app(), server_class=ThreadedServer) as server:
        print(f'Spy Rush: http://{host}:{port}', flush=True)
        server.serve_forever()
