# -*- coding: utf-8 -*-
"""读 head_image.db：联系人的头像（JPEG/PNG 完整字节内嵌库里，按 username 键控）。

为什么从库里拿而不是文件缓存：缓存在 resource 下按 md5 命名、随清理消失，
而库里永远在、按 username 键控、带 update_time——**一人多行 = 头像变更历史**
（2026-10-26 普查：本机 1083 行，见 docs/NT_DATABASES.md）。

只读、本地、不联网。输出元数据不含图片内容（--json 也只报路径与字节数）。
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nt_common  # noqa: E402
import nt_decrypt  # noqa: E402
from _utils import decrypt_lock, load_config  # noqa: E402


def head_image_db_path(message_db):
    """message_0.db 同级的 head_image/head_image.db（与 contact.db 同一层推导）。"""
    msg_dir = Path(message_db).parent.parent
    return msg_dir / 'head_image' / 'head_image.db'


def connect(db_path, key_hex, salt_hex, passphrase=''):
    import sqlcipher3
    derived_key, derived_salt = nt_common.derive_database_key(
        str(db_path), key_hex, salt_hex, passphrase)
    conn = sqlcipher3.connect(str(db_path))
    c = conn.cursor()
    c.execute("PRAGMA key = \"x'%s%s'\"" % (derived_key, derived_salt))
    # 探测解密是否真的成功（读 sqlite_master 才触发解密；错误钥匙在这里报 file is not a database）
    c.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()
    return conn


def avatar_rows(conn, username):
    """一个 username 的全部头像，新→旧。返回 [(update_time, bytes)]。"""
    c = conn.cursor()
    rows = c.execute(
        'SELECT update_time, image_buffer FROM head_image WHERE username = ? '
        'ORDER BY update_time DESC', (username,)).fetchall()
    return [(r[0], bytes(r[1])) for r in rows if r[1]]


def user_rows(conn):
    """全部 username：[(username, 头像数, 最新 update_time)]，最新在前。"""
    c = conn.cursor()
    return c.execute(
        'SELECT username, COUNT(*), MAX(update_time) FROM head_image '
        'GROUP BY username ORDER BY MAX(update_time) DESC').fetchall()


def resolve_username(conn, query, name_map):
    """查询词 → head_image 里的 username。精确 id 命中优先；否则用 contact 名字反查，
    歧义/找不到都报错并给候选——不猜（同 resolveTalker 的纪律）。"""
    usernames = {r[0] for r in user_rows(conn)}
    if query in usernames:
        return query
    hits = [u for u, display in name_map.items()
            if display == query and u in usernames]
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        raise SystemExit('「%s」匹配到多个头像所有者（%s）——请用完整 id 指定'
                         % (query, '、'.join(hits[:5])))
    raise SystemExit('没有「%s」的头像（head_image 库里共 %d 个 username；'
                     '没有头像或名字对不上都可能是原因）' % (query, len(usernames)))


def ext_of(buf):
    return '.png' if buf[:4] == b'\x89PNG' else '.jpg'


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser(
        description='联系人头像（读 head_image.db；本地只读，不联网）')
    ap.add_argument('--db', default=os.environ.get('WEFLOW_DB_PATH'),
                    help='head_image.db 路径（默认从 WEFLOW_DB_PATH/message 库推导）')
    ap.add_argument('--talker', default=os.environ.get('WEFLOW_TALKER'),
                    help='联系人（id 或备注/昵称；--all 时不需要）')
    ap.add_argument('--all', action='store_true',
                    help='导出所有 username 的最新头像到 --out 目录')
    ap.add_argument('--out', default=os.environ.get('WEFLOW_AVATAR_OUT') or '',
                    help='输出文件（单联系人）或目录（--all）')
    ap.add_argument('--list', action='store_true', help='只列出 username 与头像数')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    config = load_config()
    message_db = config.get('ntDbPath', '')
    # --db / WEFLOW_DB_PATH 两种都认：直接给 head_image.db，或给 message 库（推导同级）
    if args.db:
        p = Path(args.db)
        db = p if p.name == 'head_image.db' else head_image_db_path(p)
    elif message_db:
        db = head_image_db_path(message_db)
    else:
        db = None
    if not db or not db.exists():
        print(json.dumps({'success': False, 'error': '找不到 head_image.db（先 weflow-cli init）'}))
        return 1
    passphrase = decrypt_lock(config.get('favPassphrase') or config.get('decryptKey') or '')
    try:
        conn = connect(db, decrypt_lock(config.get('ntKey') or ''),
                       config.get('ntSalt') or '', passphrase)
    except Exception as e:
        print(json.dumps({'success': False, 'error': 'head_image.db 打不开：%s' % str(e)[:80]}))
        return 1

    try:
        if args.list:
            rows = user_rows(conn)
            if args.json:
                print(json.dumps({'success': True, 'users': [
                    {'username': u, 'avatars': n, 'newestUpdateTime': t}
                    for u, n, t in rows]}, ensure_ascii=False))
            else:
                print('共 %d 个 username 有头像' % len(rows))
                for u, n, t in rows[:20]:
                    print('  %s（%d 张，最新 %s）' % (u, n, t))
            return 0

        if args.all:
            out_dir = Path(args.out or 'output/avatars')
            out_dir.mkdir(parents=True, exist_ok=True)
            written = 0
            for username, _n, _t in user_rows(conn):
                rows = avatar_rows(conn, username)
                if not rows:
                    continue
                _ts, buf = rows[0]
                safe = ''.join(ch if ch.isalnum() or ch in '_-@.' else '_'
                               for ch in username)[:80]
                path = out_dir / (safe + ext_of(buf))
                path.write_bytes(buf)
                written += 1
            result = {'success': True, 'action': 'avatar.export-all',
                      'dir': str(out_dir), 'written': written,
                      'readsLocalData': True, 'invokesAI': False, 'sendsNothing': True}
            print(json.dumps(result, ensure_ascii=False) if args.json
                  else '已导出 %d 个最新头像到 %s' % (written, out_dir))
            return 0

        if not args.talker:
            print(json.dumps({'success': False, 'error': '缺 --talker（或 WEFLOW_TALKER）' }))
            return 1
        name_map = {}
        contact_db = nt_decrypt.find_contact_db_path(str(message_db)) if message_db else None
        if contact_db:
            name_map = nt_decrypt.load_contact_names(
                contact_db, decrypt_lock(config.get('contactKey') or ''),
                config.get('contactSalt') or '')
        username = resolve_username(conn, args.talker, name_map)
        rows = avatar_rows(conn, username)
        if not rows:
            print(json.dumps({'success': False, 'error': '「%s」在库里但头像字节为空' % username},
                             ensure_ascii=False))
            return 1
        out = Path(args.out or ('output/avatars/' + username + ext_of(rows[0][1])))
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(rows[0][1])
        result = {
            'success': True, 'action': 'avatar.export', 'username': username,
            'out': str(out), 'bytes': len(rows[0][1]),
            'historyCount': len(rows),
            'newestUpdateTime': rows[0][0],
            'readsLocalData': True, 'invokesAI': False, 'sendsNothing': True,
        }
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print('已导出「%s」的最新头像（%d 字节，历史 %d 张）→ %s'
                  % (username, len(rows[0][1]), len(rows), out))
        return 0
    finally:
        conn.close()


if __name__ == '__main__':
    sys.exit(main())
