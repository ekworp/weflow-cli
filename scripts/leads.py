"""线索雷达：把聊天里"可能是生意"的对话挑出来，并指回原话。

为什么它值得存在：微信里最容易丢的不是重要消息，是**混在闲聊里的机会** —— 有人问价、
有人问能不能做、有人留了联系方式，然后被下一条消息压过去。它和 `promises` 用同一个骨架：
规则先捞候选、再到同会话的后续对话里找"有没有跟上"，**每条结论都带原话**，不做黑箱判断。

默认不调模型。信号分五类（联系方式 / 报价 / 采购 / 合作 / 需求），按命中类型加权排序，
高分的往往是"问了价 + 留了联系方式"这种最该马上回的组合。

用法：
    python scripts/leads.py --days 30
    python scripts/leads.py --days 90 --min-score 3
    python scripts/leads.py --days 30 --json
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from _utils import load_config, decrypt_lock  # noqa: E402
from promises import load_messages, same_account  # noqa: E402
import nt_decrypt as nd  # noqa: E402

TZ = timezone(timedelta(hours=8))

#: 信号类型 → (正则, 权重)。权重表示"这条信号有多像生意"，不是"多重要"。
SIGNALS = {
    '联系方式': (re.compile(r'(微信|vx|wx|威信|手机号|电话|联系我|加我)|1[3-9]\d{9}'
                          r'|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', re.I), 3),
    '报价': (re.compile(r'(多少钱|报价|预算|费用|价格|单价|收费|怎么算钱|贵不贵)'), 3),
    '采购': (re.compile(r'(采购|下单|合同|发票|订购|样品|打款|付款)'), 2),
    '合作': (re.compile(r'(合作|对接|渠道|代理|分销|外包|接单|项目合作)'), 2),
    '需求': (re.compile(r'(需要.{0,8}(做|开发|方案|系统|服务|设计)|能不能做|可以做吗'
                      r'|有没有.{0,4}(做|卖|提供)|求推荐|想找.{0,6}(做|人))'), 2),
}
#: 我跟上了的迹象（在同一条线索之后的同会话消息里找）
FOLLOWED = re.compile(r'(已加|加了|私聊|发你了|发您了|发过去|安排|稍后|好的.{0,4}(我|马上)|收到)')
#: 已经明确黄掉的迹象
DEAD = re.compile(r'(太贵|不考虑|算了|暂时不需要|下次吧|再看看)')

MERGE_WINDOW = 3600      # 同一会话里这一秒数内的信号合成一条线索


#: 广告 / 招聘 / 促销：这些恰好塞满"合作、采购、报价、联系方式"这些词，但**不是线索**。
#: 2026-10-23 第一版没滤它们，30 天里 8 条"线索"全是校招宣讲和电商促销，没有一条真生意。
NOISE = re.compile(
    r'(招聘|校招|秋招|春招|宣讲会|双选会|简历|offer|求职|面试|直播|预告'
    r'|优惠|券|折扣|秒杀|包邮|抽奖|福利|返现|下单链接|u\.jd\.com|拼团|预售|凑单)', re.I)
#: 真线索几乎都带**请求或提问**。纯陈述句（广告、通知）不进来。
ASK = re.compile(r'(吗|呢|？|\?|能否|可以吗|可不可以|麻烦|请问|想找|有没有|多少钱|怎么收费|求推荐)')


def _score(text):
    """(信号类型, 分数)。**先过噪点与提问两道闸，再算信号分。**

    匹配前先剥掉 `@昵称`：群昵称里常带手机号（`@某人13800000000`），不剥的话每一句
    亲戚群闲聊都会被判成"留了联系方式"（2026-10-23 实测，误报全来自这里）。
    """
    bare = re.sub(r'@[^\s]{1,40}\s*', '', text)
    # URL 里的长数字串会命中手机号规则（`?id=4713032079053994316` 这类），先剥链接。
    bare = re.sub(r'https?://\S+', '', bare)
    if len(bare) > 300 or NOISE.search(bare) or not ASK.search(bare):
        return [], 0
    hit = []
    score = 0
    for name, (rx, weight) in SIGNALS.items():
        if rx.search(bare):
            hit.append(name)
            score += weight
    return hit, score


def main():
    ap = argparse.ArgumentParser(description='线索雷达：聊天里的报价/合作/需求信号')
    ap.add_argument('--days', type=int, default=30)
    ap.add_argument('--min-score', type=int, default=2, help='最低分（默认 2）')
    ap.add_argument('--limit', type=int, default=20)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    cfg = load_config()
    db = cfg.get('ntDbPath') or ''
    my_wxid = cfg.get('wxid') or ''
    if not db:
        raise SystemExit('配置里没有 ntDbPath')
    key = decrypt_lock(cfg.get('ntKey', '') or '')
    salt = decrypt_lock(cfg.get('ntSalt', '') or '')
    pw = decrypt_lock(cfg.get('favPassphrase', '') or cfg.get('decryptKey', '') or '')
    conns = nd.connect_message_shards(db, key, salt, pw)
    if not conns:
        raise SystemExit('打不开消息分片')

    try:
        by_talker = load_messages(conns, args.days, my_wxid)
        name_map = {}
        try:
            from network import load_graph
            people, _rooms, _members = load_graph(cfg)
            name_map = {p['username']: (p['remark'] or p['nick'] or p['username'])
                        for p in people.values()}
        except Exception as exc:
            print(f'[WARN] 读联系人失败（{type(exc).__name__}），显示 id', file=sys.stderr)
    finally:
        for conn in conns:
            try:
                conn.close()
            except Exception:
                pass

    leads = []
    for talker, msgs in by_talker.items():
        hits = []
        for i, (ts, is_me, who, text) in enumerate(msgs):
            if is_me:
                continue                      # 线索来自别人说的，不是我自己发的
            kinds, score = _score(text)
            if score < args.min_score:
                continue
            hits.append({'i': i, 'ts': ts, 'text': text, 'kinds': kinds, 'score': score})

        # 同一会话里时间挨近的信号合成一条线索，避免"问价"和"留手机号"被拆成两条。
        merged = []
        for h in hits:
            if merged and h['ts'] - merged[-1]['last'] <= MERGE_WINDOW:
                cur = merged[-1]
                cur['last'] = h['ts']
                cur['score'] = max(cur['score'], h['score']) + 1
                cur['kinds'] = sorted(set(cur['kinds']) | set(h['kinds']))
                if h['text'] not in cur['parts']:
                    cur['parts'].append(h['text'])
                cur['idx'].append(h['i'])
            else:
                merged.append({'first': h['ts'], 'last': h['ts'], 'score': h['score'],
                               'kinds': list(h['kinds']), 'parts': [h['text']],
                               'idx': [h['i']]})

        for m in merged:
            after = msgs[m['idx'][-1] + 1: m['idx'][-1] + 25]
            replied = any(is_me for _, is_me, _w, _t in after)
            followed = any(is_me and FOLLOWED.search(t) for _, is_me, _w, t in after)
            dead = any(DEAD.search(t) for _, _me, _w, t in after)
            state = ('已结束' if dead else '已跟进' if followed else '我回过' if replied else '没回')
            leads.append({
                'time': datetime.fromtimestamp(m['first'], tz=TZ).strftime('%Y-%m-%d %H:%M'),
                'talker': name_map.get(talker, talker),
                'kinds': m['kinds'],
                'score': m['score'],
                'said': ' ／ '.join(p[:80] for p in m['parts'][:3]),
                'state': state,
            })

    leads.sort(key=lambda x: (-x['score'], x['time']), reverse=False)
    leads = leads[:args.limit]

    if args.json:
        print(json.dumps({'success': True, 'days': args.days, 'leads': leads},
                         ensure_ascii=False, indent=2))
        return

    if not leads:
        print(f'最近 {args.days} 天里没有达到分数 {args.min_score} 的线索信号')
        return
    print(f'最近 {args.days} 天的线索信号 {len(leads)} 条（分数越高越像生意）：\n')
    for it in leads:
        print(f"[{it['score']}分 · {'/'.join(it['kinds'])} · {it['state']}] {it['time']}  {it['talker']}")
        print(f"    {it['said']}")
        print()


if __name__ == '__main__':
    main()
