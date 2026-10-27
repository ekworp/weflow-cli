#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NT 库里其余那些还没人读过的东西（general / session / emoticon / solitaire / bizchat）。

2026-10-27 普查产物，前置清单见 `docs/NT_DATABASES.md`。这个文件只做一件事：
把那些表**如实**读出来。下面几条是刻意的取舍，改之前先看：

* **读失败绝不当成 0 行。** 本文件所有文本列都过 `hex()` 再在 Python 侧
  `decode('utf-8', 'replace')`：库里真有列存了非法 UTF-8（实测
  `WeAppBizAttrSyncBufferTableV02.version` 就是），直接 `SELECT` 会让**整条查询**
  抛 `Could not decode to UTF-8`——先前的版本把它吞成"0 行"，于是"读不到"和
  "没有"变成了同一个数字。现在每个 reader 都带 `readErrors`，失败会说出来。
* **不翻译未验证的枚举。** `SessionTable.status`、`FMessageTable.type_`、
  `kNonStoreEmoticonTable.type`、`wacontact.type` 的数值语义都没有逐值验证过。
  原样输出数字，并在结果里带 `unverifiedEnums` 说明哪几个字段是这种。
* **`SessionTable.type` 在本机是常量 0（710/710）。** 常量字段不能当分类维度用——
  拿它做过滤会得到"全中"或"全空"两种假象。所以这里**不提供**按 type 过滤。
* **`SessionDeleteTable` 是唯一痕迹。** 实测 6 条删除记录里 **0 条**还留在
  `SessionTable`（删除时两边一起删）。所以"用户删过哪些会话"只有这张表知道。
* **`SearchRecent` 与 `websearch_record` 是两个来源，不是重复。** 实测 35 条
  `SearchRecent.query` 与 83 条 `websearch_record.keyword` 交集 **0**。
* **`emoticon.db` 的 `aes_key` 解不开表情文件。** 实测 76 行 32 位 hex（=16 字节，
  长度上正好是 AES-128），对 111 个能按 md5 对上号的本机缓存文件做
  CBC(key=iv)/CBC(iv=0)/ECB 试解，命中已知图片 magic **0** 次；同一测试里用全 0
  当错 key 的对照也是 **0**，说明这个否定不是测试坏了。表情只给元数据。
* **空表如实报 0，不省略。** 一张 0 行的表读出来是"它存在且为空"，和"这个库没有
  这张表"是两件事（`chatbot_message.db` 四张表全 0 行、`weclaw.db` 只有压缩簿记）。

只读、本地、不联网；所有库用同一派生链打开（`nt_common.derive_database_key`）。
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nt_common  # noqa: E402
from _utils import decrypt_lock, load_config  # noqa: E402

#: 支持的种类。`overview` 是清单，其余各读一个域。
KINDS = (
    'overview',
    'search-history',
    'sessions',
    'emoticons',
    'fmessages',
    'solitaire',
    'biz-subscribe',
    'revoke',
    'bizchat',
)

#: 结果里要标出来的"数值语义未验证"字段。凡是被翻译成文字就会误导人的，都放这里。
UNVERIFIED_ENUMS = {
    'SessionTable.status': '本机 0/2 两档，语义未逐值验证',
    'SessionTable.is_hidden': '0/1；值自解释，但"隐藏"是否等同客户端隐藏未验证',
    'SessionTable.type': '本机 710/710 全为 0 —— **常量，不可当分类维度**',
    'FMessageTable.type_': '本机 11/11 全为 37 —— 常量',
    'wacontact.type': '本机 470/470 全为 0 —— 常量',
    'biz_subscribe_status.is_subscribe': '本机 41/41 全为 1 —— 常量',
    'kNonStoreEmoticonTable.type': '本机 76/76 全为 3 —— 常量',
}


# ==================== 文本列的容错读取 ====================

def T(col):
    """把一个文本列的 SQL 表达式换成 `hex(col)`。

    库里有列存非法 UTF-8（实测 `WeAppBizAttrSyncBufferTableV02.version`）。
    直接 SELECT 这张列会让**整条查询**抛 `Could not decode to UTF-8`，
    于是整张表被读成 0 行。走 hex 之后 SQLite 只在字节层面搬运，不会解码，
    Python 侧再用 `replace` 兜底——代价是坏字节变成 U+FFFD，收益是
    "有一行数据但有一个乱码"不再变成"这张表是空的"。
    """
    return 'hex(%s)' % col


