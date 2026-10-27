#!/usr/bin/env python3
"""nt_decrypt.py 密钥缓存集成测试"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'scripts'))

import unittest
from unittest.mock import patch, MagicMock
import tempfile
import shutil


class KeyCacheIntegrationTest(unittest.TestCase):
    """测试 nt_decrypt 与 key_cache 的集成"""

    def setUp(self):
        """创建临时缓存环境"""
        self.temp_dir = tempfile.mkdtemp()
        # Mock get_key_cache 返回测试用缓存
        self.mock_cache = MagicMock()
        self.mock_cache.get = MagicMock(return_value=None)
        self.mock_cache.put_batch = MagicMock()

        self.patcher = patch('nt_decrypt.get_key_cache', return_value=self.mock_cache)
        self.patcher.start()

    def tearDown(self):
        """清理"""
        self.patcher.stop()
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir)

    def test_match_keys_uses_cache_first(self):
        """测试匹配时优先使用缓存"""
        from nt_decrypt import match_keys_to_databases

        # 设置缓存行为：salt1 有缓存，salt2 无缓存
        def cache_get_side_effect(salt):
            if salt == 'salt1' + '0' * 27:
                return 'cached_key_' + 'a' * 54
            return None

        self.mock_cache.get.side_effect = cache_get_side_effect

        memory_keys = [
            {'key': 'memory_key_' + 'b' * 54, 'salt': 'salt2' + '0' * 27}
        ]

        databases = [
            {'path': '/path/db1.db', 'salt': 'salt1' + '0' * 27},  # 缓存命中
            {'path': '/path/db2.db', 'salt': 'salt2' + '0' * 27},  # 内存命中
        ]

        matched = match_keys_to_databases(memory_keys, databases, use_cache=True)

        # 应该匹配两个
        self.assertEqual(len(matched), 2)

        # 第一个来自缓存
        db1 = next(db for db in matched if 'db1' in db['path'])
        self.assertEqual(db1['key_source'], 'cache')
        self.assertEqual(db1['key'], 'cached_key_' + 'a' * 54)

        # 第二个来自内存
        db2 = next(db for db in matched if 'db2' in db['path'])
        self.assertEqual(db2['key_source'], 'memory')
        self.assertEqual(db2['key'], 'memory_key_' + 'b' * 54)

    def test_match_keys_stores_to_cache(self):
        """测试新扫描的密钥会存入缓存"""
        from nt_decrypt import match_keys_to_databases

        self.mock_cache.get.return_value = None  # 缓存未命中

        memory_keys = [
            {'key': 'key1' + 'a' * 59, 'salt': 'salt1' + '0' * 26},
            {'key': 'key2' + 'b' * 59, 'salt': 'salt2' + '0' * 26},
        ]

        databases = []

        match_keys_to_databases(memory_keys, databases, use_cache=True)

        # 应该调用 put_batch 存储
        self.mock_cache.put_batch.assert_called_once()
        call_args = self.mock_cache.put_batch.call_args[0][0]
        self.assertEqual(len(call_args), 2)

    def test_match_from_cache_only(self):
        """测试只从缓存匹配（无内存扫描）"""
        from nt_decrypt import match_databases_from_cache_only

        # 设置缓存行为
        def cache_get_side_effect(salt):
            if salt == 'salt1' + '0' * 26:
                return 'cached_key1' + 'x' * 52
            return None

        self.mock_cache.get.side_effect = cache_get_side_effect

        databases = [
            {'path': '/path/db1.db', 'salt': 'salt1' + '0' * 26},  # 有缓存
            {'path': '/path/db2.db', 'salt': 'salt2' + '0' * 26},  # 无缓存
        ]

        matched, unmatched = match_databases_from_cache_only(databases)

        # 一个匹配，一个未匹配
        self.assertEqual(len(matched), 1)
        self.assertEqual(len(unmatched), 1)

        self.assertEqual(matched[0]['path'], '/path/db1.db')
        self.assertEqual(matched[0]['key'], 'cached_key1' + 'x' * 52)
        self.assertEqual(matched[0]['key_source'], 'cache')

        self.assertEqual(unmatched[0]['path'], '/path/db2.db')

    def test_use_cache_false_skips_cache(self):
        """测试 use_cache=False 时不使用缓存"""
        from nt_decrypt import match_keys_to_databases

        memory_keys = [
            {'key': 'key1' + 'a' * 59, 'salt': 'salt1' + '0' * 26}
        ]

        databases = [
            {'path': '/path/db1.db', 'salt': 'salt1' + '0' * 26}
        ]

        matched = match_keys_to_databases(memory_keys, databases, use_cache=False)

        # 不应该调用缓存
        self.mock_cache.get.assert_not_called()
        self.mock_cache.put_batch.assert_not_called()

        # 但应该能匹配（从内存）
        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0]['key_source'], 'memory')


if __name__ == '__main__':
    unittest.main()
