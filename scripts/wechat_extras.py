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


# ==================== protobuf（只用于 wacontact.contact_pack_data） ====================
#
# 为什么自己写一个最小解码器：`contact_pack_data` 是没有 .proto 的 BLOB。实测
# **470/470 都能按 protobuf wire format 走通（0 失败）**，所以不需要 schema 也能读出
# 字段号 → 值；再按实测值反推字段号的含义。
#
# **字段号的含义是从本机数据反推的，不是官方 schema。** 所以：
#   · 只映射有实测证据的字段（见 CONTACT_PACK_FIELDS）；
#   · 其余字段号进 `unknownFields`（只报号与次数，不猜名字）；
#   · 解不出 protobuf 就返回 None，绝不返回一个"看起来空"的字典。

def _read_varint(buf, i):
    shift = value = 0
    while i < len(buf):
        byte = buf[i]
        i += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, i
        shift += 7
        if shift > 63:
            raise ValueError('varint 过长')
    raise ValueError('varint 截断')


def parse_protobuf(buf):
    """最小 wire-format 解析：`[(field_no, wire, value)]`。

    wire 0 → value 是 int；wire 2 → value 是 bytes；1/5 → value 是 None（固定长度，
    内容对这里没用）。**标签非法就抛**，由调用方决定怎么兜底。
    """
    out, i, total = [], 0, len(buf)
    while i < total:
        tag, i = _read_varint(buf, i)
        field_no, wire = tag >> 3, tag & 0x07
        if field_no == 0 or wire not in (0, 1, 2, 5):
            raise ValueError('非法 tag（field=%d wire=%d）' % (field_no, wire))
        if wire == 0:
            value, i = _read_varint(buf, i)
            out.append((field_no, 0, value))
        elif wire == 2:
            length, i = _read_varint(buf, i)
            if length > total - i:
                raise ValueError('长度越界')
            out.append((field_no, 2, buf[i:i + length]))
            i += length
        elif wire == 1:
            if i + 8 > total:
                raise ValueError('fixed64 越界')
            i += 8
            out.append((field_no, 1, None))
        else:
            if i + 4 > total:
                raise ValueError('fixed32 越界')
            i += 4
            out.append((field_no, 5, None))
    return out


#: `contact_pack_data` 的字段号 → 含义。**每条都有本机实测依据**（2026-10-27）：
#: f2 是 4–5 个汉字 → 名称；f3 是 `tengxunweibao` / `xichaGO` 这类英文 → 英文 id；
#: f4 与 f5 都形如 `http://wx.qlogo.cn/mmhead/...` 且本机逐行相同 → logo（两个尺寸位）；
#: f6 是 25–38 字的中文句子 → 简介；f1 是嵌套消息（本机多数为空）。
CONTACT_PACK_FIELDS = {
    2: 'name',
    3: 'englishId',
    4: 'logoUrl',
    5: 'logoUrlLarge',
    6: 'description',
}


def decode_contact_pack(blob):
    """`wacontact.contact_pack_data` → `{name, englishId, logoUrl, …, unknownFields}`。

    解不出 protobuf 返回 `None`（调用方据此标"这个 BLOB 没解出来"，而不是给个空字典
    让人以为"这个号没有资料"）。
    """
    if not blob:
        return None
    try:
        fields = parse_protobuf(bytes(blob))
    except (ValueError, TypeError):
        return None
    out = {}
    unknown = {}
    for field_no, wire, value in fields:
        key = CONTACT_PACK_FIELDS.get(field_no)
        if key is None:
            unknown[field_no] = unknown.get(field_no, 0) + 1
            continue
        if wire == 2:
            out[key] = value.decode('utf-8', 'replace')
        elif wire == 0:
            out[key] = value
    if unknown:
        # 只报号与次数：这些字段的含义没有实测证据，猜名字就是把不确定当事实
        out['unknownFields'] = dict(sorted(unknown.items()))
    return out


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

#: `pay_load_`（实测 84/84 是 JSON）里**值得往外抛**的键。
#:
#: 这些是量出来的取舍（2026-10-27，84 行）——**不是"能拿到就都给"**：
#:   · `hotword` 与表里的 `keyword` **84/84 完全相同** → 冗余，丢掉；
#:   · `optype` **84/84 恒为 1** → 常量，丢掉（常量当维度只会给出全中的假象）；
#:   · `businesstype` 83/84 为 0 → 近乎常量，丢掉；
#:   · `timestamp` 与 `create_time` 只差 0～−2 秒 → 同一个时刻，丢掉；
#:   · `scene` 实测 6 档（88×69 / 134×8 / 236×4 / 33 / 139 / 218）、
#:     `parentType` 6 档（7×66 / 0×8 / 53×7 / 135 / 18 / 缺 1）→ **真的在变，保留**，
#:     但语义**未验证**，原样给数字并进 `unverifiedEnums`；
#:   · `requestId` 84/84 有、可作为同一次搜索的关联句柄 → 保留；
#:   · `searchId` 78/84 是空串 → 只在非空时给；
#:   · `extReqParams[]`（40/84）是**搜索过滤器**形状（key + textValue）→ 保留。
PAYLOAD_KEYS = {
    'requestId': 'requestId',
    'searchId': 'searchId',
    'scene': 'scene',
    'parentType': 'parentType',
}


