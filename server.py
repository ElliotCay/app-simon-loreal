"""Spy Rush: static frontend + same-origin JSON API + server-local SQLite."""
import hashlib
import json
import logging
import mimetypes
import os
from pathlib import Path
import random
import re
import secrets
import sqlite3
import time
import unicodedata
from http.cookies import SimpleCookie
from socketserver import ThreadingMixIn
from urllib.parse import urlsplit
from uuid import UUID, uuid4
from wsgiref.simple_server import WSGIServer, make_server

ROOT = Path(__file__).resolve().parent
STATIC = {'index.html', 'classement.html', 'style.css', 'sprites.js', 'game.js',
          'leaderboard.js', 'ranking.js', 'assets/oa-logo.svg', 'robots.txt',
          'assets/fonts/barlow-condensed-600.woff2', 'assets/fonts/barlow-condensed-700.woff2',
          'assets/fonts/dm-sans.woff2'}
COOKIE = 'spy_player'

# Game rules. They mirror DIFFICULTY and `types` in game.js: the server draws every round
# and recomputes its score, so the browser never decides what a round is worth.
RULES = {
    'duration': 30000,
    'spawnDelay': (450, 170),
    'targetLifetime': (950, 450),
    'maxTargets': (2, 6),
    'goodChance': (0.60, 0.45),
    'comboStep': 4,
    'comboMax': 5,
}
POINTS = (100, 100, 100, -150, -150, -200)
GOOD_KINDS = [kind for kind, points in enumerate(POINTS) if points > 0]
BAD_KINDS = [kind for kind, points in enumerate(POINTS) if points < 0]
GAME_TTL = 3600  # seconds during which a started round can still be submitted
NAME = re.compile(r"[^\W\d_]+(?:[ '’\-][^\W\d_]+)*")


def settings(elapsed):
    curve = min(1, max(0, elapsed / RULES['duration'])) ** 2
    return {field: RULES[field][0] + (RULES[field][1] - RULES[field][0]) * curve
            for field in ('spawnDelay', 'targetLifetime', 'maxTargets', 'goodChance')}


def build_targets(rng=None):
    """Draw a round: a list of [appears_at_ms, lifetime_ms, kind], independent of the player's actions."""
    rng = rng or random.SystemRandom()
    targets, at = [], 0
    while at < RULES['duration']:
        d = settings(at)
        alive = sum(1 for start, life, _ in targets if start + life > at)
        if alive < int(d['maxTargets'] + 0.5):
            kind = rng.choice(GOOD_KINDS if rng.random() < d['goodChance'] else BAD_KINDS)
            targets.append([at, int(d['targetLifetime']), kind])
        at += int(d['spawnDelay'])
    return targets


