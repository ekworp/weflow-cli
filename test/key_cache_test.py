#!/usr/bin/env python3
"""key_cache.py 回归测试"""
import sys
import os
import tempfile
import shutil

# 添加 scripts 目录到路径
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'scripts'))

import unittest
from key_cache import KeyCache


class KeyCacheTest(unittest.TestCase):
    def setUp(self):
        """每个测试前创建临时缓存目录"""
        self.temp_dir = tempfile.mkdtemp()
        self.cache_file = os.path.join(self.temp_dir, 'keys.enc')
        # 直接创建实例并覆盖路径（避免 __init__ 里的 get_cache_dir）
        self.cache = object.__new__(KeyCache)
        self.cache.cache_dir = self.temp_dir
        self.cache.cache_file = self.cache_file
        self.cache._cache = {}

    def tearDown(self):
        """测试后清理临时目录"""
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir)

    def test_put_and_get(self):
        """测试存储和读取单个密钥"""
        test_salt = 'a' * 32
        test_key = 'b' * 64

        self.cache.put(test_salt, test_key)
        retrieved = self.cache.get(test_salt)

        self.assertEqual(retrieved, test_key)

    def test_case_insensitive(self):
        """测试大小写不敏感"""
        self.cache.put('ABCD' * 8, 'EFGH' * 16)

        # 小写查询应该能找到
        retrieved = self.cache.get('abcd' * 8)
        self.assertEqual(retrieved, 'efgh' * 16)

    def test_persistence(self):
        """测试持久化（存储后重新加载）"""
        test_salt = 'c' * 32
        test_key = 'd' * 64

        self.cache.put(test_salt, test_key)

        # 创建新实例（模拟重启）
        new_cache = object.__new__(KeyCache)
        new_cache.cache_dir = self.temp_dir
        new_cache.cache_file = self.cache_file
        new_cache._cache = {}
        new_cache._load()

        # 应该能读到之前存的密钥
        retrieved = new_cache.get(test_salt)
        self.assertEqual(retrieved, test_key)

    def test_batch_put(self):
        """测试批量存储"""
        keys = [
            {'salt': 'a' * 32, 'key': 'b' * 64},
            {'salt': 'c' * 32, 'key': 'd' * 64},
            {'salt': 'e' * 32, 'key': 'f' * 64},
        ]

        self.cache.put_batch(keys)

        # 验证三个都存进去了
        self.assertEqual(self.cache.get('a' * 32), 'b' * 64)
        self.assertEqual(self.cache.get('c' * 32), 'd' * 64)
        self.assertEqual(self.cache.get('e' * 32), 'f' * 64)

    def test_batch_put_filters_invalid(self):
        """测试批量存储会过滤无效条目"""
        keys = [
            {'salt': 'a' * 32, 'key': 'b' * 64},  # 有效
            {'salt': 'short', 'key': 'd' * 64},    # salt 太短
            {'salt': 'e' * 32, 'key': 'short'},    # key 太短
            {'key': 'f' * 64},                     # 缺 salt
            {'salt': 'g' * 32},                    # 缺 key
        ]

        self.cache.put_batch(keys)

        # 只有第一个应该存进去
        self.assertEqual(self.cache.get('a' * 32), 'b' * 64)
        self.assertIsNone(self.cache.get('short'))
        self.assertIsNone(self.cache.get('e' * 32))
        self.assertIsNone(self.cache.get('g' * 32))

    def test_get_nonexistent(self):
        """测试查询不存在的密钥"""
        result = self.cache.get('nonexistent' * 2)  # 32 chars
        self.assertIsNone(result)

    def test_clear(self):
        """测试清空缓存"""
        self.cache.put('a' * 32, 'b' * 64)
        self.cache.put('c' * 32, 'd' * 64)

        self.assertEqual(len(self.cache.list_keys()), 2)

        self.cache.clear()

        self.assertEqual(len(self.cache.list_keys()), 0)
        self.assertFalse(os.path.exists(self.cache_file))

    def test_list_keys_masked(self):
        """测试列出密钥时脱敏"""
        self.cache.put('a' * 32, 'b' * 64)

        keys = self.cache.list_keys()

        self.assertEqual(len(keys), 1)
        self.assertEqual(keys[0]['salt'], 'a' * 32)
        # key 应该被截断
        self.assertTrue(keys[0]['key_prefix'].endswith('...'))
        self.assertTrue(len(keys[0]['key_prefix']) < 64)

    def test_overwrite_existing(self):
        """测试覆盖已存在的密钥"""
        salt = 'a' * 32

        self.cache.put(salt, 'old_key' + 'x' * 57)
        self.cache.put(salt, 'new_key' + 'y' * 57)

        retrieved = self.cache.get(salt)
        self.assertEqual(retrieved, 'new_key' + 'y' * 57)

        # 不应该有重复
        self.assertEqual(len(self.cache.list_keys()), 1)


class EncryptionTest(unittest.TestCase):
    """测试加密/解密（不依赖 KeyCache 实例）"""

    def test_round_trip(self):
        """测试加密解密往返"""
        from key_cache import _encrypt_data, _decrypt_data

        original = b'test data 12345'
        encrypted = _encrypt_data(original)
        decrypted = _decrypt_data(encrypted)

        self.assertEqual(decrypted, original)

    def test_different_plaintexts_produce_different_ciphertexts(self):
        """测试不同明文产生不同密文"""
        from key_cache import _encrypt_data

        ct1 = _encrypt_data(b'plaintext 1')
        ct2 = _encrypt_data(b'plaintext 2')

        self.assertNotEqual(ct1, ct2)


if __name__ == '__main__':
    unittest.main()