def summarize_payload(hex_or_text):
    """`pay_load_` → 几个能用的键。**不是**搜索结果，是这次搜索的请求上下文。

    实测形状（84 行全解）：`searchId` / `requestId` / `scene` / `businesstype` /
    `parentType` / `optype` / `hotword` / `timestamp` / `clientversion` /
    `extReqParams[]`（含 `key` + `textValue`）/ 若干协议噪声键。

    解析失败返回 `{'jsonError': True}`，不返回空字典——"没有这些字段"和"这条解不开"
    是两件事。
    """
    raw = hex_or_text
    if raw is None:
        return {}
    if isinstance(raw, str):
        # 调用方传进来的是 hex（`T()` 的结果）；但测试可能直接给 JSON 文本
        stripped = raw.lstrip()
        if stripped[:1] in ('{', '['):
            payload_text = raw
        else:
            try:
                payload_text = bytes.fromhex(raw).decode('utf-8', 'replace')
            except (ValueError, TypeError):
                return {'jsonError': True}
    else:
        payload_text = str(raw)
    try:
        obj = json.loads(payload_text)
    except (ValueError, TypeError):
        return {'jsonError': True}
    if not isinstance(obj, dict):
        return {'jsonError': True}
    out = {}
    for src, dst in PAYLOAD_KEYS.items():
        value = obj.get(src)
        # 空串等于没有：`searchId` 78/84 是空串，写成 `"searchId": ""` 会让人以为
        # "这次搜索有 id，只是值为空"，而实际是"这条没记 id"
        if value is not None and value != '':
            out[dst] = value
    # `extReqParams[]` 是 [{key, textValue}]，本机 40/84 有；它是**搜索过滤器**的形状
    params = obj.get('extReqParams')
    if isinstance(params, list) and params:
        pairs = []
        for item in params:
            if isinstance(item, dict) and item.get('key'):
                pairs.append({'key': str(item.get('key'))[:40],
                              'value': str(item.get('textValue') or '')[:60]})
        if pairs:
            out['extReqParams'] = pairs
    return out


