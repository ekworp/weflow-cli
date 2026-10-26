"""媒体精确匹配：用微信自己的 `hardlink.db` 把 md5 直接对到本地文件，不猜目录。

在此之前，找一张图/一个文件只能**扫描整个 msg 目录**再比对，慢且会漏（同 md5 的
转发件、被改名的副本都不认）。`hardlink.db` 是微信自己的索引：三张表分别记
image / file / video 的 `md5 → (dir1, dir2, file_name)`，`dir2id` 把这两个 id 映射成
目录名，路径因此是**确定的**。

实测出来的路径规律（本机 2026-10-26，逐条对过真实文件）：

    msg/attach/<dir2id[dir2]>/<dir2id[dir1]>/Img/<file_name>   图片
    msg/file/<dir2id[dir1]>/<file_name>                        文件
    msg/video/<dir2id[dir1]>/<file_name>                       视频

用法：
    python scripts/media_index.py --md5 <md5前若干位>
    python scripts/media_index.py --list --type file --limit 20
    python scripts/media_index.py --json
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from _utils import load_config, decrypt_lock  # noqa: E402
from nt_common import derive_database_key  # noqa: E402
from export_chat_html import connect  # noqa: E402

#: (表名, 相对 `msg/` 的路径模板)。
#:
#: **图片的 dir1/dir2 顺序与另两张表相反**：实测 image 行是 `dir1=会话hash, dir2=月份`
#: （落在 `attach/<会话>/<月份>/Img/`），而 file/video 行是 `dir1=月份, dir2=0`。
#: 按统一顺序拼会把图片全指到 `attach/<月份>/<会话>/` 下一个也不存在（2026-10-26 实测）。
TABLES = {
    'image': ('image_hardlink_info_v4', 'attach/{d1}/{d2}/Img/{name}'),
    'file': ('file_hardlink_info_v4', 'file/{d1}/{name}'),
    'video': ('video_hardlink_info_v4', 'video/{d1}/{name}'),
}


def hardlink_path(cfg):
    """hardlink.db 与消息库同属 db_storage，用 `ntDbPath` 反推。"""
    msg = pathlib.Path(cfg.get('ntDbPath') or '')
    if not msg.name:
        raise SystemExit('配置里没有 ntDbPath')
    return msg.parent.parent / 'hardlink' / 'hardlink.db'


def account_root(cfg):
    """`msg/` 的父目录（媒体按这种结构摆放）。"""
    return pathlib.Path(cfg.get('ntDbPath') or '').parent.parent.parent


def open_db(cfg):
    path = hardlink_path(cfg)
    if not path.is_file():
        raise SystemExit(f'找不到 {path}')
    key = decrypt_lock(cfg.get('ntKey', '') or '')
    salt = decrypt_lock(cfg.get('ntSalt', '') or '')
    pw = decrypt_lock(cfg.get('favPassphrase', '') or cfg.get('decryptKey', '') or '')
    k, s = derive_database_key(str(path), key, salt, pw)
    return connect(str(path), k, s)


def load_rows(conn, kind):
    table = TABLES[kind][0]
    cur = conn.cursor()
    dirs = {rid: name for rid, name in cur.execute('SELECT rowid, username FROM dir2id')}
    rows = []
    for md5, typ, name, size, d1, d2 in cur.execute(
            'SELECT md5, type, file_name, file_size, dir1, dir2 FROM "%s"' % table):
        rows.append({'md5': md5 or '', 'type': typ, 'file': name or '',
                     'size': size or 0, 'dir1': dirs.get(d1, ''), 'dir2': dirs.get(d2, ''),
                     'kind': kind})
    return rows


def resolve(cfg, row):
    """一行 → 本地绝对路径（不保证文件还在：微信会清理）。"""
    tmpl = TABLES[row['kind']][1]
    rel = tmpl.format(d1=row['dir1'], d2=row['dir2'], name=row['file'])
    return account_root(cfg) / 'msg' / rel


def main():
    # 手跑时 stdout 是本地代码页（本机 GBK），下面的 ✓/✗ 在 GBK 里编不出来会直接抛
    # UnicodeEncodeError。走 bridge 时父进程已设 PYTHONIOENCODING，两条路表现才会一致。
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
    ap = argparse.ArgumentParser(description='媒体精确匹配（读 hardlink.db，本地只读）')
    ap.add_argument('--md5', default='', help='按 md5 前缀查（不区分大小写）')
    ap.add_argument('--type', default='all', choices=['all', 'image', 'file', 'video'])
    ap.add_argument('--list', action='store_true', help='列出行（不给 --md5 时等价于列出）')
    ap.add_argument('--limit', type=int, default=20)
    ap.add_argument('--missing-only', action='store_true', help='只列文件已不在本地的')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    cfg = load_config()
    conn, _cur = open_db(cfg)
    try:
        kinds = list(TABLES) if args.type == 'all' else [args.type]
        rows = []
        for kind in kinds:
            rows.extend(load_rows(conn, kind))
    finally:
        try:
            conn.close()
        except Exception:
            pass

    if args.md5:
        needle = args.md5.lower()
        rows = [r for r in rows if r['md5'].lower().startswith(needle)]

    for r in rows:
        p = resolve(cfg, r)
        r['path'] = str(p)
        r['exists'] = p.is_file()
    if args.missing_only:
        rows = [r for r in rows if not r['exists']]

    total = len(rows)
    rows = rows[:args.limit]

    if args.json:
        print(json.dumps({'success': True, 'total': total, 'rows': rows},
                         ensure_ascii=False, indent=2))
        return
    if not rows:
        print('没有匹配的记录')
        return
    present = sum(1 for r in rows if r['exists'])
    print(f'匹配 {total} 条（显示 {len(rows)} 条，其中文件仍在本地的 {present} 条）\n')
    for r in rows:
        mark = '✓' if r['exists'] else '✗'
        print(f"{mark} {r['kind']:<5} {r['md5'][:12]}  {r['file'][:44]:<44} {r['size']:>9} 字节")
        print(f"    {r['path']}")
    if present < len(rows):
        print(f'\n（✗ 表示 hardlink.db 有记录但文件已被微信清理，不是路径算错）')


if __name__ == '__main__':
    main()
