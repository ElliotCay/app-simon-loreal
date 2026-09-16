import concurrent.futures
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import create_app


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'scores.sqlite3'
        self.app = create_app(self.path)

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

    def post(self, cookie, score, attempt=None, name='Même pseudo'):
        return self.call('POST', '/api/attempts', {'name': name, 'score': score, 'attempt_id': attempt or str(uuid4())}, cookie)

    def test_concurrent_attempts_and_identity(self):
        players = [self.player() for _ in range(8)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            futures = [pool.submit(self.post, players[i % 8], i-20) for i in range(64)]
            for future in futures:
                self.assertEqual(future.result()['status'], 200)
        result = self.call('GET', '/api/attempts', cookie=players[0])
        self.assertEqual(result['status'], 200)
        rows = result['body']
        self.assertEqual(len(rows), 64)
        self.assertEqual(sum(row['is_mine'] for row in rows), 8)
        self.assertEqual([r['score'] for r in rows], list(range(43, -21, -1)))
        self.assertTrue(all('player' not in r and 'token_hash' not in r for r in rows))
        self.assertFalse(any(r['is_mine'] for r in self.call('GET', '/api/attempts')['body']))
        self.app = create_app(self.path)
        self.assertEqual(len(self.call('GET', '/api/attempts')['body']), 64, 'survives restart')

    def test_idempotent_parallel_retries(self):
        cookie, attempt = self.player(), str(uuid4())
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            rows = list(pool.map(lambda _: self.post(cookie, 100, attempt), range(24)))
        self.assertTrue(all(r['status'] == 200 for r in rows))
        self.assertEqual(len({r['body']['id'] for r in rows}), 1)
        self.assertEqual(len(self.call('GET', '/api/attempts')['body']), 1)
        self.assertEqual(self.post(cookie, 200, attempt)['status'], 409)
        self.assertEqual(self.post(self.player(), 100, attempt)['status'], 200)

    def test_validation_and_private_files(self):
        cookie = self.player()
        for name, score in [('',100), ('a'*17,100), ('a',True), ('a',1.5), ('a',20001), ('a',-10001)]:
            self.assertEqual(self.post(cookie, score, name=name)['status'], 400)
        self.assertEqual(self.post('',100)['status'],401)
        self.assertEqual(self.call('POST','/api/session',{},HTTP_ORIGIN='https://foreign.example')['status'],403)
        self.assertEqual(self.call('POST','/api/session',{},CONTENT_TYPE='text/plain')['status'],415)
        for path in ['/server.py','/data/spy-rush.sqlite3','/.git/config','/../README.md','/supabase.sql']:
            self.assertEqual(self.call('GET',path)['status'],404)
        for path in ['/','/index.html','/classement.html','/assets/loreal-logo.svg','/leaderboard.js']:
            self.assertEqual(self.call('GET',path)['status'],200)


if __name__ == '__main__':
    unittest.main()