def text(hex_str):
    """`hex(col)` 的结果 → str。NULL 仍是空串；坏字节变成替换字符而不是抛错。"""
    if hex_str is None:
        return ''
    if isinstance(hex_str, bytes):
        return hex_str.decode('utf-8', 'replace')
    try:
        return bytes.fromhex(hex_str).decode('utf-8', 'replace')
    except (TypeError, ValueError):
        return str(hex_str)


class Reader:
    """一次读取的游标 + 失败记录。

    **核心约定：查询失败要出现在 `readErrors` 里，不允许静默返回空列表。**
    这个项目的 `silent_failure_guard_test` 拦的是裸 `except`，但比裸 except 更贵的是
    "捕获了、没抛、也没说" —— 调用方看到 0 行会以为是"没有数据"。
    """

    def __init__(self, conn):
        self._c = conn.cursor()
        self.errors = []

    def rows(self, label, sql, params=()):
        try:
            return self._c.execute(sql, params).fetchall()
        except Exception as error:
            self.errors.append({
                'what': label,
                'error': '%s: %s' % (type(error).__name__, str(error)[:200]),
            })
            return []

    def attach(self, result):
        if self.errors:
            result['readErrors'] = self.errors
        return result


def table_names(conn):
    return [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def row_count(conn, table):
    """一行表的行数。

    **失败返回 None，不返回 0** —— 两者在输出里必须能分开看。
    """
    try:
        return conn.execute('SELECT COUNT(*) FROM "%s"' % table).fetchone()[0]
    except Exception as error:
        return None


# ==================== 库路径与连接 ====================

def account_dirs(message_db):
    """从 message_0.db 推出 `db_storage` 与账号根目录。

    `.../<wxid>/db_storage/message/message_0.db` →
    `db_storage = .../<wxid>/db_storage`，账号根 = `.../<wxid>`。
    """
    msg_dir = Path(message_db).parent
    return msg_dir.parent, msg_dir.parent.parent


def db_paths(message_db):
    """各库的绝对路径。缺库由调用方判断（不存在就如实报，不当作空）。"""
    db_storage, _acct = account_dirs(message_db)
    msg_dir = Path(message_db).parent
    return {
        'general': db_storage / 'general' / 'general.db',
        'session': db_storage / 'session' / 'session.db',
        'emoticon': db_storage / 'emoticon' / 'emoticon.db',
        'solitaire': db_storage / 'solitaire' / 'solitaire.db',
        'bizchat': db_storage / 'bizchat' / 'bizchat.db',
        'chatbot': db_storage / 'chatbot' / 'chatbot_message.db',
        'third_app_icon': db_storage / 'third_app_icon' / 'third_app_icon.db',
        'weclaw': msg_dir / 'weclaw.db',
    }


def contact_db_path(message_db):
    db_storage, _ = account_dirs(message_db)
    return db_storage / 'contact' / 'contact.db'


def connect(db_path, key_hex, salt_hex, passphrase=''):
    """按 NT 的派生链打开一个库。打不开就抛，不静默当空。"""
    import sqlcipher3
    derived_key, derived_salt = nt_common.derive_database_key(
        str(db_path), key_hex, salt_hex, passphrase)
    conn = sqlcipher3.connect(str(db_path))
    cur = conn.cursor()
    cur.execute("PRAGMA key = \"x'%s%s'\"" % (derived_key, derived_salt))
    # PRAGMA key 永不报错；读一次 sqlite_master 才真正解密
    cur.execute('SELECT COUNT(*) FROM sqlite_master').fetchone()
    return conn


# ==================== overview ====================

def read_overview(paths, opener):
    """每个库每张表的行数。**空表也报**——0 行 ≠ 没有这张表。

    读不出的表 `rows` 为 `None`（不是 0），并在库里带 `error`。
    """
    libs = []
    for name, path in paths.items():
        if name.startswith('_'):
            # `_contact` 是内部辅助键（solitaire 反查会话用），不是待普查的库
            continue
        entry = {'db': name, 'path': str(path), 'exists': Path(path).exists(),
                 'tables': []}
        if not entry['exists']:
            libs.append(entry)
            continue
        try:
            conn = opener(path)
        except Exception as error:
            entry['error'] = '%s: %s' % (type(error).__name__, str(error)[:200])
            libs.append(entry)
            continue
        try:
            for t in table_names(conn):
                entry['tables'].append({'name': t, 'rows': row_count(conn, t)})
        finally:
            conn.close()
        libs.append(entry)

    total = sum(len(l['tables']) for l in libs)
    nonempty = sum(1 for l in libs for t in l['tables'] if t['rows'])
    unreadable = sum(1 for l in libs for t in l['tables'] if t['rows'] is None)
    return {
        'libraries': libs,
        'libraryCount': len(libs),
        'tableCount': total,
        'nonEmptyTableCount': nonempty,
        'unreadableTableCount': unreadable,
        'note': ('`rows: null` 表示这张表读不出来（不是 0 行）。'
                 '0 行表示表存在且为空——和"没有这张表"是两件事。'),
    }


# ==================== search-history ====================

def search_history_rows(conn):
    """微信内置搜索历史：三张表，**不合并**（实测互不重叠）。

    `SearchRecent` 与 `websearch_record` 的 query/keyword 交集是 0，是两个来源：
    前者是"搜索框里点过谁"，后者是"搜过什么词"。合成一张会丢一半。
    """
    r = Reader(conn)
    keyword_rows = [
        {'source': 'websearch', 'keyword': text(kw), 'time': int(t or 0),
         'payloadLen': len(text(pl))}
        for kw, pl, t in r.rows('websearch_record', 'SELECT %s, %s, create_time '
                                'FROM websearch_record' % (T('keyword'), T('pay_load_')))
    ]
    recent_rows = [
        {'source': 'search-recent', 'username': text(u), 'keyword': text(kw),
         'score': int(s or 0), 'time': int(t or 0)}
        for u, kw, s, t in r.rows(
            'SearchRecent', 'SELECT %s, %s, score, last_click_time FROM SearchRecent'
            % (T('username'), T('query')))
    ]
    brand_rows = [
        {'source': 'brand-search', 'keyword': text(kw), 'time': int(t or 0),
         'payloadLen': len(text(pl))}
        for kw, pl, t in r.rows(
            'brand_search_record', 'SELECT %s, %s, create_time FROM brand_search_record'
            % (T('keyword'), T('pay_load_')))
    ]
    rows = keyword_rows + recent_rows + brand_rows
    rows.sort(key=lambda x: x.get('time') or 0, reverse=True)
    return r.attach({
        'rows': rows,
        'counts': {
            'websearch': len(keyword_rows),
            'searchRecent': len(recent_rows),
            'brandSearch': len(brand_rows),
        },
        'note': ('三路不是重复：实测 SearchRecent.query 与 websearch_record.keyword '
                 '交集为 0。时间戳为本地 unix 秒。`payloadLen` 是 pay_load_ 的字符数'
                 '（实测 83/83 是 JSON 形状，内容未解析）。'),
    })


# ==================== sessions（一手会话表） ====================

def session_rows(conn, include_unread=False):
    """session.db 的一手表 + 删除痕迹。

    `sessions` 命令是从消息分片**推导**会话的；这里是微信自己的表，两者语义不同
    （这份有未读数、摘要、隐藏位、删除时间）。所以不合并、不互相覆盖。

    **`type` 在本机是常量 0**，不提供按它过滤。
    未读明细的 `username_id` 经实测是 `Name2Id.rowid`（276/276 命中），
    这里把它解成 username；解不到的如实保留 id 并标 `unresolved`。
    """
    r = Reader(conn)

    id_to_name = {}
    for rid, u in r.rows('Name2Id', 'SELECT rowid, %s FROM Name2Id' % T('user_name')):
        name = text(u)
        if name:
            id_to_name[int(rid)] = name

    rows = []
    for (u, typ, unread, hidden, summary, draft, status,
         last_ts, last_sender, last_display) in r.rows(
            'SessionTable',
            'SELECT %s, type, unread_count, is_hidden, %s, %s, status, '
            'last_timestamp, %s, %s FROM SessionTable'
            % (T('username'), T('summary'), T('draft'), T('last_msg_sender'),
               T('last_sender_display_name'))):
        rows.append({
            'username': text(u),
            'type': typ,                    # 常量 0，见 UNVERIFIED_ENUMS
            'unreadCount': int(unread or 0),
            'isHidden': int(hidden or 0),
            'summary': text(summary),
            'hasDraft': bool(text(draft)),
            'status': status,               # 未验证语义
            'lastTimestamp': int(last_ts or 0),
            'lastMsgSender': text(last_sender),
            'lastSenderDisplay': text(last_display),
        })
    rows.sort(key=lambda x: x['lastTimestamp'], reverse=True)

    deleted = [
        {'username': text(u), 'deleteTime': int(t or 0)}
        for u, t in r.rows('SessionDeleteTable',
                           'SELECT %s, delete_time FROM SessionDeleteTable' % T('username'))
    ]
    deleted.sort(key=lambda x: x['deleteTime'], reverse=True)

    result = {
        'sessions': rows,
        'deleted': deleted,
        'counts': {'sessions': len(rows), 'deleted': len(deleted)},
        'note': ('这份是微信自己的会话表，和 `weflow-cli sessions`（从消息分片推导）'
                 '不是同一件事，故不合并。`deleted` 是**唯一痕迹**：实测 6 条删除记录里 '
                 '0 条还留在 SessionTable。'),
        'unverifiedEnums': {k: v for k, v in UNVERIFIED_ENUMS.items()
                            if k.startswith('SessionTable.')},
    }

    if include_unread:
        unread_rows = []
        unresolved = 0
        for uid, sid, ctime, lid in r.rows(
                'SessionUnreadListTable_1',
                'SELECT username_id, server_id, create_time, local_id '
                'FROM SessionUnreadListTable_1'):
            name = id_to_name.get(int(uid or 0))
            if not name:
                unresolved += 1
            unread_rows.append({
                'username': name or '',
                'usernameId': int(uid or 0),
                'unresolved': name is None,
                'serverId': int(sid or 0),
                'createTime': int(ctime or 0),
                'localId': int(lid or 0),
            })
        unread_rows.sort(key=lambda x: x['createTime'], reverse=True)
        result['unread'] = unread_rows
        result['counts']['unread'] = len(unread_rows)
        result['unreadJoin'] = {
            'resolved': len(unread_rows) - unresolved,
            'unresolved': unresolved,
            'how': 'username_id → Name2Id.rowid（实测 276/276 命中）',
        }

    return r.attach(result)


# ==================== emoticons（元数据） ====================

def emoticon_rows(conn):
    """表情库元数据。**解密仍未解**：`aes_key` 解不开缓存文件（见文件头说明）。

    所以这里只给"有什么"：md5（=本机缓存文件名）、caption、CDN 地址、所属表情包。
    不给"图片本体"——因为拿不到，写成能拿到是撒谎。
    """
    r = Reader(conn)

    custom = [
        {'md5': text(md5), 'caption': text(caption), 'hasAesKey': bool(akey),
         'thumbUrl': text(thumb), 'cdnUrl': text(cdn),
         'externUrl': text(eurl), 'designerId': text(designer)}
        for md5, caption, akey, thumb, cdn, eurl, designer in r.rows(
            'kNonStoreEmoticonTable',
            'SELECT %s, %s, %s, %s, %s, %s, %s FROM kNonStoreEmoticonTable'
            % (T('md5'), T('caption'), T('aes_key'), T('thumb_url'),
               T('cdn_url'), T('extern_url'), T('designer_id')))
    ]

    packages = [
        {'packageId': text(pid), 'name': text(pname),
         'paymentStatus': pay, 'downloadStatus': dl,
         'installTime': int(install or 0), 'removeTime': int(remove or 0),
         'introduction': text(intro)[:200], 'author': text(author),
         'iconUrl': text(icon)}
        for pid, pname, pay, dl, install, remove, intro, author, icon in r.rows(
            'kStoreEmoticonPackageTable',
            'SELECT %s, %s, payment_status_, download_status_, install_time_, '
            'remove_time_, %s, %s, %s FROM kStoreEmoticonPackageTable'
            % (T('package_id_'), T('package_name_'), T('introduction_'),
               T('author_'), T('store_icon_url_')))
    ]

    # 包内文件：offset 从 0 起连续，说明是"单文件归档"而不是一盘散文件
    pkg_files = {}
    for pid, md5, typ, order, esize, eoff, tsize, toff in r.rows(
            'kStoreEmoticonFilesTable',
            'SELECT %s, %s, type_, sort_order_, emoticon_size_, emoticon_offset_, '
            'thumb_size_, thumb_offset_ FROM kStoreEmoticonFilesTable'
            % (T('package_id_'), T('md5_'))):
        pkg_files.setdefault(text(pid), []).append({
            'md5': text(md5), 'type': typ, 'sortOrder': order,
            'emoticonSize': int(esize or 0), 'emoticonOffset': int(eoff or 0),
            'thumbSize': int(tsize or 0), 'thumbOffset': int(toff or 0),
        })

    captions = {}
    for pid, md5, lang, cap in r.rows(
            'kStoreEmoticonCaptionsTable',
            'SELECT %s, %s, %s, %s FROM kStoreEmoticonCaptionsTable'
            % (T('package_id_'), T('md5_'), T('language_'), T('caption_'))):
        captions.setdefault(text(pid), []).append(
            {'md5': text(md5), 'language': text(lang), 'caption': text(cap)})

    return r.attach({
        'custom': custom,
        'packages': packages,
        'packageFiles': pkg_files,
        'packageCaptions': captions,
        'counts': {
            'custom': len(custom),
            'packages': len(packages),
            'packageFiles': sum(len(v) for v in pkg_files.values()),
            'packageCaptions': sum(len(v) for v in captions.values()),
        },
        'notDecryptable': {
            'what': '表情图片本体',
            'why': ('aes_key 是 32 位 hex（=16 字节，长度上正好是 AES-128），但实测解不开：'
                    '111 个能按 md5 对上号的本机缓存文件，CBC(key=iv)/CBC(iv=0)/ECB 全 0 命中；'
                    '同一测试里用全 0 当错 key 的对照也是 0，说明否定不是测试坏了。'),
            'whatThisGives': 'md5（＝本机缓存文件名）、caption、CDN 地址、所属表情包',
        },
        'note': ('包内文件 offset 从 0 起连续（每包 12–24 个），说明表情包是**单文件归档**；'
                 '要取其中某张得先有那个归档文件。'),
        'unverifiedEnums': {'kNonStoreEmoticonTable.type': UNVERIFIED_ENUMS[
            'kNonStoreEmoticonTable.type']},
    })


# ==================== fmessages（好友申请） ====================

def fmessage_rows(conn):
    """好友/群申请记录。`content_` 是申请语（本机观测长度 3–33 字）。"""
    r = Reader(conn)
    rows = [
        {'username': text(u), 'type': typ, 'time': int(ts or 0),
         'content': text(content), 'isSender': int(is_sender or 0),
         'remark': text(remark), 'scene': scene}
        for u, typ, ts, content, is_sender, remark, scene in r.rows(
            'FMessageTable',
            'SELECT %s, type_, timestamp_, %s, is_sender_, %s, scene_ FROM FMessageTable'
            % (T('user_name_'), T('content_'), T('remark_')))
    ]
    rows.sort(key=lambda x: x['time'], reverse=True)
    return r.attach({
        'rows': rows,
        'counts': {'total': len(rows),
                   'incoming': sum(1 for x in rows if not x['isSender']),
                   'outgoing': sum(1 for x in rows if x['isSender'])},
        'unverifiedEnums': {'FMessageTable.type_': UNVERIFIED_ENUMS['FMessageTable.type_']},
    })


# ==================== solitaire（群接龙） ====================

SOLITAIRE_PREFIXES = ('SolitaireValid_', 'SolitaireFold_', 'Solitaire_')


def solitaire_groups(conn):
    """把 `Solitaire_<md5>` / `SolitaireValid_<md5>` / `SolitaireFold_<md5>` 按 md5 归组。

    前缀按**从长到短**匹配：`SolitaireValid_x` 也是 `Solitaire_` 开头的子串形态，
    顺序错了会把 valid 表认成主表（本机 5 张表会归成 3 组而不是 2 组）。
    """
    groups = {}
    for name in table_names(conn):
        for prefix in SOLITAIRE_PREFIXES:
            if name.startswith(prefix):
                groups.setdefault(name[len(prefix):], {})[prefix] = name
                break
    return groups


def solitaire_rows(conn, name_map=None):
    """群接龙：主体 + 有效列表 + 折叠内容。

    `name_map` 是 `{md5(username): username}`，用来把 md5 解回会话；
    给不出来就留 md5（不猜）。
    """
    name_map = name_map or {}
    r = Reader(conn)
    out = []
    for md5, tables in sorted(solitaire_groups(conn).items()):
        entry = {
            'sessionMd5': md5,
            'session': name_map.get(md5, ''),
            'resolved': md5 in name_map,
            'main': [],
            'valid': [],
            'folded': [],
        }
        if 'Solitaire_' in tables:
            for header, footer, content, sstr, active, sid in r.rows(
                    'Solitaire_', 'SELECT %s, %s, %s, %s, active_time, %s FROM "%s"'
                    % (T('header'), T('footer'), T('content'), T('solitaire_string'),
                       T('sid'), tables['Solitaire_'])):
                entry['main'].append({
                    'header': text(header), 'footer': text(footer),
                    'content': text(content), 'solitaireString': text(sstr),
                    'activeTime': int(active or 0), 'sid': text(sid),
                })
        if 'SolitaireValid_' in tables:
            for title, valid, lid, seq, ctime in r.rows(
                    'SolitaireValid_',
                    'SELECT %s, valid, local_id, sort_seq, create_time FROM "%s"'
                    % (T('title'), tables['SolitaireValid_'])):
                entry['valid'].append({
                    'title': text(title), 'valid': int(valid or 0),
                    'localId': int(lid or 0), 'sortSeq': int(seq or 0),
                    'createTime': int(ctime or 0),
                })
            entry['valid'].sort(key=lambda x: x['createTime'], reverse=True)
        if 'SolitaireFold_' in tables:
            for front, behind, lid, seq, ctime in r.rows(
                    'SolitaireFold_',
                    'SELECT %s, %s, local_id, sort_seq, create_time FROM "%s"'
                    % (T('front_content'), T('behind_content'),
                       tables['SolitaireFold_'])):
                entry['folded'].append({
                    'front': text(front), 'behind': text(behind),
                    'localId': int(lid or 0), 'sortSeq': int(seq or 0),
                    'createTime': int(ctime or 0),
                })
            entry['folded'].sort(key=lambda x: x['createTime'], reverse=True)
        out.append(entry)

    return r.attach({
        'groups': out,
        'counts': {
            'sessions': len(out),
            'resolved': sum(1 for g in out if g['resolved']),
            'mainItems': sum(len(g['main']) for g in out),
            'validItems': sum(len(g['valid']) for g in out),
            'foldedItems': sum(len(g['folded']) for g in out),
        },
        'note': ('表名里的 md5 = md5(会话 username)（实测 2/2 命中）。'
                 '解不到会话的组保留 md5、不猜。'),
    })


# ==================== biz-subscribe（公众号订阅 + 小程序） ====================

def biz_subscribe_rows(conn):
    """公众号订阅状态 + 小程序清单。

    `wacontact.contact_pack_data` 是 BLOB，本机 470/470 非空——里面是小程序的结构化
    资料，格式未解，所以只报"有"，不假装解出了字段。
    """
    r = Reader(conn)
    subs = [
        {'bizUsername': text(u), 'templateId': text(t), 'isSubscribe': s}
        for u, t, s in r.rows(
            'biz_subscribe_status',
            'SELECT %s, %s, is_subscribe FROM biz_subscribe_status'
            % (T('biz_username'), T('template_id')))
    ]
    wac = [
        {'username': text(u), 'type': typ, 'iconUrl': text(icon), 'appId': text(appid)}
        for u, typ, icon, appid in r.rows(
            'wacontact',
            'SELECT %s, type, %s, %s FROM wacontact'
            % (T('user_name'), T('brand_icon_url'), T('app_id')))
    ]
    weapp_sync = [
        {'username': text(u), 'lastUpdate': int(t or 0), 'versionHex': text(v)}
        for u, t, v in r.rows(
            'WeAppBizAttrSyncBufferTableV02',
            'SELECT %s, last_update_time, %s FROM WeAppBizAttrSyncBufferTableV02'
            % (T('user_name'), T('version')))
    ]
    return r.attach({
        'subscriptions': subs,
        'miniPrograms': wac,
        'miniProgramSync': weapp_sync,
        'counts': {
            'subscriptions': len(subs),
            'subscribed': sum(1 for s in subs if s['isSubscribe']),
            'miniPrograms': len(wac),
            'miniProgramSync': len(weapp_sync),
        },
        'undecodedBlobs': ['wacontact.contact_pack_data（小程序结构化资料，格式未解）'],
        'note': ('`versionHex` 原样给十六进制：这一列**存了非法 UTF-8**，'
                 '直接按文本读会让整条查询抛错。'),
        'unverifiedEnums': {
            'biz_subscribe_status.is_subscribe': UNVERIFIED_ENUMS[
                'biz_subscribe_status.is_subscribe'],
            'wacontact.type': UNVERIFIED_ENUMS['wacontact.type'],
        },
    })


# ==================== revoke（撤回） ====================

def revoke_rows(conn):
    """撤回痕迹：`revokemessage`（单条）与 `revokebatchmessage`（批量）。

    `revokemessage` 本机 0 行但表存在——这是"有这张表、没有记录"，不是"没有这个功能"。
    """
    r = Reader(conn)
    single = [
        {'toUsername': text(u), 'serverId': int(sid or 0), 'messageType': mt,
         'revokeTime': int(rt or 0), 'content': text(ct), 'atUserList': text(at)}
        for u, sid, mt, rt, ct, at in r.rows(
            'revokemessage',
            'SELECT %s, svr_id, message_type, revoke_time, %s, %s FROM revokemessage'
            % (T('to_user_name'), T('content'), T('at_user_list')))
    ]
    single.sort(key=lambda x: x['revokeTime'], reverse=True)

    batch = [
        {'session': text(s), 'batchId': bid, 'msgLocalId': int(mlid or 0),
         'msgCreateTime': int(mct or 0), 'msgUniqueId': text(uid)}
        for lid, bid, uid, s, mlid, mct in r.rows(
            'revokebatchmessage',
            'SELECT local_id, batch_id, %s, %s, msg_local_id, msg_create_time '
            'FROM revokebatchmessage' % (T('msg_unique_id'), T('session_name')))
    ]
    batch.sort(key=lambda x: x['msgCreateTime'], reverse=True)

    return r.attach({
        'revokedMessages': single,
        'revokedBatches': batch,
        'counts': {'revokedMessages': len(single), 'revokedBatches': len(batch)},
        'note': ('revokemessage 本机 0 行**但表存在**——"有表无记录"不等于"没这个功能"。'
                 '批量撤回的 msgCreateTime 指向被撤回的那条消息，不是撤回动作发生的时间。'),
    })


# ==================== bizchat（企业微信） ====================

def bizchat_rows(conn):
    """企业微信联系人。本机 `chat_group` 0 行但 `user_info` 有 2 行。"""
    r = Reader(conn)
    groups = [
        {'groupId': text(g), 'name': text(n), 'owner': text(o),
         'maxMemberCount': mc, 'headImgUrl': text(h)}
        for g, n, o, mc, h in r.rows(
            'chat_group',
            'SELECT %s, %s, %s, max_member_count, %s FROM chat_group'
            % (T('group_id'), T('chat_name'), T('owner_id'), T('head_img_url')))
    ]
    users = [
        {'userId': text(uid), 'brandUserName': text(b), 'userName': text(u),
         'headImgUrl': text(h), 'profileUrl': text(p)}
        for uid, b, u, h, p in r.rows(
            'user_info',
            'SELECT %s, %s, %s, %s, %s FROM user_info'
            % (T('user_id'), T('brand_user_name'), T('user_name'),
               T('head_img_url'), T('profile_url')))
    ]
    mine = [
        {'userId': text(uid), 'brandUserName': text(b)}
        for b, uid in r.rows('my_user_info',
                             'SELECT %s, %s FROM my_user_info'
                             % (T('brand_user_name'), T('user_id')))
    ]
    return r.attach({
        'chatGroups': groups,
        'users': users,
        'me': mine,
        'counts': {'chatGroups': len(groups), 'users': len(users), 'me': len(mine)},
        'note': ('本机 chat_group 0 行——企业微信群一个都没建过。'
                 '0 行是"没建过"，不是"读不到"。'),
    })


# ==================== 编排 ====================

READERS = {
    'search-history': ('general', search_history_rows),
    'sessions': ('session', session_rows),
    'emoticons': ('emoticon', emoticon_rows),
    'fmessages': ('general', fmessage_rows),
    'solitaire': ('solitaire', solitaire_rows),
    'biz-subscribe': ('general', biz_subscribe_rows),
    'revoke': ('general', revoke_rows),
    'bizchat': ('bizchat', bizchat_rows),
}


def build_name_map(message_db, opener):
    """构造 solitaire 需要的 `{md5(username): username}`。

    只从 contact.db 取 username，不读任何正文。取不到就返回空表
    （调用方会如实标 unresolved，而不是猜一个名字）。
    """
    import hashlib
    users = []
    try:
        conn = opener(contact_db_path(message_db))
        try:
            users = [r[0] for r in conn.execute(
                'SELECT %s FROM contact' % T('username')) if r[0]]
        finally:
            conn.close()
    except Exception:
        return {}
    return {hashlib.md5(text(u).encode()).hexdigest(): text(u) for u in users}


def run_kind(kind, dbs, opener, message_db, include_unread=False):
    """读一个 kind，返回 (data|None, error|None)。"""
    if kind == 'overview':
        return read_overview(dbs, opener), None
    db_key, reader = READERS[kind]
    path = dbs.get(db_key)
    if path is None or not Path(path).exists():
        return None, '找不到 %s（%s）——先 weflow-cli init' % (db_key, path)
    try:
        conn = opener(path)
    except Exception as error:
        return None, '%s 打不开：%s: %s' % (db_key, type(error).__name__,
                                          str(error)[:200])
    try:
        if kind == 'sessions':
            data = reader(conn, include_unread=include_unread)
        elif kind == 'solitaire':
            data = reader(conn, name_map=build_name_map(message_db, opener))
        else:
            data = reader(conn)
    finally:
        conn.close()
    data['db'] = db_key
    data['dbPath'] = str(path)
    return data, None


def resolve_credentials(cfg):
    """从配置取 ntDbPath / ntKey / ntSalt / passphrase。

    加密存储的键在磁盘上是 `lock:<密文>`，`decrypt_lock` 对明文**原样返回**，
    所以这两个都无脑过一遍——这比"先判断有没有 lock: 前缀"少一条会写错的分支，
    也是 `_utils` 里既有的约定（`test/encrypted_config_test.py` 认这个形态）。
    """
    return (
        cfg.get('ntDbPath') or '',
        decrypt_lock(cfg.get('ntKey') or ''),
        decrypt_lock(cfg.get('ntSalt') or ''),
        decrypt_lock(cfg.get('favPassphrase') or '')
        or decrypt_lock(cfg.get('decryptKey') or ''),
    )


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser(
        description='NT 库里其余那些还没人读过的东西（本地只读、不联网）')
    ap.add_argument('kind', nargs='?', choices=list(KINDS) + ['all'],
                    help='要读哪一类；all = 全部')
    ap.add_argument('--db', help='message_0.db 路径（默认取配置 ntDbPath）')
    ap.add_argument('--unread', action='store_true',
                    help='sessions 额外带上未读明细（本机 2.6 万行）')
    args = ap.parse_args()

    if not args.kind:
        ap.print_help()
        return 1

    cfg = load_config() or {}
    nt_db, nt_key, nt_salt, passphrase = resolve_credentials(cfg)
    # `--db` 优先，其次 CLI 通过环境变量传的（路径不进 argv），最后配置
    message_db = args.db or os.environ.get('WEFLOW_EXTRAS_DB') or nt_db
    if not message_db:
        print(json.dumps({'success': False,
                          'error': '未配置 ntDbPath（先 weflow-cli init）'},
                         ensure_ascii=True))
        return 1
    if not Path(message_db).exists():
        print(json.dumps({'success': False,
                          'error': '数据库不存在：%s' % message_db},
                         ensure_ascii=True))
        return 1

    dbs = db_paths(message_db)
    dbs['_contact'] = contact_db_path(message_db)

    def opener(path):
        return connect(path, nt_key, nt_salt, passphrase)

    if args.kind == 'all':
        kinds = list(KINDS)
    else:
        kinds = [args.kind]

    results = {}
    errors = {}
    for kind in kinds:
        data, error = run_kind(kind, dbs, opener, message_db,
                               include_unread=args.unread)
        if error:
            errors[kind] = error
        else:
            results[kind] = data

    payload = {
        'success': not errors,
        'kinds': kinds,
        'results': results,
        'errors': errors,
    }
    print(json.dumps(payload, ensure_ascii=True, default=str))
    return 0 if not errors else 1


if __name__ == '__main__':
    sys.exit(main() or 0)
