# -*- coding: utf-8 -*-
"""issue #12：`local_type == 1` 的正文三种形态都要解出来，且文本不截断。

修复前：BLOB 正文被置空 → `[未识别的消息类型 1]`；字符串正文被截到 200 字，
末尾的 `@所有人` 消失，下游关键词筛选静默漏消息。两条都钉在这里。
"""
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))

import zstandard  # noqa: E402
from nt_decrypt import _message_dict  # noqa: E402

LONG = '示例内容。' * 60 + '\n收到请回复！@所有人'
TAIL = '@所有人'


def build(raw, local_type=1, is_group=False, sender_map=None):
    return _message_dict(
        {'local_type': local_type, 'message_content': raw},
        sender_map or {}, {}, '', is_group=is_group)


class CompressedTextTests(unittest.TestCase):
    def test_plain_string_is_complete(self):
        r = build(LONG)
        self.assertEqual(len(r['parsedContent']), len(LONG))
        self.assertIn(TAIL, r['parsedContent'])
        self.assertEqual(r['content'], LONG)

    def test_zstd_blob_decodes(self):
        blob = zstandard.ZstdCompressor().compress(LONG.encode('utf-8'))
        r = build(blob)
        self.assertEqual(r['content'], LONG)
        self.assertIn(TAIL, r['parsedContent'])

    def test_bytearray_and_memoryview(self):
        """BLOB 从 sqlite 出来可能是 bytearray/memoryview，两种都要过。"""
        blob = zstandard.ZstdCompressor().compress(LONG.encode('utf-8'))
        for variant in (bytearray(blob), memoryview(blob)):
            r = build(variant)
            self.assertEqual(r['content'], LONG, type(variant).__name__)

    def test_plain_utf8_bytes_not_compressed(self):
        r = build(LONG.encode('utf-8'))
        self.assertEqual(r['content'], LONG)

    def test_long_text_is_not_truncated(self):
        body = '字' * 500
        r = build(body)
        self.assertEqual(len(r['parsedContent']), 500)

    def test_empty_and_corrupt_blob_do_not_crash(self):
        self.assertEqual(build(None)['content'], '')
        self.assertEqual(build(b'')['content'], '')
        # 声称是 zstd（有 magic 头）但内容是坏的：解不出就空串，不许抛
        broken = b'\x28\xb5\x2f\xfd' + b'not really zstd'
        self.assertEqual(build(broken)['content'], '')

    def test_group_speaker_prefix_still_stripped(self):
        raw = 'wxid_someone:\n收到请回复！@所有人'
        r = build(raw, is_group=True, sender_map={1: 'wxid_someone'})
        self.assertNotIn('wxid_someone:', r['parsedContent'])
        self.assertIn(TAIL, r['parsedContent'])

    def test_non_text_still_capped_and_labelled(self):
        """图片类仍是标签 + 200 字上限，不被这条修复带跑。"""
        r = build('<msg><img aeskey="x"/></msg>', local_type=3)
        self.assertLessEqual(len(r['parsedContent']), 200)


if __name__ == '__main__':
    unittest.main()
