import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from app import make_server
from memory import Memory


class FakeProvider:
    embedding_model = ''
    chat_model = 'test-only'
    def reply(self, messages):
        self.seen = messages
        return '测试模型已接收上下文（不是实际模型生成）。'


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.provider = FakeProvider()
        self.memory = Memory(str(Path(self.temp.name)/'db.sqlite'), self.provider)

    def add(self, text, **kw):
        return self.memory.add(text, '虚构测试来源', **kw)

    def test_automatic_retrieval_precedes_model(self):
        m = self.add('蓝色纸船放在书桌左边的木盒里。')
        result = self.memory.chat('蓝色纸船在哪里？', generate=True)
        self.assertEqual(result['status'], 'generated')
        self.assertIn(m['id'], self.provider.seen[1]['content'])
        self.assertEqual(self.provider.seen[-1]['content'], '蓝色纸船在哪里？')
        self.assertIn('虚构测试来源', self.provider.seen[1]['content'])

    def test_brief_followup_uses_same_conversation_only(self):
        m = self.add('蓝色纸船在木盒里。')
        self.memory.chat('蓝色纸船放哪了？', 'one')
        follow = self.memory.chat('那个呢？', 'one')
        self.assertIn(m['id'], [x['id'] for x in follow['retrieval']['selected']])
        other = self.memory.chat('那个呢？', 'two')
        self.assertEqual(other['retrieval']['episode_hits'], 0)

    def test_correction_excludes_old_but_keeps_origin(self):
        old = self.add('蓝色纸船在木盒里。')
        new = self.add('蓝色纸船在抽屉里。', supersedes=old['id'])
        ids = [x['id'] for x in self.memory.chat('蓝色纸船？')['retrieval']['selected']]
        self.assertIn(new['id'], ids)
        self.assertNotIn(old['id'], ids)
        self.assertEqual(len(self.memory.listing()), 2)

    def test_dreams_and_reflections_not_facts(self):
        self.add('蓝色纸船飞向月亮。', kind='dream')
        self.add('蓝色纸船让我觉得安心。', kind='reflection')
        self.assertEqual(self.memory.chat('蓝色纸船？')['retrieval']['selected'], [])

    def test_idempotence_and_conflict(self):
        one = self.add('虚构资料甲', source_id='external-1')
        two = self.add('虚构资料甲', source_id='external-1')
        self.assertEqual(one['id'], two['id'])
        with self.assertRaises(ValueError):
            self.add('不同资料', source_id='external-1')
        self.assertEqual(len(self.memory.listing()), 1)

    def test_vector_failure_is_visible_and_falls_back(self):
        self.add('蓝色纸船在木盒里。')
        self.provider.embedding_model = 'unavailable'
        def fail(text):
            raise OSError('test failure')
        self.provider.embed = fail
        r = self.memory.chat('蓝色纸船？')['retrieval']
        self.assertEqual(r['mode'], 'lexical')
        self.assertTrue(r['warnings'])
        self.assertEqual(r['episode_hits'], 1)

    def test_semantic_adapter_and_cache(self):
        self.add('蓝色纸船在木盒里。')
        self.provider.embedding_model = 'controlled-test-vectors'
        calls = []
        def embed(text):
            calls.append(text)
            return [1., 0.]
        self.provider.embed = embed
        r = self.memory.chat('折纸作品')['retrieval']
        self.assertEqual(r['mode'], 'hybrid')
        self.assertEqual(r['episode_hits'], 1)
        self.assertEqual(r['selected'][0]['reason'], '语义匹配')
        self.memory.chat('折纸作品', 'new')
        self.assertEqual(len(calls), 3)  # Two query embeddings, one cached document.

    def test_no_match_not_invented_and_pinned_preference(self):
        self.add('喜欢简短回答。', kind='preference')
        self.add('蓝色纸船在木盒里。')
        r = self.memory.chat('火山喷发的地质成因')['retrieval']
        self.assertEqual(r['episode_hits'], 0)
        self.assertEqual(len(r['selected']), 1)
        self.assertEqual(r['selected'][0]['kind'], 'preference')

    def test_model_error_not_success(self):
        def fail(messages):
            raise OSError('offline')
        self.provider.reply = fail
        r = self.memory.chat('你好', generate=True)
        self.assertEqual(r['status'], 'model_error')
        self.assertIsNone(r['reply'])

    def test_restart_persistence_and_unknown_date(self):
        one = self.add('蓝色纸船在木盒里。')
        restored = Memory(self.memory.path, self.provider)
        self.assertEqual(restored.listing()[0]['id'], one['id'])
        self.assertIsNone(restored.listing()[0]['occurred_at'])

    def test_context_budget(self):
        for i in range(8):
            self.add('蓝色纸船' * 200 + str(i))
        r = self.memory.chat('蓝色纸船')['retrieval']
        self.assertLessEqual(r['budget_chars_used'], 5000)
        self.assertLessEqual(r['episode_hits'], 6)

    def test_http_flow_and_token_gate(self):
        server = make_server(str(Path(self.temp.name)/'http.sqlite'), 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = f'http://127.0.0.1:{server.server_port}'
        with urlopen(base) as response:
            html = response.read().decode()
        token = html.split("const token='")[1].split("'")[0]
        def post(path, body, supplied=token):
            req = Request(base+path, json.dumps(body).encode(),
                          {'Content-Type':'application/json','X-Memory-Token':supplied})
            with urlopen(req) as response:
                return json.load(response)
        with self.assertRaises(HTTPError) as err:
            post('/api/memories', {'body':'private','source':'test'}, 'wrong')
        self.assertEqual(err.exception.code, 403)
        post('/api/memories', {'body':'蓝色纸船在木盒里。','source':'虚构测试'})
        r = post('/api/chat', {'message':'蓝色纸船？'})
        self.assertEqual(r['retrieval']['episode_hits'], 1)
        self.assertEqual(r['status'], 'context_ready')
        self.assertIsNone(r['reply'])


if __name__ == '__main__':
    unittest.main()
