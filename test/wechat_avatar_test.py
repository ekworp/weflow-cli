# -*- coding: utf-8 -*-
"""wechat_avatar.py：头像库读取的纯函数层。

钉四件事：库路径推导（message 库 → 同级 head_image）、行序（新→旧）与空字节行
过滤、扩展名按 magic（jpg/png）、名字解析的三态（精确命中 / 唯一反查 / 歧义与
找不到都报错不猜）。sqlcipher3 用 stdlib sqlite3 顶替（同 nt_decrypt_shards_test
的做法：connect 只发 PRAGMA key，纯 SQLite 忽略它）。
"""
import importlib.util
import sqlite3
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))

spec = importlib.util.spec_from_file_location('wechat_avatar', SCRIPTS / 'wechat_avatar.py')
av = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'sqlcipher3': types.SimpleNamespace(dbapi2=sqlite3)}):
    spec.loader.exec_module(av)

PNG = b'\x89PNG' + b'\x00' * 20
JPG = b'\xff\xd8\xff\xe0' + b'\x00' * 20


def make_db(path, rows):
    conn = sqlite3.connect(path)
    conn.execute('CREATE TABLE head_image (username TEXT, md5 TEXT, '
                 'image_buffer BLOB, update_time INTEGER)')
    conn.executemany('INSERT INTO head_image VALUES (?,?,?,?)', rows)
    conn.commit()
    conn.close()
    return path


class AvatarTests(unittest.TestCase):
    def test_db_path_derivation(self):
        got = av.head_image_db_path(
            'D:/w/db_storage/message/message_0.db')
        self.assertEqual(got.parts[-2:], ('head_image', 'head_image.db'))
        self.assertEqual(got.parts[-3], 'db_storage')

    def test_rows_newest_first_and_empty_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            conn = sqlite3.connect(make_db(Path(tmp) / 'h.db', [
                ('wxid_a', 'm1', PNG, 100),
                ('wxid_a', 'm2', JPG, 300),      # 最新
                ('wxid_a', 'm3', b'', 200),       # 空字节行要滤掉
                ('wxid_b', 'm4', JPG, 50),
            ]))
            try:
                rows = av.avatar_rows(conn, 'wxid_a')
                self.assertEqual([ts for ts, _b in rows], [300, 100])
                self.assertEqual(rows[0][1][:4], b'\xff\xd8\xff\xe0')
                self.assertEqual(len(av.avatar_rows(conn, 'nobody')), 0)
            finally:
                conn.close()

    def test_user_rows_group_and_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            conn = sqlite3.connect(make_db(Path(tmp) / 'h.db', [
                ('a', 'm', PNG, 10), ('a', 'm', PNG, 20), ('b', 'm', PNG, 15),
            ]))
            try:
                rows = av.user_rows(conn)
                self.assertEqual(rows, [('a', 2, 20), ('b', 1, 15)])
            finally:
                conn.close()

    def test_ext_by_magic(self):
        self.assertEqual(av.ext_of(b'\x89PNG...'), '.png')
        self.assertEqual(av.ext_of(b'\xff\xd8\xff\xe0...'), '.jpg')

    def test_resolve_three_outcomes(self):
        with tempfile.TemporaryDirectory() as tmp:
            conn = sqlite3.connect(make_db(Path(tmp) / 'h.db', [
                ('wxid_a', 'm', PNG, 1), ('wxid_b', 'm', PNG, 1),
            ]))
            try:
                # 精确 id 命中优先
                self.assertEqual(av.resolve_username(conn, 'wxid_a', {}), 'wxid_a')
                # 名字唯一反查
                self.assertEqual(
                    av.resolve_username(conn, '老王', {'wxid_b': '老王'}), 'wxid_b')
                # 歧义：两个 id 同名都有头像
                with self.assertRaises(SystemExit) as cm:
                    av.resolve_username(conn, '老王',
                                        {'wxid_a': '老王', 'wxid_b': '老王'})
                self.assertIn('多个', str(cm.exception))
                # 找不到
                with self.assertRaises(SystemExit) as cm:
                    av.resolve_username(conn, '路人', {})
                self.assertIn('没有', str(cm.exception))
            finally:
                conn.close()


if __name__ == '__main__':
    unittest.main()
