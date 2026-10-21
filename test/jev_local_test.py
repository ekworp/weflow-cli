"""本机决策模型这条决策通路（D-127）：契约映射、无 key、失败取向。

为什么单独一个文件：**这条通路改变了三处语义**，每一处都能"看着正常但判错"：

* 一次请求只答一个 primitive —— 三个问题必须发三次，漏掉一个就是某个字段静默缺失；
* `score` 没有连续分，用 `choice` 在有序档位上选、把下标当分数 —— 下标映射错了，
  下游 `score_to_relevance` 会把"中"读成"高"，而日报不会报错；
* 概率是候选集上的相对 softmax、**未校准** —— 拿它当阈值会系统性偏。

另外两条与 native 不同、必须钉住：**不需要 key**（本机服务不鉴权），
**服务没起时抛 `JevError`**（调用方据此回退，而不是把异常漏到日报里）。

HTTP 全部打桩，这个文件不联网、也不需要模型。
"""
import importlib.util
import json
from pathlib import Path
import sys
import unittest
import urllib.error
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))

spec = importlib.util.spec_from_file_location('jev_client_local', SCRIPTS / 'jev_client.py')
jev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jev)

TOPICS = ['AI', '学术', '新闻']
LOCAL_URL = 'http://127.0.0.1:8090'


class FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload, ensure_ascii=False).encode('utf-8')

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def choice_body(choice, probabilities, confidence=0.9):
    return {'primitive': 'choice', 'distribution_complete': True, 'latency_ms': 120,
            'probabilities': probabilities, 'confidence': confidence, 'choice': choice}


def noul_body(probability):
    return {'primitive': 'noul', 'distribution_complete': True, 'latency_ms': 90,
            'probabilities': {'yes': probability, 'no': 1 - probability},
            'answer': 'yes' if probability >= 0.5 else 'no',
            'yes_probability': probability}


class Recorder:
    """记录每次请求的 (url, payload)，并按 primitive 返回预设响应。"""

    def __init__(self, bodies=None):
        self.calls = []
        self.bodies = bodies or {}

    def __call__(self, request, timeout=None):
        payload = json.loads(request.data.decode('utf-8')) if request.data else None
        self.calls.append((request.full_url, payload))
        primitive = (payload or {}).get('primitive')
        body = self.bodies.get(primitive)
        if body is None:
            raise AssertionError('no stubbed body for %r' % primitive)
        if isinstance(body, list):          # 同一个 primitive 的连续调用：按顺序取
            body = body.pop(0)
        return FakeResponse(body)


class ClientSelectionTests(unittest.TestCase):
    def test_配置_local_时返回本机客户端且不需要_key(self):
        client = jev.create_client(config={'judgeProvider': 'local',
                                          'judgeLocalUrl': LOCAL_URL})
        self.assertIsInstance(client, jev.LocalJevClient)
        self.assertEqual(client.base_url, LOCAL_URL)
        self.assertEqual(client.provider, 'local')

    def test_没配地址时用默认地址(self):
        client = jev.create_client(config={'judgeProvider': 'local'})
        self.assertEqual(client.base_url, jev.DEFAULT_JUDGE_LOCAL_URL)

    def test_打错的通路名仍回退_native(self):
        # 与 native 同一态度：拼错的配置不该把判断整层关掉。
        self.assertEqual(jev.create_client(config={'judgeProvider': 'lcocal'}), None)


