#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
数据库产物缓存：首次全量导出明文，后续查询秒开。

安全警告：
- 缓存目录包含完全明文的 SQLite 数据库
- 任何能读该目录的进程都能看到聊天记录
- 仅在本地开发环境使用，不要同步到云盘
"""

import os
import sys
import hashlib
import sqlite3
from pathlib import Path


class DatabaseCache:
    """数据库产物缓存，基于 (路径, mtime, size, key) 索引。
    
    环境变量：
    - WEFLOW_CACHE_ENABLED: '1' 开启，其他值或未设置则关闭（默认关闭）
    - WEFLOW_CACHE_DIR: 自定义缓存目录（默认 %TEMP%/weflow-cli-cache/databases）
    """

    @staticmethod
    def is_enabled():
        """检查缓存是否开启（通过环境变量）"""
        return os.environ.get('WEFLOW_CACHE_ENABLED') == '1'

    def __init__(self, cache_dir=None):
        """
        Args:
            cache_dir: 缓存目录，默认 %TEMP%/weflow-cli-cache/databases (Windows)
                      或 /tmp/weflow-cli-cache/databases (macOS/Linux)
                      （可用 WEFLOW_CACHE_DIR 环境变量覆盖）
        """
        if cache_dir is None:
            cache_dir = os.environ.get('WEFLOW_CACHE_DIR')
            if cache_dir:
                cache_dir = Path(cache_dir)
            else:
                # 优先用 TEMP，失败回退到当前目录（沙箱环境 TEMP 不可写时）
                temp_root = Path(os.environ.get('TEMP') or os.environ.get('TMP') or '/tmp')
                cache_dir = temp_root / "weflow-cli-cache" / "databases"
        
        self.cache_dir = Path(cache_dir)
        
        # 延迟创建，失败时尝试回退到当前目录
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        except (PermissionError, FileNotFoundError, OSError) as e:
            # 沙箱环境 TEMP 不可写，回退到当前目录
            fallback_dir = Path.cwd() / "weflow-cli-cache" / "databases"
            try:
                fallback_dir.mkdir(parents=True, exist_ok=True)
                self.cache_dir = fallback_dir
            except (PermissionError, OSError) as e2:
                raise PermissionError(
                    f"无法创建缓存目录 {self.cache_dir} 或回退目录 {fallback_dir}：权限被拒绝。\n"
                    f"请设置 WEFLOW_CACHE_DIR 环境变量到可写目录。"
                ) from e2

    def _compute_hash(self, db_path, key):
        """
        计算缓存键：hash(路径, mtime, size, key)
        源文件或密钥变化时自动失效。
        """
        stat = os.stat(db_path)
        material = f"{db_path}:{stat.st_mtime}:{stat.st_size}:{key}"
        return hashlib.sha256(material.encode()).hexdigest()[:12]

    def get(self, db_path, key):
        """
        查缓存。

        Returns:
            str: 缓存的明文数据库路径（命中）
            None: 未命中
        """
        cache_hash = self._compute_hash(db_path, key)
        db_name = Path(db_path).stem
        cache_path = self.cache_dir / f"{db_name}_{cache_hash}.db"

        if cache_path.exists():
            return str(cache_path)
        return None

    def export_and_cache(self, conn_encrypted, db_path, key):
        """
        用 sqlcipher_export() 导出明文到缓存。

        Args:
            conn_encrypted: 已解密的 sqlcipher3 连接
            db_path: 原始加密数据库路径
            key: 密钥（用于计算 hash）

        Returns:
            str: 缓存的明文数据库路径
        """
        cache_hash = self._compute_hash(db_path, key)
        db_name = Path(db_path).stem
        cache_path = self.cache_dir / f"{db_name}_{cache_hash}.db"

        print(f"[database_cache] export_and_cache 被调用: {db_name}", file=sys.stderr)

        # 如果已存在（并发竞争），直接返回
        if cache_path.exists():
            return str(cache_path)

        # 导出明文（让 SQLite 自己创建文件，不预先 touch）
        print(f"[database_cache] 开始导出: {db_path} -> {cache_path.name}", file=sys.stderr)
        
        # SQLite SQL 里反斜杠是转义符，Windows 路径必须转成正斜杠
        cache_path_sql = str(cache_path).replace('\\', '/')
        
        try:
            # 尝试用 sqlcipher_export（真实场景）
            conn_encrypted.execute(f"ATTACH DATABASE '{cache_path_sql}' AS plaintext KEY '';")
            conn_encrypted.execute("SELECT sqlcipher_export('plaintext');")
            conn_encrypted.execute("DETACH DATABASE plaintext;")
            print(f"[database_cache] 导出完成（sqlcipher_export）: {cache_path.stat().st_size / 1024 / 1024:.1f} MB", file=sys.stderr)
        except Exception as e1:
            print(f"[database_cache] sqlcipher_export 失败: {e1}，回退到 VACUUM INTO", file=sys.stderr)
            # 回退到 VACUUM INTO（测试环境用普通 sqlite3）
            # 注意：VACUUM INTO 需要 SQLite 3.27+ (Python 3.7+)
            try:
                conn_encrypted.execute(f"VACUUM INTO '{cache_path_sql}';")
                print(f"[database_cache] 导出完成（VACUUM INTO）: {cache_path.stat().st_size / 1024 / 1024:.1f} MB", file=sys.stderr)
            except Exception as e2:
                print(f"[database_cache] VACUUM INTO 失败: {e2}，回退到 backup API", file=sys.stderr)
                # VACUUM INTO 不可用，用 backup API
                import sqlite3
                dest_conn = sqlite3.connect(str(cache_path))
                conn_encrypted.backup(dest_conn)
                dest_conn.close()
                print(f"[database_cache] 导出完成（backup API）: {cache_path.stat().st_size / 1024 / 1024:.1f} MB", file=sys.stderr)

        return str(cache_path)

    def clear(self):
        """清空所有缓存。"""
        count = 0
        for f in self.cache_dir.glob("*.db"):
            f.unlink()
            count += 1
        return count

    def size(self):
        """
        Returns:
            dict: {"total_mb": float, "count": int}
        """
        total_bytes = sum(f.stat().st_size for f in self.cache_dir.glob("*.db"))
        count = len(list(self.cache_dir.glob("*.db")))
        return {
            "total_mb": total_bytes / 1024 / 1024,
            "count": count
        }

    def prune(self, days=30):
        """
        删除超过 N 天未访问的缓存。

        Args:
            days: 保留最近 N 天

        Returns:
            int: 删除的文件数
        """
        import time
        now = time.time()
        cutoff = now - days * 86400

        count = 0
        for f in self.cache_dir.glob("*.db"):
            if f.stat().st_atime < cutoff:
                f.unlink()
                count += 1
        return count

    def list(self):
        """
        列出所有缓存文件。

        Returns:
            list: [{"name": str, "size_mb": float, "mtime": float}, ...]
        """
        result = []
        for f in self.cache_dir.glob("*.db"):
            stat = f.stat()
            result.append({
                "name": f.name,
                "size_mb": stat.st_size / 1024 / 1024,
                "mtime": stat.st_mtime
            })
        return sorted(result, key=lambda x: x["mtime"], reverse=True)
