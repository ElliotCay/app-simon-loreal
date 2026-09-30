import concurrent.futures
import io
import json
import random
import re
import sqlite3
from html.parser import HTMLParser
import sys
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from server import build_targets, clean_name, create_app, replay

PAGES = ['/index.html', '/classement.html', '/confidentialite.html']


class PageTags(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))


def good_hits(targets, count=None):
    """Hit the good targets as they appear, at most `count` of them."""
    hits = [[i, at] for i, (at, _, kind) in enumerate(targets) if server.POINTS[kind] > 0]
    return hits if count is None else hits[:count]


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'scores.sqlite3'
        self.now = 1_000_000.0
        self.app = create_app(self.path, clock=lambda: self.now)

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, method, path, data=None, cookie='', **override):
        body = json.dumps(data).encode() if data is not None else b''
        environ = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'CONTENT_TYPE': 'application/json',
                   'CONTENT_LENGTH': str(len(body)), 'wsgi.input': io.BytesIO(body),
                   'HTTP_HOST': 'localhost:8000', 'wsgi.url_scheme': 'http', 'HTTP_COOKIE': cookie}
        environ.update(override)
        result = {}
        def response(status, headers):
            result.update(status=int(status.split()[0]), headers=dict(headers))
        raw = b''.join(self.app(environ, response))
        result['body'] = json.loads(raw) if raw and result['headers']['Content-Type'].startswith('application/json') else raw
        return result

    def player(self):
        result = self.call('POST', '/api/session', {})
        self.assertEqual(result['status'], 200)
        self.assertIn('HttpOnly', result['headers']['Set-Cookie'])
        return result['headers']['Set-Cookie'].split(';')[0]

    def start(self, cookie):
        result = self.call('POST', '/api/games', {}, cookie)
        self.assertEqual(result['status'], 200)
        return result['body']

    def play(self, cookie, name='Ada Lovelace', count=None):
        """Start a round, let its 30 seconds pass, hand in `count` good hits."""
        game = self.start(cookie)
        self.now += 31
        return self.call('POST', '/api/scores',
                         {'name': name, 'game_id': game['game_id'], 'hits': good_hits(game['targets'], count)}, cookie)

    def test_rules_match_the_client(self):
        source = (Path(server.ROOT) / 'game.js').read_text(encoding='utf8')
        for field, value in server.RULES.items():
            found = re.search(rf'\b{field}: (\[[^\]]+\]|[\d.]+)', source)
            self.assertIsNotNone(found, field)
            self.assertEqual(json.loads(found.group(1)), list(value) if isinstance(value, tuple) else value, field)
        self.assertEqual([int(points) for points in re.findall(r'points: (-?\d+) }', source)], list(server.POINTS))

    def test_drawn_rounds_and_replay(self):
        for seed in range(50):
            targets = build_targets(random.Random(seed))
            self.assertTrue(40 <= len(targets) <= 90)
            self.assertEqual(targets[0][0], 0)
            for at, life, kind in targets:
                self.assertTrue(0 <= at < 30000 and 550 <= life <= 1300 and 0 <= kind < 6)
            score, good, errors = replay(targets, good_hits(targets))
            self.assertEqual(errors, 0)
            self.assertTrue(0 < score <= 40000)
        targets = [[0, 1000, 0], [100, 1000, 1], [200, 1000, 2], [300, 1000, 0], [400, 1000, 1], [500, 1000, 3], [600, 1000, 0]]
        self.assertEqual(replay(targets, [[i, 900] for i in range(5)]), (600, 5, 0), 'fifth hit in a row is worth double')
        self.assertEqual(replay(targets, [[0, 10], [5, 600], [6, 700]]), (50, 2, 1), 'an error costs points and resets the combo')
        self.assertEqual(replay(targets, []), (0, 0, 0), 'ignored targets cost nothing')
        for hits in [[[0, 1000]], [[0, -1]], [[1, 50]], [[0, 10], [0, 20]], [[1, 500], [0, 400]], [[7, 10]],
                     [[0, 10.0]], [[0, True]], [[0]], 'x', [[0, 10]] * 8, [[-1, 10]]]:
            with self.subTest(hits=hits):
                self.assertRaises(ValueError, replay, targets, hits)
        self.assertRaises(ValueError, replay, [[29900, 1000, 0]], [[0, 30000]])

    def test_names(self):
        self.assertEqual(clean_name('  Élodie   Dupont-Martin '), ('Élodie Dupont-Martin', 'elodie dupont-martin'))
        self.assertEqual(clean_name('Jean D’Ormesson')[1], clean_name("JEAN d'ormesson")[1])
        for name in ['', 'Ada', 'A B' * 20, 'Ada Lovelace2', 'ada@example.com x', 'Ada  -Lovelace', 'Ada\nLovelace!', 42, None]:
            with self.subTest(name=name):
                self.assertRaises(ValueError, clean_name, name)

    def test_score_is_computed_by_the_server(self):
        cookie = self.player()
        game = self.start(cookie)
        hits = good_hits(game['targets'])
        body = {'name': 'Ada Lovelace', 'game_id': game['game_id'], 'hits': hits}
        self.assertEqual(self.call('POST', '/api/scores', body, cookie)['status'], 400, 'handed in before 30 s')
        self.now += 31
        self.assertEqual(self.call('POST', '/api/scores', dict(body, score=20000), cookie)['status'], 400)
        self.assertEqual(self.call('POST', '/api/scores', dict(body, hits=hits + [[hits[0][0], 29999]]), cookie)['status'], 400)
        self.assertEqual(self.call('POST', '/api/scores', body, self.player())['status'], 400, 'someone else’s round')
        self.assertEqual(self.call('POST', '/api/scores', dict(body, game_id=str(uuid4())), cookie)['status'], 400)
        self.assertEqual(self.call('GET', '/api/scores')['body'], [])
        saved = self.call('POST', '/api/scores', body, cookie)
        self.assertEqual(saved['status'], 200)
        self.assertEqual(saved['body']['score'], replay(game['targets'], hits)[0])
        self.assertEqual(saved['body'] | {'score': 0, 'good': 0, 'best': 0},
                         {'score': 0, 'good': 0, 'errors': 0, 'best': 0, 'new_best': True, 'rank': 1, 'players': 1, 'gap': None})
        late = self.start(cookie)
        self.now += server.GAME_TTL + 1
        self.assertEqual(self.call('POST', '/api/scores', {'name': 'Ada Lovelace', 'game_id': late['game_id'], 'hits': []}, cookie)['status'], 400)

    def test_idempotent_parallel_retries(self):
        cookie = self.player()
        game = self.start(cookie)
        self.now += 31
        body = {'name': 'Ada Lovelace', 'game_id': game['game_id'], 'hits': good_hits(game['targets'], 3)}
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            rows = list(pool.map(lambda _: self.call('POST', '/api/scores', body, cookie), range(24)))
        self.assertTrue(all(r['status'] == 200 and r['body']['score'] == 300 for r in rows))
        self.assertEqual(self.call('GET', '/api/scores')['body'], [{'name': 'Ada Lovelace', 'score': 300, 'is_mine': False}])
        self.assertEqual(self.call('POST', '/api/scores', dict(body, name='Alan Turing'), cookie)['status'], 409)
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM scores').fetchone()[0], 1)

    def test_ranking_keeps_the_best_score_of_each_name(self):
        phone, laptop, other = self.player(), self.player(), self.player()
        self.assertEqual(self.play(phone, 'Ada Lovelace', 2)['body']['score'], 200)
        best = self.play(laptop, 'ada  LOVELACE', 4)['body']
        self.assertEqual((best['score'], best['new_best'], best['players']), (400, True, 1))
        again = self.play(phone, 'Ada Lovelace', 1)['body']
        self.assertEqual((again['score'], again['best'], again['new_best'], again['rank']), (100, 400, False, 1))
        first = self.play(other, 'Alan Turing', 5)['body']
        self.assertEqual((first['score'], first['rank'], first['players'], first['gap']), (600, 1, 2, None))
        behind = self.play(phone, 'Ada Lovelace', 3)['body']
        self.assertEqual((behind['rank'], behind['gap']), (2, 200))
        rows = self.call('GET', '/api/scores', cookie=phone)['body']
        self.assertEqual(rows, [{'name': 'Alan Turing', 'score': 600, 'is_mine': False},
                                {'name': 'ada LOVELACE', 'score': 400, 'is_mine': True}])
        self.assertTrue(all(set(row) == {'name', 'score', 'is_mine'} for row in rows), 'no date, no token')
        self.assertFalse(any(row['is_mine'] for row in self.call('GET', '/api/scores')['body']))
        self.app = create_app(self.path, clock=lambda: self.now)
        self.assertEqual(len(self.call('GET', '/api/scores')['body']), 2, 'survives restart')

    def test_concurrent_players(self):
        players = [self.player() for _ in range(8)]
        games = [self.start(players[i % 8]) for i in range(64)]
        self.now += 31
        def submit(i):
            return self.call('POST', '/api/scores', {'name': f'Agent {"abcdefgh"[i % 8]}', 'game_id': games[i]['game_id'],
                                                     'hits': good_hits(games[i]['targets'], i % 5)}, players[i % 8])
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            self.assertTrue(all(result['status'] == 200 for result in pool.map(submit, range(64))))
        rows = self.call('GET', '/api/scores', cookie=players[0])['body']
        self.assertEqual(len(rows), 8)
        self.assertEqual(sum(row['is_mine'] for row in rows), 1)

    def test_erasure_and_retention(self):
        cookie, other = self.player(), self.player()
        self.play(cookie, 'Ada Lovelace', 2)
        self.play(cookie, 'Ada Lovelace', 3)
        self.play(other, 'Alan Turing', 1)
        self.assertEqual(self.call('DELETE', '/api/scores', HTTP_ORIGIN='https://foreign.example', cookie=cookie)['status'], 403)
        erased = self.call('DELETE', '/api/scores', cookie=cookie)
        self.assertEqual((erased['status'], erased['body']), (200, {'deleted': 2}))
        self.assertIn('Max-Age=0', erased['headers']['Set-Cookie'])
        self.assertEqual([row['name'] for row in self.call('GET', '/api/scores')['body']], ['Alan Turing'])
        self.assertEqual(self.call('POST', '/api/games', {}, cookie)['status'], 401, 'the identifier is gone too')
        self.assertEqual(self.call('DELETE', '/api/scores')['body'], {'deleted': 0})
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM players').fetchone()[0], 1)
            db.execute("UPDATE scores SET created_at='2000-01-01T00:00:00.000Z'")
        self.now += 3601
        self.start(other)
        self.assertEqual(self.call('GET', '/api/scores')['body'], [], 'scores past the retention period are purged')
        info = self.call('GET', '/api/privacy')['body']
        self.assertEqual(info, {'controller': '', 'contact': '', 'legal_basis': '', 'retention_days': 365})

    def test_legacy_attempts_are_erased_with_the_player(self):
        cookie = self.player()
        with sqlite3.connect(self.path) as db:
            db.execute('''CREATE TABLE attempts (id INTEGER PRIMARY KEY, player TEXT NOT NULL REFERENCES players(token_hash),
                attempt_id TEXT, name TEXT, score INTEGER, created_at TEXT DEFAULT '2026-01-01T00:00:00.000Z')''')
            db.execute("INSERT INTO attempts(player,attempt_id,name,score) SELECT token_hash,'a','Pseudo',100 FROM players")
        self.app = create_app(self.path, clock=lambda: self.now)
        self.assertEqual(self.call('GET', '/api/scores')['body'], [], 'unverified legacy rounds are not ranked')
        self.assertEqual(self.call('DELETE', '/api/scores', cookie=cookie)['body'], {'deleted': 1})

    def test_validation_and_private_files(self):
        cookie = self.player()
        for name in ['', 'Ada', 'a' * 20 + ' ' + 'b' * 20, 'Ada Lovelace 2', 12]:
            self.assertEqual(self.play(cookie, name, 1)['status'], 400)
        self.assertEqual(self.call('POST', '/api/games', {})['status'], 401)
        self.assertEqual(self.call('POST', '/api/scores', {'name': 'Ada Lovelace', 'game_id': str(uuid4()), 'hits': []})['status'], 401)
        self.assertEqual(self.call('POST', '/api/scores', {'name': 'Ada Lovelace', 'game_id': str(uuid4()), 'hits': [[0, 0]] * 900}, cookie)['status'], 413)
        self.assertEqual(self.call('POST','/api/session',{},HTTP_ORIGIN='https://foreign.example')['status'],403)
        self.assertEqual(self.call('POST','/api/session',{},CONTENT_TYPE='text/plain')['status'],415)
        self.assertEqual(self.call('PUT', '/api/scores', {}, cookie)['status'], 405)
        self.assertEqual(self.call('GET', '/api/attempts')['status'], 404)
        for path in ['/server.py','/data/spy-rush.sqlite3','/.git/config','/../README.md','/supabase.sql']:
            self.assertEqual(self.call('GET',path)['status'],404)
        for path in ['/','/assets/oa-logo.svg','/leaderboard.js','/privacy.js', *PAGES]:
            self.assertEqual(self.call('GET',path)['status'],200)

    def test_fonts_are_self_hosted(self):
        font = self.call('GET', '/assets/fonts/dm-sans.woff2')
        self.assertEqual(font['status'], 200)
        self.assertEqual(font['headers']['Content-Type'], 'font/woff2')
        for path in [*PAGES, '/style.css']:
            with self.subTest(path=path):
                body = self.call('GET', path)['body'].decode()
                self.assertNotIn('googleapis', body)
                self.assertNotIn('gstatic', body)

    def test_robots_file_and_headers(self):
        for method in ['GET', 'HEAD']:
            response = self.call(method, '/robots.txt')
            self.assertEqual(response['status'], 200)
            self.assertTrue(response['headers']['Content-Type'].startswith('text/plain'))
            self.assertEqual(response['headers']['Content-Length'], '26')
            self.assertEqual(response['body'], b'User-agent: *\nDisallow: /\n' if method == 'GET' else b'')
        for path in ['/', *PAGES, '/api/scores', '/api/privacy', '/missing']:
            with self.subTest(path=path):
                response = self.call('GET', path)
                self.assertEqual(response['headers']['X-Robots-Tag'], 'noindex, nofollow')
        session = self.call('POST', '/api/session', {})
        self.assertEqual(session['headers']['X-Robots-Tag'], 'noindex, nofollow')

    def test_public_pages_hide_company_brand_and_prevent_indexing(self):
        for path in PAGES:
            with self.subTest(path=path):
                page = self.call('GET', path)['body'].decode()
                parser = PageTags()
                parser.feed(page)
                head = next(i for i, (tag, _) in enumerate(parser.tags) if tag == 'head')
                self.assertEqual(parser.tags[head + 1], ('meta', {'name': 'robots', 'content': 'noindex, nofollow'}))
                self.assertTrue(any(tag == 'img' and attrs.get('src') == 'assets/oa-logo.svg'
                                    and attrs.get('alt') == 'OA' for tag, attrs in parser.tags))
                self.assertTrue(any(tag == 'a' and attrs.get('href') == 'confidentialite.html' for tag, attrs in parser.tags))
                self.assertIn('supprimés à la fermeture de la page le 3 décembre 2026', page)
                self.assertNotIn('loreal', page.lower())
                self.assertNotIn('oréal', page.lower())
        self.assertEqual(self.call('GET', '/assets/loreal-logo.svg')['status'], 404)

    def test_scores_reject_additional_personal_fields(self):
        cookie = self.player()
        game = self.start(cookie)
        self.now += 31
        body = {'name': 'Ada Lovelace', 'game_id': game['game_id'], 'hits': []}
        for field in ['email', 'employee_id', 'team']:
            with self.subTest(field=field):
                self.assertEqual(self.call('POST', '/api/scores', dict(body, **{field: 'extra'}), cookie)['status'], 400)
        self.assertEqual(self.call('GET', '/api/scores')['body'], [])
        self.assertEqual(self.call('POST', '/api/scores', body, cookie)['status'], 200)


if __name__ == '__main__':
    unittest.main()