class DecideTests(unittest.TestCase):
    def test_三个问题展开成四次调用且字段映射正确(self):
        # topic(choice) + relevance(score⇒2 个阈值 noul) + worth_including(noul) = 4 次
        recorder = Recorder({
            'choice': choice_body('AI', {'AI': 0.8, '学术': 0.15, '新闻': 0.05}),
            'noul': [noul_body(0.81), noul_body(0.22), noul_body(0.73)],
        })
        client = jev.LocalJevClient(LOCAL_URL)
        with patch.object(jev.urllib.request, 'urlopen', recorder):
            answers, usage = client.decide('标题：某篇讲 KV 缓存的文章\n\n正文：……',
                                           jev.build_questions(TOPICS))
        primitives = [(p or {}).get('primitive') for _, p in recorder.calls]
        self.assertEqual(primitives, ['choice', 'noul', 'noul', 'noul'],
                         'topic(choice) + relevance(≥中/≥高) + worth_including(noul)')
        self.assertEqual(answers['topic']['choice'], 'AI')
        self.assertEqual(answers['relevance']['score'], 1.0, '≥中 yes、≥高 no ⇒ 中')
        self.assertEqual(answers['worth_including']['noul'], 0.73)
        self.assertEqual(usage['provider'], 'local')
        self.assertEqual(usage['model'], 'apus-reflex-4b')

    def test_choice_答案能过契约校验(self):
        recorder = Recorder({'choice': choice_body('AI', {'AI': 0.8, '学术': 0.15, '新闻': 0.05})})
        client = jev.LocalJevClient(LOCAL_URL)
        with patch.object(jev.urllib.request, 'urlopen', recorder):
            answers, _ = client.decide('s', {'topic': {
                'type': 'choice', 'instructions': '属于哪个主题？',
                'criteria': {'AI': '', '学术': '', '新闻': ''}}})
        self.assertEqual(answers['topic']['choice'], 'AI')
        self.assertAlmostEqual(answers['topic']['probabilities']['AI'], 0.8)

    def test_choice_概率缺一个候选时当场抛(self):
        # 少了 "新闻"：这正是不该放行的形状——下游会把它当"没选到"。
        recorder = Recorder({'choice': choice_body('AI', {'AI': 0.8, '学术': 0.2})})
        client = jev.LocalJevClient(LOCAL_URL)
        with patch.object(jev.urllib.request, 'urlopen', recorder):
            with self.assertRaises(jev.JevError):
                client.decide('s', {'topic': {'type': 'choice', 'instructions': '?',
                                              'criteria': {'AI': '', '学术': '', '新闻': ''}}})

    def test_score_用阈值判断合成档位(self):
        # 3 档 ⇒ 2 个阈值问题：≥中 = 0.8(是)、≥高 = 0.2(否) ⇒ 1（中）。
        recorder = Recorder({'noul': [noul_body(0.8), noul_body(0.2)]})
        client = jev.LocalJevClient(LOCAL_URL)
        with patch.object(jev.urllib.request, 'urlopen', recorder):
            answers, _ = client.decide('s', {'relevance': {
                'type': 'score', 'instructions': '实用价值？',
                'criteria': jev.RELEVANCE_LEVELS}})
        self.assertEqual(answers['relevance']['score'], 1.0)
        self.assertEqual(jev.score_to_relevance(answers['relevance']['score']), '中')
        # 阈值问法要发 n-1 次，且每次都带固定 yes/no 候选（本机服务的契约要求）
        self.assertEqual(len(recorder.calls), 2)
        for _, payload in recorder.calls:
            self.assertEqual(payload['primitive'], 'noul')
            self.assertEqual([c['id'] for c in payload['criteria']], ['yes', 'no'])

    def test_noul_返回概率而不是布尔(self):
        recorder = Recorder({'noul': noul_body(0.73)})
        client = jev.LocalJevClient(LOCAL_URL)
        with patch.object(jev.urllib.request, 'urlopen', recorder):
            answers, _ = client.decide('s', {'worth_including': {
                'type': 'noul', 'instructions': '今天能用上？'}})
        self.assertEqual(answers['worth_including']['noul'], 0.73)
        self.assertNotIsInstance(answers['worth_including']['noul'], bool)

    def test_noul_请求带固定_yes_no_候选(self):
        recorder = Recorder({'noul': noul_body(0.5)})
        client = jev.LocalJevClient(LOCAL_URL)
        with patch.object(jev.urllib.request, 'urlopen', recorder):
            client.decide('s', {'worth_including': {'type': 'noul', 'instructions': '?'}})
        payload = recorder.calls[0][1]
        self.assertEqual([c['id'] for c in payload['criteria']], ['yes', 'no'])

    def test_服务没起时抛_JevError(self):
        client = jev.LocalJevClient('http://127.0.0.1:1', timeout=1)
        with self.assertRaises(jev.JevError):
            client.decide('s', {'topic': {'type': 'choice', 'instructions': '?',
                                          'criteria': {'AI': '', '学术': ''}}})

    def test_AI_类的低相关度被抬到中_其他主题不动(self):
        # 实测校准：本机对 AI 类系统性低估一档（211 篇：该类一致率 20.0%）。
        # 同一份答案在「学术」下不该被抬。
        bodies = {
            'choice': [choice_body('AI', {'AI': 0.9, '学术': 0.1}),
                       choice_body('学术', {'AI': 0.1, '学术': 0.9})],
            'noul': [noul_body(0.2), noul_body(0.1),       # AI：≥中 no、≥高 no ⇒ 低
                     noul_body(0.2), noul_body(0.1)],      # 学术：同样两问
        }
        recorder = Recorder(bodies)
        client = jev.LocalJevClient(LOCAL_URL)
        q = {'topic': {'type': 'choice', 'instructions': '?',
                       'criteria': {'AI': '', '学术': ''}},
             'relevance': {'type': 'score', 'instructions': '实用价值？',
                           'criteria': jev.RELEVANCE_LEVELS}}
        with patch.object(jev.urllib.request, 'urlopen', recorder):
            ai_answers, ai_usage = client.decide('s', q)
            ac_answers, _ = client.decide('s', q)
        self.assertEqual(ai_answers['relevance']['score'], 1.0, 'AI 的低被抬到中')
        self.assertTrue(ai_answers['relevance'].get('calibrated'))
        self.assertEqual(ai_usage['calibration'], {'AI': 1})
        self.assertEqual(ac_answers['relevance']['score'], 0.0, '学术不受影响')

    def test_不支持的题型抛_JevError(self):
        client = jev.LocalJevClient(LOCAL_URL)
        with self.assertRaises(jev.JevError):
            client.decide('s', {'weird': {'type': 'ordinal', 'instructions': '?'}})


if __name__ == '__main__':
    unittest.main()
