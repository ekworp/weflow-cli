#!/usr/bin/env python3
"""
密钥缓存层 - 参考 SIWX keystore.py 设计
按 salt 索引缓存密钥，Windows 用 DPAPI 加密，其他平台用文件权限保护
"""
import os
import sys
import json
import hashlib
from pathlib import Path

IS_WINDOWS = os.name == 'nt'

if IS_WINDOWS:
    try:
        import win32crypt
        HAS_WIN32CRYPT = True
    except ImportError:
        HAS_WIN32CRYPT = False
else:
    HAS_WIN32CRYPT = False


def get_cache_dir():
    """获取密钥缓存目录"""
    if IS_WINDOWS:
        base = os.environ.get('USERPROFILE', os.path.expanduser('~'))
    else:
        base = os.path.expanduser('~')

    cache_dir = os.path.join(base, '.weflow-cli', 'keys')
    os.makedirs(cache_dir, exist_ok=True)

    # 非 Windows 平台设置严格权限
    if not IS_WINDOWS:
        try:
            os.chmod(cache_dir, 0o700)
        except Exception as e:
            # chmod 失败（文件系统不支持权限）不影响功能
            pass

    return cache_dir


def _encrypt_data(data_bytes):
    """加密数据（Windows DPAPI / 其他平台 XOR）"""
    if IS_WINDOWS and HAS_WIN32CRYPT:
        try:
            encrypted = win32crypt.CryptProtectData(data_bytes, None, None, None, None, 0)
            return encrypted
        except Exception as e:
            # DPAPI 失败（用户上下文问题），降级到 XOR
            pass

    # Fallback: 简单 XOR（依赖文件权限保护）
    key = hashlib.sha256(os.urandom(16)).digest()
    result = bytearray(key)  # 前 32 字节是 key
    for i, b in enumerate(data_bytes):
        result.append(b ^ key[i % len(key)])
    return bytes(result)


def _decrypt_data(encrypted_bytes):
    """解密数据（Windows DPAPI / 其他平台 XOR）"""
    if IS_WINDOWS and HAS_WIN32CRYPT:
        try:
            _, decrypted = win32crypt.CryptUnprotectData(encrypted_bytes, None, None, None, 0)
            return decrypted
        except Exception as e:
            # DPAPI 解密失败（用户上下文变更、数据损坏），降级到 XOR
            pass

    # Fallback: XOR 解密
    if len(encrypted_bytes) < 32:
        return None
    key = encrypted_bytes[:32]
    encrypted = encrypted_bytes[32:]
    result = bytearray()
    for i, b in enumerate(encrypted):
        result.append(b ^ key[i % len(key)])
    return bytes(result)


class KeyCache:
    """密钥缓存（按 salt 索引）"""

    def __init__(self):
        self.cache_dir = get_cache_dir()
        self.cache_file = os.path.join(self.cache_dir, 'keys.enc')
        self._cache = {}
        self._load()

    def _load(self):
        """从磁盘加载缓存"""
        if not os.path.exists(self.cache_file):
            return

        try:
            with open(self.cache_file, 'rb') as f:
                encrypted = f.read()

            decrypted = _decrypt_data(encrypted)
            if decrypted:
                data = json.loads(decrypted.decode('utf-8'))
                self._cache = data.get('keys', {})
        except Exception as e:
            # 损坏或无法解密（格式变更、平台迁移），重置缓存
            self._cache = {}

    def _save(self):
        """保存缓存到磁盘"""
        try:
            data = {'keys': self._cache}
            plain = json.dumps(data, ensure_ascii=False).encode('utf-8')
            encrypted = _encrypt_data(plain)

            with open(self.cache_file, 'wb') as f:
                f.write(encrypted)

            # 非 Windows 平台设置严格权限
            if not IS_WINDOWS:
                try:
                    os.chmod(self.cache_file, 0o600)
                except Exception as e:
                    # chmod 失败不影响功能
                    pass
        except Exception as e:
            # 保存失败（磁盘满、权限问题）不影响内存缓存
            pass

    def get(self, salt_hex):
        """获取密钥（按 salt 索引）

        Args:
            salt_hex: 32 字符十六进制 salt

        Returns:
            64 字符十六进制 key，未找到返回 None
        """
        return self._cache.get(salt_hex.lower())

    def put(self, salt_hex, key_hex):
        """存储密钥

        Args:
            salt_hex: 32 字符十六进制 salt
            key_hex: 64 字符十六进制 key
        """
        self._cache[salt_hex.lower()] = key_hex.lower()
        self._save()

    def put_batch(self, keys):
        """批量存储密钥

        Args:
            keys: list of {"salt": str, "key": str}
        """
        changed = False
        for item in keys:
            salt = item.get('salt', '').lower()
            key = item.get('key', '').lower()
            if salt and key and len(salt) == 32 and len(key) == 64:
                if self._cache.get(salt) != key:
                    self._cache[salt] = key
                    changed = True

        if changed:
            self._save()

    def clear(self):
        """清空缓存"""
        self._cache = {}
        if os.path.exists(self.cache_file):
            try:
                os.remove(self.cache_file)
            except Exception as e:
                # 删除失败不影响内存清空
                pass

    def list_keys(self):
        """列出所有缓存的密钥（脱敏）

        Returns:
            list of {"salt": str, "key_prefix": str}
        """
        result = []
        for salt, key in self._cache.items():
            result.append({
                'salt': salt,
                'key_prefix': key[:16] + '...' if len(key) > 16 else key
            })
        return result


# 全局单例
_global_cache = None

def get_key_cache():
    """获取全局密钥缓存实例"""
    global _global_cache
    if _global_cache is None:
        _global_cache = KeyCache()
    return _global_cache


if __name__ == '__main__':
    # 简单测试
    import sys
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

    cache = KeyCache()

    # 测试存取
    test_salt = 'a' * 32
    test_key = 'b' * 64

    cache.put(test_salt, test_key)
    retrieved = cache.get(test_salt)

    print(f"存储测试: {'✓' if retrieved == test_key else '✗'}")
    print(f"Salt: {test_salt[:16]}...")
    print(f"Key:  {retrieved[:16] if retrieved else 'None'}...")

    # 测试列表
    keys = cache.list_keys()
    print(f"\n缓存数量: {len(keys)}")
    for item in keys[:3]:
        print(f"  {item['salt'][:16]}... → {item['key_prefix']}")

    # 清理测试数据
    cache.clear()
    print(f"\n清空后数量: {len(cache.list_keys())}")