def search_history_rows(conn):
    """微信内置搜索历史：三张表，**不合并**（实测互不重叠）。

    `SearchRecent` 与 `websearch_record` 的 query/keyword 交集是 0，是两个来源：
    前者是"搜索框里点过谁"，后者是"搜过什么词"。合成一张会丢一半。
    """
    r = Reader(conn)
    keyword_rows = []
    for kw, pl, t in r.rows(
            'websearch_record',
            'SELECT %s, %s, create_time FROM websearch_record'
            % (T('keyword'), T('pay_load_'))):
        row = {'source': 'websearch', 'keyword': text(kw), 'time': int(t or 0)}
        row.update(summarize_payload(pl))
        keyword_rows.append(row)
    recent_rows = [
        {'source': 'search-recent', 'username': text(u), 'keyword': text(kw),
         'score': int(s or 0), 'time': int(t or 0)}
        for u, kw, s, t in r.rows(
            'SearchRecent', 'SELECT %s, %s, score, last_click_time FROM SearchRecent'
            % (T('username'), T('query')))
    ]
    brand_rows = []
    for kw, pl, t in r.rows(
            'brand_search_record',
            'SELECT %s, %s, create_time FROM brand_search_record'
            % (T('keyword'), T('pay_load_'))):
        row = {'source': 'brand-search', 'keyword': text(kw), 'time': int(t or 0)}
        row.update(summarize_payload(pl))
        brand_rows.append(row)
    rows = keyword_rows + recent_rows + brand_rows
    rows.sort(key=lambda x: x.get('time') or 0, reverse=True)
    unscraped = sum(1 for row in keyword_rows + brand_rows if row.get('jsonError'))
    return r.attach({
        'rows': rows,
        'counts': {
            'websearch': len(keyword_rows),
            'searchRecent': len(recent_rows),
            'brandSearch': len(brand_rows),
            'payloadUnparsed': unscraped,
        },
        'note': ('三路不是重复：实测 SearchRecent.query 与 websearch_record.keyword '
                 '交集为 0。时间戳为本地 unix 秒。`pay_load_` 是**这次搜索的请求上下文**'
                 '（requestId / scene / parentType / extReqParams），里面**没有搜索结果**——'
                 '把 `searchId` 当成"能回查结果"的句柄是没有根据的。'
                 '`hotword`（84/84 等于 keyword）、`optype`（84/84 恒为 1）、'
                 '`timestamp`（与 create_time 同刻）、`businesstype`（83/84 为 0）'
                 '实测无新信息，已丢掉，不在输出里出现。'),
        'unverifiedEnums': {
            'pay_load_.scene': '实测 6 档，语义未验证',
            'pay_load_.parentType': '实测 6 档，语义未验证',
        },
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


# ==================== biz-subscribe（公众号订阅 + 小程序资料卡） ====================

def biz_subscribe_rows(conn):
    """公众号订阅状态 + **小程序**资料卡（`wacontact`）+ 属性同步簿记。

    **`wacontact` 里是小程序**——判据不是 id 前缀，而是解出来的内容：实测 468 个有名称
    的条目里，简介写的是「下单免排队 外卖送上门」「快递查询、发货打单」
    「通过蓝牙技术连接蓝牙水控器」「官方点餐、买单小程序」这类功能描述；配合表名
    `wacontact`（WeApp contact）与 `wx_app_opt` 列，三条证据同向。

    **但它们的 `user_name` 是 `gh_` 前缀（470/470）——所以 `gh_` 前缀不能用来判定
    "这是公众号"。** 这一点在本机验证过边界：这 470 个小程序与 `contact.db`、
    `session.db.Name2Id`、消息库 `Name2Id` 的交集**都是 0**，所以仓库里那些
    `LIKE 'gh_%'` 的公众号过滤**没有被污染**（它们是另一批号）。
    把这条写下来是为了下次有人看到 `gh_` 就断言"公众号"时能查到反例。

    `contact_pack_data` 是 protobuf（470/470 可解析，见 `decode_contact_pack`），
    里面有名称 / 英文 id / logo / 简介——**订阅表本身只有 id 和模板 id**。
    """
    r = Reader(conn)
    subs = [
        {'bizUsername': text(u), 'templateId': text(t), 'isSubscribe': s}
        for u, t, s in r.rows(
            'biz_subscribe_status',
            'SELECT %s, %s, is_subscribe FROM biz_subscribe_status'
            % (T('biz_username'), T('template_id')))
    ]
    weapps = []
    undecoded = 0
    for u, typ, icon, appid, opt, pack in r.rows(
            'wacontact',
            'SELECT %s, type, %s, %s, wx_app_opt, contact_pack_data FROM wacontact'
            % (T('user_name'), T('brand_icon_url'), T('app_id'))):
        decoded = decode_contact_pack(pack)
        ok = decoded is not None
        if not ok:
            undecoded += 1
            decoded = {}
        weapps.append({
            'username': text(u),
            'type': typ,
            'name': decoded.get('name', ''),
            'englishId': decoded.get('englishId', ''),
            'description': decoded.get('description', ''),
            'logoUrl': decoded.get('logoUrl', '') or text(icon),
            'appId': text(appid),
            'wxAppOpt': opt,
            'unknownPackFields': decoded.get('unknownFields', {}),
            'packDecoded': ok,
        })
    attr_sync = [
        {'username': text(u), 'lastUpdate': int(t or 0), 'versionHex': text(v)}
        for u, t, v in r.rows(
            'WeAppBizAttrSyncBufferTableV02',
            'SELECT %s, last_update_time, %s FROM WeAppBizAttrSyncBufferTableV02'
            % (T('user_name'), T('version')))
    ]

    # 两个集合不是同一批号：订阅 ≠ 有资料卡。下面的数字就是答案。
    sub_names = {s['bizUsername'] for s in subs}
    weapp_names = {w['username'] for w in weapps}
    named = sum(1 for s in subs if s['bizUsername'] in weapp_names)

    return r.attach({
        'subscriptions': subs,
        'miniPrograms': weapps,
        'miniProgramAttrSync': attr_sync,
        'counts': {
            'subscriptions': len(subs),
            'subscribed': sum(1 for s in subs if s['isSubscribe']),
            'miniPrograms': len(weapps),
            'miniProgramsNamed': sum(1 for w in weapps if w['name']),
            'miniProgramAttrSync': len(attr_sync),
            'packUndecoded': undecoded,
        },
        'joins': {
            'subscribedWithMiniProgramCard': named,
            'subscribedWithoutCard': len(subs) - named,
            'miniProgrammingNotSubscribed': len(weapp_names - sub_names),
            'note': ('订阅表和资料卡表**不是同一批号**：本机 41 条订阅里只有 '
                     f'{named} 条能在 wacontact 找到资料卡。所以"我订阅了哪些号"'
                     '不能拿 wacontact 的数量代替。'),
        },
        'note': ('`wacontact` 里是小程序（简介内容 + `wx_app_opt` + 表名三条证据），'
                 '但它们的 id 是 `gh_` 前缀——**`gh_` 不专属于公众号**。'
                 '边界已验：这 470 个与 contact.db / Name2Id 的交集都是 0，'
                 '所以现有 `LIKE \'gh_%\'` 的公众号过滤没被污染。'
                 '`versionHex` 原样给十六进制：那一列**存了非法 UTF-8**，'
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
