#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数据库缓存管理命令

用法:
    python manage_cache.py status [--json]
    python manage_cache.py list [--json]
    python manage_cache.py clear [--json]
    python manage_cache.py prune <days> [--json]
"""

import sys
import json
import argparse
from database_cache import DatabaseCache


def main():
    parser = argparse.ArgumentParser(description="数据库缓存管理")
    parser.add_argument("action", choices=["status", "list", "clear", "prune"], help="操作类型")
    parser.add_argument("days", type=int, nargs="?", help="prune 操作：删除超过 N 天的缓存")
    parser.add_argument("--json", action="store_true", help="JSON 输出")
    args = parser.parse_args()

    # status 只读环境变量和目录大小
    if args.action == "status":
        enabled = DatabaseCache.is_enabled()
        cache = DatabaseCache()
        info = cache.size()
        result = {
            "success": True,
            "enabled": enabled,
            "cache_dir": str(cache.cache_dir),
            "total_mb": info["total_mb"],
            "count": info["count"],
            "message": f"{info['count']} cached database(s), total {info['total_mb']:.2f} MB"
        }
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        else:
            status_text = "已开启" if enabled else "已关闭"
            print(f"缓存状态: {status_text}")
            print(f"缓存目录: {cache.cache_dir}")
            print(result["message"])
        return

    cache = DatabaseCache()

    if args.action == "clear":
        count = cache.clear()
        result = {"cleared": count, "message": f"Cleared {count} cached database(s)"}
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print(result["message"])

    elif args.action == "list":
        files = cache.list()
        if args.json:
            print(json.dumps({"files": files}, ensure_ascii=False))
        else:
            if not files:
                print("No cached databases.")
            else:
                print(f"{'Name':<40} {'Size (MB)':<12} {'Modified'}")
                print("-" * 70)
                for f in files:
                    import datetime
                    mtime_str = datetime.datetime.fromtimestamp(f["mtime"]).strftime("%Y-%m-%d %H:%M")
                    print(f"{f['name']:<40} {f['size_mb']:<12.2f} {mtime_str}")

    elif args.action == "prune":
        if args.days is None:
            print("Error: prune 需要指定天数", file=sys.stderr)
            sys.exit(1)
        count = cache.prune(days=args.days)
        result = {"pruned": count, "message": f"Removed {count} cached database(s) older than {args.days} days"}
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print(result["message"])


if __name__ == "__main__":
    main()