def replay(targets, hits):
    """Recompute a round from its hits ([target_index, ms]); ValueError if they cannot have happened."""
    if not isinstance(hits, list) or len(hits) > len(targets):
        raise ValueError()
    seen, last, score, good, errors, streak = set(), 0, 0, 0, 0, 0
    for hit in hits:
        if not isinstance(hit, list) or len(hit) != 2 or any(type(value) is not int for value in hit):
            raise ValueError()
        index, at = hit
        if not 0 <= index < len(targets) or index in seen or at < last:
            raise ValueError()
        start, life, kind = targets[index]
        if not start <= at < min(start + life, RULES['duration']):
            raise ValueError()
        seen.add(index)
        last = at
        if POINTS[kind] > 0:
            score += POINTS[kind] * min(RULES['comboMax'], 1 + streak // RULES['comboStep'])
            streak += 1
            good += 1
        else:
            score += POINTS[kind]
            streak = 0
            errors += 1
    return score, good, errors


def clean_name(value):
    """Return (display name, grouping key) for a 'First Last' name; ValueError otherwise."""
    if not isinstance(value, str):
        raise ValueError()
    name = ' '.join(value.split())
    if not 3 <= len(name) <= 40 or ' ' not in name or not NAME.fullmatch(name):
        raise ValueError()
    folded = unicodedata.normalize('NFKD', name.replace('’', "'")).casefold()
    return name, ''.join(c for c in folded if not unicodedata.combining(c))


def create_app(db_path=None, clock=time.time):
    path = Path(db_path or os.environ.get('SPY_DB_PATH', ROOT / 'data' / 'spy-rush.sqlite3'))
    path.parent.mkdir(parents=True, exist_ok=True)
    retention_days = int(os.environ.get('RETENTION_DAYS', '365'))

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
            CREATE TABLE IF NOT EXISTS games (
                id TEXT PRIMARY KEY,
                player TEXT NOT NULL REFERENCES players(token_hash) ON DELETE CASCADE,
                targets TEXT NOT NULL,
                started_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                player TEXT NOT NULL REFERENCES players(token_hash) ON DELETE CASCADE,
                game_id TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL CHECK(length(name) BETWEEN 3 AND 40),
                name_key TEXT NOT NULL,
                score INTEGER NOT NULL CHECK(score BETWEEN -20000 AND 40000),
                good INTEGER NOT NULL,
                errors INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS scores_by_name ON scores(name_key, score DESC);
        ''')
        # Rounds saved before scores were verified; no longer read, only purged and erased.
        legacy = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attempts'").fetchone()
    db.close()
    last_purge = [0.0]

    def purge(db):
        """Apply the retention period; at most once an hour per process."""
        if clock() - last_purge[0] < 3600:
            return
        last_purge[0] = clock()
        cutoff = f'-{retention_days} days'
        with db:
            db.execute('DELETE FROM games WHERE started_at < ?', (clock() - GAME_TTL,))
            db.execute("DELETE FROM scores WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now',?)", (cutoff,))
            if legacy:
                db.execute("DELETE FROM attempts WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now',?)", (cutoff,))
            db.execute(f'''DELETE FROM players WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now',?)
                AND token_hash NOT IN (SELECT player FROM scores) AND token_hash NOT IN (SELECT player FROM games)
                {'AND token_hash NOT IN (SELECT player FROM attempts)' if legacy else ''}''', (cutoff,))

    def ranking(db, token_hash):
        """Best score of each name, best first. Ties go to whoever got there first."""
        return db.execute('''SELECT name, name_key, score, mine FROM (
                SELECT name, name_key, score, created_at, id,
                    ROW_NUMBER() OVER (PARTITION BY name_key ORDER BY score DESC, created_at, id) AS position,
                    MAX(player=?) OVER (PARTITION BY name_key) AS mine
                FROM scores) WHERE position=1 ORDER BY score DESC, created_at, id''', (token_hash,)).fetchall()

    def result(db, token_hash, row):
        """What the end screen shows: this round, the player's best and their place in the ranking."""
        rows = ranking(db, token_hash)
        rank = next(i for i, other in enumerate(rows) if other['name_key'] == row['name_key'])
        beaten = db.execute('SELECT 1 FROM scores WHERE name_key=? AND id<>? AND score>=?',
                            (row['name_key'], row['id'], row['score'])).fetchone()
        return {'score': row['score'], 'good': row['good'], 'errors': row['errors'],
                'best': rows[rank]['score'], 'new_best': not beaten, 'rank': rank + 1, 'players': len(rows),
                'gap': rows[rank - 1]['score'] - rows[rank]['score'] if rank else None}

    def app(environ, start_response):
        def reply(status, value, extra=(), content_type='application/json; charset=utf-8'):
            body = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode()
            headers = [('Content-Type', content_type), ('Content-Length', str(len(body))),
                       ('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff'),
                       ('Referrer-Policy', 'same-origin'),
                       ('X-Robots-Tag', 'noindex, nofollow'), *extra]
            start_response(status, headers)
            return [b'' if environ['REQUEST_METHOD'] == 'HEAD' else body]

        def read_json(fields):
            length = int(environ.get('CONTENT_LENGTH') or 0)
            if not 0 < length <= 4096:
                raise OverflowError()
            data = json.loads(environ['wsgi.input'].read(length))
            if not isinstance(data, dict) or set(data) != fields:
                raise ValueError()
            return data

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
        if method not in ('GET', 'POST', 'DELETE'):
            return reply('405 Method Not Allowed', {'error': 'Méthode non autorisée.'})
        expected_origin = os.environ.get('PUBLIC_ORIGIN') or (
            environ.get('wsgi.url_scheme', 'http') + '://' + environ.get('HTTP_HOST', ''))
        secure = '; Secure' if expected_origin.startswith('https://') else ''
        if method != 'GET':
            if environ.get('HTTP_ORIGIN', expected_origin) != expected_origin:
                return reply('403 Forbidden', {'error': 'Origine non autorisée.'})
            if method == 'POST' and environ.get('CONTENT_TYPE', '').split(';')[0] != 'application/json':
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
                return reply('200 OK', {'ok': True}, [('Set-Cookie',
                    f'{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000{secure}')])
            if route == '/api/games' and method == 'POST':
                if not player:
                    return reply('401 Unauthorized', {'error': 'Activez les cookies pour jouer au classement.'})
                purge(db)
                game_id, targets = str(uuid4()), build_targets()
                with db:
                    db.execute('INSERT INTO games(id,player,targets,started_at) VALUES(?,?,?,?)',
                               (game_id, token_hash, json.dumps(targets), clock()))
                return reply('200 OK', {'game_id': game_id, 'targets': targets})
            if route != '/api/scores':
                return reply('404 Not Found', {'error': 'API introuvable.'})
            if method == 'GET':
                return reply('200 OK', [{'name': row['name'], 'score': row['score'], 'is_mine': bool(row['mine'])}
                                        for row in ranking(db, token_hash if player else '')])
            if method == 'DELETE':
                # Right to erasure, self-service: everything recorded from this browser.
                deleted = 0
                if player:
                    with db:
                        deleted = db.execute('DELETE FROM scores WHERE player=?', (token_hash,)).rowcount
                        if legacy:
                            deleted += db.execute('DELETE FROM attempts WHERE player=?', (token_hash,)).rowcount
                        db.execute('DELETE FROM players WHERE token_hash=?', (token_hash,))
                return reply('200 OK', {'deleted': deleted}, [('Set-Cookie',
                    f'{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}')])
            if not player:
                return reply('401 Unauthorized', {'error': 'Activez les cookies pour enregistrer votre partie.'})
            try:
                data = read_json({'name', 'game_id', 'hits'})
                name, name_key = clean_name(data['name'])
                game_id = str(UUID(data['game_id']))
            except OverflowError:
                return reply('413 Content Too Large', {'error': 'Requête trop volumineuse ou vide.'})
            except (ValueError, TypeError, AttributeError, UnicodeError):
                return reply('400 Bad Request', {'error': 'Nom ou partie invalide.'})
            saved = db.execute('SELECT * FROM scores WHERE game_id=? AND player=?', (game_id, token_hash)).fetchone()
            if not saved:
                game = db.execute('SELECT * FROM games WHERE id=? AND player=?', (game_id, token_hash)).fetchone()
                if not game or clock() - game['started_at'] > GAME_TTL:
                    return reply('400 Bad Request', {'error': 'Partie inconnue ou expirée.'})
                # A round lasts 30 s on the server's clock too: it cannot be handed in early.
                if clock() - game['started_at'] < RULES['duration'] / 1000 - 1:
                    return reply('400 Bad Request', {'error': 'Partie invalide.'})
                try:
                    score, good, errors = replay(json.loads(game['targets']), data['hits'])
                except ValueError:
                    return reply('400 Bad Request', {'error': 'Partie invalide.'})
                with db:
                    db.execute('''INSERT INTO scores(player,game_id,name,name_key,score,good,errors)
                        VALUES(?,?,?,?,?,?,?) ON CONFLICT(game_id) DO NOTHING''',
                        (token_hash, game_id, name, name_key, score, good, errors))
                saved = db.execute('SELECT * FROM scores WHERE game_id=? AND player=?', (game_id, token_hash)).fetchone()
            if saved['name'] != name:
                return reply('409 Conflict', {'error': 'Cette partie a déjà été enregistrée sous un autre nom.'})
            return reply('200 OK', result(db, token_hash, saved))
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
