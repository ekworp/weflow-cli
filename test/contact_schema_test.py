# -*- coding: utf-8 -*-
"""`contact_schema` 的手解器：用**合成**的 ext_buffer 验，不碰真库。

这套解法的全部价值在"只输出验证过的字段"，所以两条都要钉死：

  1. 正常 blob → 成员/附加 id/未识别字段都解出来，且**未识别字段原样保留**（键就是字段号，
     不丢、更不给它编一个像样的名字 —— 编了名字，下游就会拿猜的东西写逻辑）。
  2. **坏 blob 必须报错**，不能返回一个空成员表冒充"这个群没人"：后者会让调用方把
     "解不动"当成"没有成员"，而这两件事在数据上是相反的。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
import contact_schema as cs  # noqa: E402


def enc_varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def enc_tag(fno, wt):
    return enc_varint((fno << 3) | wt)


def enc_bytes(fno, payload):
    return enc_tag(fno, 2) + enc_varint(len(payload)) + payload


def enc_int(fno, value):
    return enc_tag(fno, 0) + enc_varint(value)


def member(user, display=None, status=1, inviter=None):
    body = enc_bytes(1, user.encode())
    if display:
        body += enc_bytes(2, display.encode())
    body += enc_int(3, status)
    if inviter:
        body += enc_bytes(4, inviter.encode())
    return body


class ContactSchemaTest(unittest.TestCase):
    def test_decodes_members_statusbit11_and_keeps_unknown_raw(self):
        blob = (enc_bytes(1, member('wxid_a', '张三', 17, 'wxid_b'))
                + enc_bytes(1, member('wxid_b', None, 8193))
                + enc_bytes(5, b'wxid_extra')
                + enc_int(3, 700002082) + enc_int(4, 700002082))
        got = cs.decode_room(blob)
        self.assertEqual(len(got['members']), 2)
        self.assertEqual(got['members'][0], {
            'userName': 'wxid_a', 'displayName': '张三', 'status': 17, 'inviter': 'wxid_b'})
        # 缺省就是 None：不替它编一个空串或"未知"
        self.assertIsNone(got['members'][1]['displayName'])
        self.assertEqual(got['statusBit11Ids'], ['wxid_extra'])
        # 未识别字段原样保留，键是字段号 —— 没有名字
        self.assertEqual(got['unrecognized'], {'3': 700002082, '4': 700002082})

    def test_member_with_an_unknown_field_keeps_it_visible(self):
        # 成员里塞一个 #9：不能静默丢掉（丢掉了，将来真遇到就没线索）
        blob = enc_bytes(1, member('wxid_a') + enc_int(9, 7))
        got = cs.decode_room(blob)
        self.assertEqual(got['members'][0].get('unrecognized'), {'9': 7})

    def test_broken_blob_raises_instead_of_looking_empty(self):
        # 前两个是**不同的**失败：长度的 varint 自己被截断 vs 长度合法但超出缓冲区。
        # 少写后一个，`i + ln > len(buf)` 那条检查就没人守 —— 实测过：把它改成 return []，
        # 测试照样绿（于是"坏 blob 返回空"重新变得可能，而那正是最坏的那种静默）。
        for bad, why in [(b'\x0a\xff', '长度的 varint 被截断'),
                         (b'\x0a\x05ab', '声明长度超出缓冲区'),
                         (b'\x08', 'varint 被截断'),
                         (b'\x0d\x01', 'fixed32 越界'),
                         (b'\x0b', 'wire type 3 是旧 group，不该出现')]:
            with self.assertRaises(Exception, msg='坏 blob 必须报错：%s %r' % (why, bad)):
                cs.decode_room(bad)

    def test_empty_blob_is_empty_not_an_error(self):
        # 空 blob = 真的没有内容；调用方按 length>0 过滤，走到这里也应当如实返回空
        got = cs.decode_room(b'')
        self.assertEqual(got['members'], [])
        self.assertEqual(got['unrecognized'], {})


if __name__ == '__main__':
    unittest.main()
