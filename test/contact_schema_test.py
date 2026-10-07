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


class ContactExtraBufferTest(unittest.TestCase):
    """`contact.extra_buffer` 那条（`decode_contact`）：只出**已验证**的三个字段，
    且**账号资料文本（`#4`/`#9`）的内容绝不出现在输出里** —— 它们只以长度进 `unrecognized`。"""

    def test_decodes_verified_fields_and_keeps_profile_text_out_of_the_output(self):
        # #4/#9 是"该账号自身资料文本的汇集"（含主体名/菜单名）：**只留长度，不留内容**
        blob = (enc_bytes(4, '某某公司的官方账号'.encode())
                + enc_bytes(5, b'CN') + enc_bytes(9, '客服电话：'.encode())
                + enc_int(8, 247) + enc_int(13, 1) + enc_int(41, 1716595152))
        got = cs.decode_contact(blob)
        self.assertEqual(got['kind'], 'contact')
        self.assertEqual(got['region'], 'CN')
        self.assertEqual(got['bizType'], 1)
        self.assertEqual(got['updatedAt'], 1716595152)
        # 未定名字段原样保留，键是字段号（#8 是 varint 所以留值）
        self.assertEqual(got['unrecognized']['8'], 247)
        # #4/#9 **只有长度**：把内容带出去就是把账号资料漏出去
        self.assertEqual(got['unrecognized']['4'], len('某某公司的官方账号'.encode()))
        self.assertEqual(got['unrecognized']['9'], len('客服电话：'.encode()))
        self.assertNotIn('某某公司', repr(got))

    def test_region_only_when_two_uppercase_letters(self):
        # 形态不符就**不认**（宁可不出，也不出一个像地区码的字符串）
        for raw in (b'cn', b'CHN', b'C1', b'', b'C '):
            got = cs.decode_contact(enc_bytes(5, raw) + enc_int(38, 1))
            self.assertIsNone(got['region'], msg='不该把 %r 当地区码' % raw)
        # 但原值仍以长度留在 unrecognized 里（没丢线索）
        got = cs.decode_contact(enc_bytes(5, b'cn') + enc_int(38, 1))
        self.assertEqual(got['unrecognized']['5'], 2)

    def test_epoch_zero_is_unset_not_1970(self):
        # #41 = 0 是**显式"未设置"**，不是"1970-01-01 发生过什么"
        got = cs.decode_contact(enc_bytes(5, b'CN') + enc_int(41, 0))
        self.assertIsNone(got['updatedAt'])

    def test_openim_small_shape_is_not_read_as_a_contact(self):
        # 列里第二型（44 行的 OpenIM 小形状）：只报 kind，不去套联系人那三个字段
        got = cs.decode_contact(enc_bytes(1, b'app') + enc_bytes(2, b'wording'))
        self.assertEqual(got['kind'], 'openim')
        self.assertIsNone(got['region'])
        self.assertIsNone(got['bizType'])
        self.assertIsNone(got['updatedAt'])
        # **没有 #1 的小形状也是 openim**：判据是"字段号全 <= 9"，不是"有没有 #1"。
        # 那族里真有一行没有 #1；早先按"必须有 #1"判，全量核对时它被错判成 contact（944/43 而不是 943/44）。
        self.assertEqual(cs.decode_contact(enc_bytes(2, b'wording'))['kind'], 'openim')
        self.assertEqual(cs.decode_contact(enc_int(7, 1) + enc_int(9, 0))['kind'], 'openim')
        # 大 proto 的"残行"（只有 #10 / #40）仍按联系人解 —— 边界钉在这儿
        self.assertEqual(cs.decode_contact(enc_int(10, 4294967295))['kind'], 'contact')
        self.assertEqual(cs.decode_contact(enc_int(40, 1))['kind'], 'contact')

    def test_contact_broken_blob_raises_instead_of_looking_empty(self):
        for bad in (b'\x0a\x05ab', b'\x0a\xff', b'\x0b'):
            with self.assertRaises(Exception, msg='坏 blob 必须报错：%r' % bad):
                cs.decode_contact(bad)

    def test_contact_empty_blob_is_empty_not_an_error(self):
        got = cs.decode_contact(b'')
        self.assertIsNone(got['kind'])
        self.assertEqual(got['unrecognized'], {})


if __name__ == '__main__':
    unittest.main()
