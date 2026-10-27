#!/usr/bin/env python3
"""端到端测试：验证缓存在真实场景中的加速效果"""
import sys
import os
import time
import tempfile
import shutil

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'scripts'))

from key_cache import KeyCache


def test_cache_speedup():
    """测试缓存的加速效果"""
    # 创建临时缓存目录
    temp_dir = tempfile.mkdtemp()
    cache_dir = os.path.join(temp_dir, 'keys')
    os.makedirs(cache_dir, exist_ok=True)
    cache_file = os.path.join(cache_dir, 'keys.enc')

    # 模拟密钥数据
    test_keys = []
    for i in range(10):
        test_keys.append({
            'salt': f'{i:032x}',
            'key': f'{i:064x}'
        })

    try:
        # 第一次：存储密钥（模拟内存扫描后存储）
        # 不调用构造函数，直接设置属性
        cache = object.__new__(KeyCache)
        cache.cache_dir = cache_dir
        cache.cache_file = cache_file
        cache._cache = {}

        start = time.perf_counter()
        cache.put_batch(test_keys)
        save_time = time.perf_counter() - start

        print(f"存储 {len(test_keys)} 个密钥: {save_time*1000:.2f} ms")

        # 第二次：从缓存读取（模拟重启后查询）
        cache2 = object.__new__(KeyCache)
        cache2.cache_dir = cache_dir
        cache2.cache_file = cache_file
        cache2._cache = {}
        cache2._load()

        start = time.perf_counter()
        results = []
        for item in test_keys:
            key = cache2.get(item['salt'])
            if key:
                results.append(key)
        load_time = time.perf_counter() - start

        print(f"读取 {len(results)} 个密钥: {load_time*1000:.2f} ms")
        if load_time > 0:
            print(f"加速比: {save_time/load_time:.1f}x")

        # 验证正确性
        assert len(results) == len(test_keys), f"缓存命中率不是 100%: {len(results)}/{len(test_keys)}"
        for i, key in enumerate(results):
            expected = f'{i:064x}'
            assert key == expected, f"密钥 {i} 不匹配: {key} != {expected}"

        print("\n✓ 缓存功能正常")
        print(f"✓ 缓存文件: {cache_file}")
        print(f"✓ 文件大小: {os.path.getsize(cache_file)} bytes")

    finally:
        # 清理
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir)


if __name__ == '__main__':
    test_cache_speedup()
