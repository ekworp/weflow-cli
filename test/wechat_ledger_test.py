# -*- coding: utf-8 -*-
"""wechat_ledger.py：资金流水归一化的纯函数层。

钉四件事：红包/转账的字段映射与排序（红包无时间列用 messageServerId 兜底）、
方向判定（前缀容忍 + 双方都是自己时的"未知"）、会话过滤按显示名也认、
--days 只过滤有时间戳的行（红包不受限）。sqlcipher3 顶替法同其他测试。
"""
import importlib.util
import json
import sqlite3
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))

spec = importlib.util.spec_from_file_location('wechat_ledger', SCRIPTS / 'wechat_ledger.py')
lg = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'sqlcipher3': types.SimpleNamespace(dbapi2=sqlite3)}):
    spec.loader.exec_module(lg)


def make_db(path, red_rows=(), transfer_rows=()):
    # 关闭放进 finally：Windows 上漏关的连接让 TemporaryDirectory 清理报
    # PermissionError，症状长得完全不像真正的问题（nt_decrypt_shards_test 的老坑）。
    conn = sqlite3.connect(path)
    try:
        # 只建 `ledger_rows` 真正 SELECT 的 7 列。照真实表建全 9 列会让 7 个值的
        # fixture **整体左移两格**：hb_status 落到 send_id、receive_status 落到 scene_id，
        # 于是 `hbStatus` 读出 0 而不是 4（2026-10-26 的红就是这么来的）。
        conn.execute('''CREATE TABLE redEnvelopeTable (
            message_server_id INTEGER, session_name TEXT, sender_user_name TEXT,
            send_id TEXT, hb_status INTEGER, hb_type INTEGER, receive_status INTEGER)''')
        conn.execute('''CREATE TABLE transferTable (
            transfer_id TEXT, transcation_id TEXT, message_server_id INTEGER,
            second_message_server_id INTEGER, session_name TEXT, pay_sub_type INTEGER,
            pay_receiver TEXT, pay_payer TEXT, begin_transfer_time INTEGER,
            last_modified_time INTEGER, invalid_time INTEGER, last_update_time INTEGER,
            delay_confirm_flag INTEGER, bubble_clicked_flag INTEGER)''')
        conn.executemany('INSERT INTO redEnvelopeTable VALUES (?,?,?,?,?,?,?)',
                         [tuple(r) + (0,) * (7 - len(r)) for r in red_rows])
        conn.executemany('INSERT INTO transferTable VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                         [r if len(r) == 14 else tuple(r) + (0,) * (14 - len(r)) for r in transfer_rows])
        conn.commit()
    finally:
        conn.close()
    return path


class LedgerTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.db = make_db(
            Path(self.tmp.name) / 'g.db',
            red_rows=[
                (900, 'wxid_a', 'wxid_me', 'send1', 1, 0, 0),   # 我发的红包
                (1000, 'wxid_a', 'wxid_b', 'send2', 4, 0, 2),   # 对方发的
            ],
            transfer_rows=[
                ('t1', 'tx1', 500, 0, 'wxid_a', 3, 'wxid_b', 'wxid_me',
                 1_700_000_000, 0, 0, 0),                        # 我付
                ('t2', 'tx2', 600, 0, 'wxid_a', 3, 'wxid_me', 'wxid_b',
                 1_700_100_000, 0, 42, 0),                       # 我收，带 invalid_time
            ])

    def tearDown(self):
        self.tmp.cleanup()

    def _conn(self):
        return sqlite3.connect(self.db)

    def test_mapping_order_and_direction(self):
        conn = self._conn()
        try:
            rows = lg.ledger_rows(conn, {}, own_wxid='wxid_me')
            # 合并排序：转账按时间，红包按 serverId——时间戳 > 红包 id，所以转账在前
            self.assertEqual([r['kind'] for r in rows], ['转账', '转账', '红包', '红包'])
            t1 = next(r for r in rows if r.get('transferId') == 't1')
            self.assertEqual(t1['direction'], '我付')
            self.assertEqual(t1['counterparty'], 'wxid_b')
            t2 = next(r for r in rows if r.get('transferId') == 't2')
            self.assertEqual(t2['direction'], '我收')
            self.assertEqual(t2['invalidTime'], 42)
            red_mine = next(r for r in rows if r['kind'] == '红包' and r['messageServerId'] == '900')
            self.assertEqual(red_mine['direction'], '我发')
            red_theirs = next(r for r in rows if r['messageServerId'] == '1000')
            self.assertEqual(red_theirs['direction'], '对方发')
            # 状态原样不翻译
            self.assertEqual(red_theirs['hbStatus'], 4)
            self.assertEqual(red_theirs['receiveStatus'], 2)
        finally:
            conn.close()

    def test_prefix_tolerant_own_id(self):
        conn = self._conn()
        try:
            # 配置 wxid 带 Name2Id 没有的后缀（1.15.1 的教训）
            rows = lg.ledger_rows(conn, {}, own_wxid='wxid_me_suffix')
            t1 = next(r for r in rows if r.get('transferId') == 't1')
            self.assertEqual(t1['direction'], '我付', 'wxid_me 是 wxid_me_suffix 的前缀，应算同一人')
        finally:
            conn.close()

    def test_both_sides_own_is_unknown_direction(self):
        conn = sqlite3.connect(make_db(
            Path(self.tmp.name) / 'g2.db',
            transfer_rows=[('t3', 'tx3', 700, 0, 'wxid_me', 3, 'wxid_me', 'wxid_me', 10, 0, 0, 0)]))
        try:
            rows = lg.ledger_rows(conn, {}, own_wxid='wxid_me')
            self.assertEqual(rows[0]['direction'], '未知', '付收都是自己不该猜')
        finally:
            conn.close()

    def test_session_filter_matches_display_name(self):
        conn = self._conn()
        try:
            rows = lg.ledger_rows(conn, {'wxid_a': '老王'}, own_wxid='wxid_me')
            self.assertTrue(all(r['session'] == 'wxid_a' for r in rows))
            by_display = lg.ledger_rows(conn, {'wxid_a': '老王'}, '老王')
            self.assertEqual(len(by_display), 4, '按显示名过滤也要命中')
            self.assertEqual(len(lg.ledger_rows(conn, {}, '不存在的人')), 0)
        finally:
            conn.close()

    def test_days_filter_keeps_untimed_rows(self):
        conn = self._conn()
        try:
            rows = lg.ledger_rows(conn, {}, own_wxid='wxid_me')
        finally:
            conn.close()
        # 时间窗远晚于所有转账 ⇒ 转账被滤掉，红包（无时间）必须保留
        kept = lg.keep_within_days(rows, cutoff=2_000_000_000)
        self.assertEqual([r['kind'] for r in kept], ['红包', '红包'])


if __name__ == '__main__':
    unittest.main()
