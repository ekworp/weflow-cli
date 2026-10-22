"""批量转写语音消息，产出一份可检索的清单（`output/.voice_index/voices.jsonl`）。

为什么要有它：`wechat_voice.py` 只能一条会话一条会话地转，转完就躺在一个按**内容哈希**
命名的缓存里——**知道"这段音频说了什么"，但不知道"是哪条消息、谁在什么时候发的"**。
而检索需要的正是后者。

所以这里做三件事：
  1. 从 `media_*.db` 的 `VoiceInfo` 按时间取语音（带上会话、发送者、时间）；
  2. 调 `wechat_voice.ensure_transcripts` 填空缺（断点续传：已转过的按内容命中缓存）；
  3. 把 `(消息, 时间, 会话, 文本)` 落成 JSONL，供 `phrase-build` 并进 FTS。

用法：
    python scripts/voice_transcribe.py --days 30
    python scripts/voice_transcribe.py --days 7 --limit 5      # 先试几条
    python scripts/voice_transcribe.py --days 30 --model tiny  # 更快、更糙
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from _utils import load_config, decrypt_lock  # noqa: E402
import wechat_voice as wv  # noqa: E402

ROOT = SCRIPT_DIR.parent
OUT_DIR = ROOT / 'output' / '.voice_index'
CACHE_DIR = ROOT / 'output' / '.voice_cache'
TZ = timezone(timedelta(hours=8))


def _keys(cfg):
    """配置里的密钥是 `lock:` 密文，必须先解密 —— 直接拿密文去派生只会得到"不是数据库"。"""
    key = decrypt_lock(cfg.get('ntKey', '') or '')
    salt = decrypt_lock(cfg.get('ntSalt', '') or '')
    pw = decrypt_lock(cfg.get('favPassphrase', '') or cfg.get('decryptKey', '') or '')
    return key, salt, pw


def collect(cfg, days, limit=0):
    """[(shard, chat_name_id, local_id, create_time, blob, name)]，按时间倒序。"""
    key, salt, pw = _keys(cfg)
    db = cfg.get('ntDbPath') or ''
    if not db:
        raise SystemExit('配置里没有 ntDbPath')
    since = int(time.time()) - days * 86400
    rows = []
    for shard in wv.voice_shards(db):
        conn = None
        try:
            conn, cur = wv._open(shard, key, salt, pw)
            cur.execute('SELECT rowid, user_name FROM Name2Id')
            names = {r[0]: r[1] for r in cur.fetchall()}
            cur.execute(
                'SELECT chat_name_id, local_id, create_time, voice_data FROM VoiceInfo '
                'WHERE voice_data IS NOT NULL AND create_time >= ? '
                'ORDER BY create_time DESC', (since,))
            for cid, lid, ts, blob in cur.fetchall():
                rows.append((str(shard), cid, lid, int(ts or 0), blob,
                         names.get(cid, str(cid))))
        except Exception as exc:
            print(f'[WARN] {pathlib.Path(shard).name} 读不了（{type(exc).__name__}: {exc}）',
                  file=sys.stderr)
        finally:
            if conn:
                conn.close()
    rows.sort(key=lambda r: r[3], reverse=True)
    if limit and limit > 0:
        rows = rows[:limit]

    # 会话名从 **contact.db** 补一层：消息库的 `Name2Id` 只有 id，语音清单里
    # 只写 id 的话，搜索结果显示成 `wxid_xxx`（2026-10-22 第一版就是这样）。
    try:
        from network import load_graph
        people, _rooms, _members = load_graph(cfg)
        by_username = {p['username']: (p['remark'] or p['nick'] or p['username'])
                       for p in people.values()}
        rows = [(s, c, l, t, b, by_username.get(name, name)) for s, c, l, t, b, name in rows]
    except Exception as exc:
        print(f'[WARN] 读联系人失败（{type(exc).__name__}: {exc}），语音清单里显示 id',
              file=sys.stderr)
    return rows


def main():
    ap = argparse.ArgumentParser(description='批量转写微信语音，产出可检索清单')
    ap.add_argument('--days', type=int, default=30, help='只转最近 N 天（默认 30）')
    ap.add_argument('--limit', type=int, default=0, help='最多转写几条（0 = 不限）')
    ap.add_argument('--model', default='small', help='faster-whisper 模型名或本地目录')
    ap.add_argument('--language', default='zh', help='语言提示')
    ap.add_argument('--cache-dir', default='', help='转写缓存目录（换模型时换一个，否则会命中旧模型的结果）')
    args = ap.parse_args()

    cfg = load_config()
    rows = collect(cfg, args.days, args.limit)
    print(f'最近 {args.days} 天语音: {len(rows)} 条')
    if not rows:
        return 0
    cache_dir = args.cache_dir or str(CACHE_DIR)
    pathlib.Path(cache_dir).mkdir(parents=True, exist_ok=True)

    voices = {(r[5], r[2]): r[4] for r in rows}
    started = time.time()
    processed, cached, failed = wv.ensure_transcripts(
        voices, cache_dir, model_name=args.model, language=args.language)
    elapsed = time.time() - started
    print(f'转写完成: 新增 {processed}，缓存命中 {cached}，失败 {failed}，耗时 {elapsed/60:.1f} 分钟')

    cache = wv.TranscriptCache(cache_dir)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / 'voices.jsonl'
    written = empty = 0
    with out.open('w', encoding='utf-8') as fh:
        for shard, cid, lid, ts, blob, name in rows:
            text = (cache.get(wv.voice_key(blob)) or '').strip()
            if not text:
                empty += 1
                continue
            dt = datetime.fromtimestamp(ts, tz=TZ)
            fh.write(json.dumps({
                'id': f'voice:{name}:{lid}',
                'talker': name,
                'time': dt.strftime('%Y-%m-%d %H:%M'),
                'ts': ts,
                'text': text[:500],
            }, ensure_ascii=False) + '\n')
            written += 1
    print(f'写入 {out}：{written} 条有文字（空转写/解码失败 {empty} 条）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
