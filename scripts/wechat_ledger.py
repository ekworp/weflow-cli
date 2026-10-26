# -*- coding: utf-8 -*-
"""读 general.db 的资金流水：红包（redEnvelopeTable）与转账（transferTable）。

2026-10-26 普查产物（docs/NT_DATABASES.md）。两个如实的限制（不猜、不补）：
  · 红包表**没有时间列、没有金额列**——时间/金额都在消息正文里。行按
    message_server_id 排序（服务端 id 单调增，可看先后），溯源字段随行输出，
    关联消息分片是后续工作。
  · 状态枚举（hb_status/receive_status/pay_sub_type）的语义**未逐值验证**，
    原样输出数字并注明，不翻译成没有根据的词。
只读、本地、不联网；方向判定按 wxid 前缀匹配（配置 wxid 可能带 Name2Id 没有的
后缀，1.15.1 的教训）。
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nt_common  # noqa: E402
import nt_decrypt  # noqa: E402
from _utils import decrypt_lock, load_config  # noqa: E402


def general_db_path(message_db):
    """message_0.db 同级的 general/general.db。"""
    return Path(message_db).parent.parent / 'general' / 'general.db'


def connect(db_path, key_hex, salt_hex, passphrase=''):
    import sqlcipher3
    derived_key, derived_salt = nt_common.derive_database_key(
        str(db_path), key_hex, salt_hex, passphrase)
    conn = sqlcipher3.connect(str(db_path))
    c = conn.cursor()
    c.execute("PRAGMA key = \"x'%s%s'\"" % (derived_key, derived_salt))
    c.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()
    return conn


def is_own(name, own_wxid):
    if not name or not own_wxid:
        return False
    return name == own_wxid or name.startswith(own_wxid) or own_wxid.startswith(name)


def ledger_rows(conn, name_map=None, session_filter=None, own_wxid=''):
    """两表 → 归一化行（原样字段 + 方向 + 显示名），新→旧。

    红包没有时间列，用 message_server_id 兜底排序（服务端 id 单调增）；
    转账按 begin_transfer_time 排。两表合并后统一按 sortKey 降序。
    """
    name_map = name_map or {}
    c = conn.cursor()
    rows = []
    for sid, session, sender, send_id, hb_status, hb_type, receive_status in c.execute(
            'SELECT message_server_id, session_name, sender_user_name, send_id, '
            'hb_status, hb_type, receive_status FROM redEnvelopeTable'):
        if session_filter and session_filter not in (session, name_map.get(session, session)):
            continue
        rows.append({
            'kind': '红包',
            'session': session,
            'sessionDisplay': name_map.get(session, session),
            'direction': '我发' if is_own(sender, own_wxid) else '对方发',
            # 状态原样：语义未逐值验证（本机观测 hb_status ∈ {1,4}、receive_status ∈ {0,1,2}）
            'hbStatus': hb_status, 'hbType': hb_type, 'receiveStatus': receive_status,
            'time': None,  # 库内无时间列——要时间得按 messageServerId 关联消息分片（未实现）
            'messageServerId': str(sid or ''),
            'sortKey': int(sid or 0),
        })
    for tid, _txn, sid, session, sub_type, receiver, payer, begin_ts, invalid_ts in c.execute(
            'SELECT transfer_id, transcation_id, message_server_id, session_name, '
            'pay_sub_type, pay_receiver, pay_payer, begin_transfer_time, invalid_time '
            'FROM transferTable'):
        if session_filter and session_filter not in (session, name_map.get(session, session)):
            continue
        direction = '未知'
        if is_own(payer, own_wxid) and not is_own(receiver, own_wxid):
            direction = '我付'
        elif is_own(receiver, own_wxid) and not is_own(payer, own_wxid):
            direction = '我收'
        rows.append({
            'kind': '转账',
            'session': session,
            'sessionDisplay': name_map.get(session, session),
            'direction': direction,
            'paySubType': sub_type,          # 本机观测全为 3；语义未验证
            'counterparty': (receiver if direction == '我付'
                             else payer if direction == '我收' else ''),
            'counterpartyDisplay': name_map.get(
                receiver if direction == '我付' else payer if direction == '我收' else '', ''),
            'time': int(begin_ts or 0),
            'invalidTime': int(invalid_ts or 0),   # >0 的语义（过期/退还）未验证，原样给出
            'messageServerId': str(sid or ''),
            'transferId': str(tid or ''),
            'sortKey': int(begin_ts or 0) or int(sid or 0),
        })
    rows.sort(key=lambda r: r['sortKey'], reverse=True)
    return rows


def keep_within_days(rows, cutoff):
    """--days 过滤：只滤**有时间戳**的行；红包无时间列不受限（如实保留）。

    独立成函数以便测试钉住"红包不被时间窗误杀"——那是把两类行的可用字段
    混为一谈的错误。
    """
    return [r for r in rows if r['time'] is None or r['time'] >= cutoff]


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser(
        description='资金流水：红包与转账（读 general.db；本地只读，不联网）')
    ap.add_argument('--db', default=os.environ.get('WEFLOW_DB_PATH'),
                    help='general.db 路径（默认从 message 库推导同级）')
    ap.add_argument('--talker', default=os.environ.get('WEFLOW_TALKER'),
                    help='可选：只看某个会话（id 或备注/昵称子串）')
    ap.add_argument('--days', type=int, default=0,
                    help='只看最近 N 天（按转账时间过滤；红包无时间列不受此限）')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    config = load_config()
    message_db = config.get('ntDbPath', '')
    if args.db:
        p = Path(args.db)
        db = p if p.name == 'general.db' else general_db_path(p)
    elif message_db:
        db = general_db_path(message_db)
    else:
        db = None
    if not db or not db.exists():
        print(json.dumps({'success': False, 'error': '找不到 general.db（先 weflow-cli init）'}))
        return 1
    passphrase = decrypt_lock(config.get('favPassphrase') or config.get('decryptKey') or '')
    try:
        conn = connect(db, decrypt_lock(config.get('ntKey') or ''),
                       config.get('ntSalt') or '', passphrase)
    except Exception as e:
        print(json.dumps({'success': False, 'error': 'general.db 打不开：%s' % str(e)[:80]}))
        return 1

    try:
        name_map = {}
        contact_db = nt_decrypt.find_contact_db_path(message_db) if message_db else None
        if contact_db:
            name_map = nt_decrypt.load_contact_names(
                contact_db, decrypt_lock(config.get('contactKey') or ''),
                config.get('contactSalt') or '')
        rows = ledger_rows(conn, name_map, args.talker or None,
                           config.get('wxid', ''))
        if args.days and args.days > 0:
            rows = keep_within_days(rows, int(time.time()) - args.days * 86400)
        red = [r for r in rows if r['kind'] == '红包']
        transfers = [r for r in rows if r['kind'] == '转账']
        result = {
            'success': True, 'action': 'ledger',
            'redEnvelopes': len(red), 'transfers': len(transfers),
            'notes': [
                '红包表无时间/金额列：时间与金额在消息正文里，行按 messageServerId 排序（可看先后）',
                '状态枚举（hbStatus/receiveStatus/paySubType）语义未逐值验证，原样输出',
            ],
            'rows': rows,
            'readsLocalData': True, 'invokesAI': False, 'sendsNothing': True,
        }
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print('红包 %d 笔、转账 %d 笔（状态原样，语义未验证）' % (len(red), len(transfers)))
            for r in rows[:40]:
                when = (time.strftime('%Y-%m-%d %H:%M', time.localtime(r['time']))
                        if r.get('time') else '（无时间列）')
                extra = ('status=%s/%s' % (r['hbStatus'], r['receiveStatus'])
                         if r['kind'] == '红包' else
                         ('对方=%s invalid=%s' % (r.get('counterpartyDisplay') or r.get('counterparty') or '?',
                                                   r.get('invalidTime') or 0)))
                print('  [%s] %s · %s · %s · %s' % (
                    when, r['kind'], r['sessionDisplay'], r['direction'], extra))
            if len(rows) > 40:
                print('  …共 %d 行（--json 看全表）' % len(rows))
        return 0
    finally:
        conn.close()


if __name__ == '__main__':
    sys.exit(main())
