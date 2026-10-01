# -*- coding: utf-8 -*-
"""`chat_notes` 的语音接线：只读转写缓存，把 `[语音]` 换成文本。

为什么值得单独测：这条线的**失败方式是静默的** —— 缓存里没有那条转写时，行为与"接线根本没接上"
**逐字相同**（都是 `[语音]`）。实测真库时我拿到的正是 0 命中，那一刻分不清是接线坏了还是数据就是
没有；所以这里用手写夹具把两件事分开：给了转写就必须用上，没给就必须原样不动。
"""
import importlib.util
import os
import sys
import unittest

SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts')
sys.path.insert(0, SCRIPTS)


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(SCRIPTS, name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cn = load('chat_notes')
wv = load('wechat_voice')


class FakeCache:
    """`TranscriptCache` 的形状：内容寻址的 get/put。"""

    def __init__(self, mapping):
        self.mapping = mapping

    def get(self, key):
        return self.mapping.get(key)

    def put(self, key, text):
        self.mapping[key] = text


def voice(local_id, blob):
    """一条语音消息（字段名照 `nt_decrypt` 的真实输出：`localType` / `localId`）。"""
    return {'localType': 34, 'localId': local_id, 'parsedContent': '[语音]'}


class VoiceWiringTests(unittest.TestCase):

    def test_有转写就换掉占位符_并标明机器转写(self):
        blob = b'\x02SILK' + b'x' * 40
        cache = FakeCache({wv.voice_key(blob): '河倉河倉，隔壁河倉啊'})
        messages = [voice(1540, blob), {'localType': 1, 'parsedContent': '在的'}]
        enriched, pending = cn.attach_voice_transcripts(messages, {1540: blob}, cache)
        self.assertEqual((enriched, pending), (1, 0))
        self.assertIn('河倉河倉', messages[0]['parsedContent'])
        # **标签必须写明未校对**：那是别人说的话被机器认出来的字，粤语/方言会有错。
        # 不标的话模型会把它当事实原文（与概念页 `verified: false` 是同一条纪律）。
        self.assertIn(cn.VOICE_LABEL, messages[0]['parsedContent'])
        self.assertEqual(messages[1]['parsedContent'], '在的', '非语音消息一个字都不该动')

    def test_没转写就原样不动_并计入缺的条数(self):
        blob = b'\x02SILK' + b'y' * 40
        messages = [voice(1, blob)]
        enriched, pending = cn.attach_voice_transcripts(messages, {1: blob}, FakeCache({}))
        self.assertEqual((enriched, pending), (0, 1))
        self.assertEqual(messages[0]['parsedContent'], '[语音]', '缺的保持原样，不许编')

    def test_空转写算缺的_不算用上(self):
        """识别器对纯静音/杂音会写下空串（`cache.put(key, '')`）——
        那是"识别了但没有内容"，不能当成"用上了"，否则报告里那个数字会虚高。"""
        blob = b'\x02SILK' + b'z' * 40
        messages = [voice(2, blob)]
        enriched, pending = cn.attach_voice_transcripts(messages, {2: blob}, FakeCache({wv.voice_key(blob): ''}))
        self.assertEqual((enriched, pending), (0, 1))
        self.assertEqual(messages[0]['parsedContent'], '[语音]')

    def test_映射里没有这条时不算崩_算缺(self):
        blob = b'\x02SILK' + b'w' * 40
        messages = [voice(3, blob)]
        enriched, pending = cn.attach_voice_transcripts(messages, {}, FakeCache({}))
        self.assertEqual((enriched, pending), (0, 1))

    def test_缓存目录只有一份定义(self):
        """三处读同一份缓存：`wechat_voice`（拥有它）、`chat_notes`、`export_chat_html`。

        2026-10-01 **真踩过**：`chat_notes` 拿自己的输出目录（`output/chat-notes`）去拼缓存路径，
        于是它读的是**自己刚建出来的那个空目录**，而真缓存在 `output/.voice-cache`。当时报告里的
        "命中 16 条"是自洽的、看不出问题 —— 只有对比缓存条数才露馅（16 vs 1788）。
        位置只要有两份定义就会漂，所以这里钉住：都引用 `wechat_voice.DEFAULT_CACHE_DIR`。
        """
        self.assertEqual(os.path.normpath(cn.VOICE_CACHE_DIR),
                         os.path.normpath(wv.DEFAULT_CACHE_DIR))
        with open(os.path.join(SCRIPTS, 'export_chat_html.py'), encoding='utf-8') as handle:
            self.assertIn('wechat_voice.DEFAULT_CACHE_DIR', handle.read(),
                          '导出侧也该引用同一份定义，而不是自己拼一个路径')

    def test_标签是常量_写死在模块上(self):
        # 契约：标签由这里定义，别处（报告、文档）引用它，避免两处各写一份
        self.assertTrue(cn.VOICE_LABEL.startswith('[语音'))
        self.assertIn('未校对', cn.VOICE_LABEL)
        self.assertEqual(cn.VOICE_TYPE, 34)


if __name__ == '__main__':
    unittest.main()
