#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""database_cache.py 单元测试"""
import os
import sys
import unittest
import tempfile
import shutil
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / 'scripts'))

from database_cache import DatabaseCache

class DatabaseCacheTest(unittest.TestCase):
    def setUp(self):
        """每个测试前创建临时目录，并保存环境变量"""
        self._original_cache_enabled = os.environ.get('WEFLOW_CACHE_ENABLED')
        os.environ['WEFLOW_CACHE_ENABLED'] = '1'
        
        self.temp_dir = Path(tempfile.mkdtemp(prefix='cache_test_'))
        self.cache = DatabaseCache(cache_dir=self.temp_dir)
    
    def tearDown(self):
        """清理临时目录并恢复环境变量"""
        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir)
        
        # 恢复环境变量
        if self._original_cache_enabled is None:
            os.environ.pop('WEFLOW_CACHE_ENABLED', None)
        else:
            os.environ['WEFLOW_CACHE_ENABLED'] = self._original_cache_enabled
    
    def test_is_enabled_respects_env(self):
        """测试环境变量控制"""
        self.assertTrue(DatabaseCache.is_enabled())
        
        os.environ['WEFLOW_CACHE_ENABLED'] = '0'
        self.assertFalse(DatabaseCache.is_enabled())
        
        os.environ['WEFLOW_CACHE_ENABLED'] = '1'
        self.assertTrue(DatabaseCache.is_enabled())
    
    def test_cache_dir_created(self):
        """测试缓存目录自动创建"""
        self.assertTrue(self.temp_dir.exists())
        self.assertTrue(self.temp_dir.is_dir())
    
    def test_get_returns_none_for_missing(self):
        """测试缓存未命中返回 None"""
        # 创建一个真实文件，但缓存不存在
        test_db = self.temp_dir / 'test.db'
        test_db.write_bytes(b'dummy')
        result = self.cache.get(str(test_db), 'fake_key')
        self.assertIsNone(result)
    
    def test_export_creates_cache_file(self):
        """测试导出会创建缓存文件"""
        # 创建一个真实的 SQLCipher 数据库用于测试
        # （这里跳过，因为需要 sqlcipher3 和真实密钥）
        pass
    
    def test_compute_cache_key(self):
        """测试缓存键计算"""
        # 创建临时测试文件
        test_db = self.temp_dir / 'test.db'
        test_db.write_bytes(b'dummy content')
        
        key1 = self.cache._compute_hash(test_db, 'key123')
        key2 = self.cache._compute_hash(test_db, 'key123')
        key3 = self.cache._compute_hash(test_db, 'different_key')
        
        # 同样的路径和密钥应该产生相同的哈希
        self.assertEqual(key1, key2)
        
        # 不同的密钥应该产生不同的哈希
        self.assertNotEqual(key1, key3)
    
    def test_list_empty_cache(self):
        """测试空缓存列表"""
        files = self.cache.list()
        self.assertEqual(len(files), 0)
    
    def test_clear_empty_cache(self):
        """测试清空空缓存"""
        cleared = self.cache.clear()
        self.assertEqual(cleared, 0)
    
    def test_prune_empty_cache(self):
        """测试清理空缓存"""
        pruned = self.cache.prune(days=30)
        self.assertEqual(pruned, 0)

if __name__ == '__main__':
    unittest.main()
