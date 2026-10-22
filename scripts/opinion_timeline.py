"""某个号的观点时间线：它这一年都说过什么，什么时候开始变了。

日报每天把文章存成 `output/biz-daily/<date>/<topic>/*.md`（frontmatter 带 `source`、
`date`，正文有 `## AI 摘要`），所以"这个号的观点怎么变"是可以按时间排出来的 ——
而微信里你只能一篇篇点开、还没有横轴。

用法：
    python scripts/opinion_timeline.py --list                  # 哪些号存了多少篇
    python scripts/opinion_timeline.py --source 某号      # 时间线
    python scripts/opinion_timeline.py --source 某号 --months 3
    python scripts/opinion_timeline.py --source 某号 --ai       # 让模型总结观点变化
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from collections import defaultdict

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

# 摘要复用日报那套清洗：原始文本是「【核心观点】…【关键细节】1.…」，直接打出来是噪音。
from daily_mail import clean_summary as _clean  # noqa: E402

ROOT = SCRIPT_DIR.parent
DAILY_DIR = ROOT / 'output' / 'biz-daily'


def parse_md(path):
    """frontmatter + `## AI 摘要` 那一段。解析不出来就跳过，不让一篇坏文件毁掉整条时间线。"""
    try:
        text = path.read_text(encoding='utf-8')
    except Exception:
        return None
    meta = {}
    body = text
    if text.startswith('---'):
        end = text.find('\n---', 3)
        if end > 0:
            for line in text[3:end].splitlines():
                if ':' in line:
                    k, v = line.split(':', 1)
                    meta[k.strip()] = v.strip().strip('"')
            body = text[end + 4:]
    summary = ''
    m = re.search(r'##\s*AI 摘要\s*\n+(.+?)(?:\n#|\n---|$)', body, re.S)
    if m:
        summary = ' '.join(m.group(1).split())[:200]
    return {
        'title': meta.get('title', ''),
        'source': meta.get('source', ''),
        'date': meta.get('date', ''),
        'relevance': meta.get('relevance', ''),
        'topic': meta.get('topic', ''),
        'url': meta.get('url', ''),
        'summary': summary,
    }


def load_all():
    """所有日期目录里的文章。"""
    items = []
    if not DAILY_DIR.is_dir():
        return items
    for day in sorted(DAILY_DIR.iterdir()):
        if not day.is_dir():
            continue
        for md in day.rglob('*.md'):
            rec = parse_md(md)
            if rec and rec['source']:
                items.append(rec)
    return items


def main():
    ap = argparse.ArgumentParser(description='某个号的观点时间线')
    ap.add_argument('--source', default='', help='公众号名（子串匹配）')
    ap.add_argument('--months', type=int, default=0, help='只看最近 N 个月（0 = 全部）')
    ap.add_argument('--limit', type=int, default=30, help='最多列几篇（默认 30，最近的在前）')
    ap.add_argument('--list', action='store_true', help='列出存了哪些号、各多少篇')
    ap.add_argument('--ai', action='store_true', help='让模型总结观点变化（要 API key）')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    items = load_all()
    if not items:
        raise SystemExit(f'{DAILY_DIR} 下没有可解析的文章')

    if args.list:
        counter = defaultdict(int)
        for it in items:
            counter[it['source']] += 1
        rows = sorted(counter.items(), key=lambda kv: -kv[1])
        print(f'共 {len(rows)} 个号，{len(items)} 篇\n')
        for name, n in rows[:40]:
            print(f'  {n:>4} 篇  {name}')
        return

    if not args.source:
        ap.print_help()
        return

    picked = [it for it in items if args.source in it['source']]
    if not picked:
        raise SystemExit(f'没有匹配「{args.source}」的文章；用 --list 看有哪些号')
    picked.sort(key=lambda x: x['date'], reverse=True)
    if args.limit and args.limit > 0:
        picked = picked[:args.limit]

    dates = sorted({it['date'] for it in picked})
    print(f"{picked[0]['source']}：{len(picked)} 篇，{dates[0]} ~ {dates[-1]}\n")
    for it in picked:
        rel = f"（{it['relevance']}）" if it['relevance'] else ''
        print(f"{it['date']}  {it['title'][:60]}{rel}")
        if it['summary']:
            print(f"    {_clean(it['summary'], 160)}")

    if args.ai:
        from _utils import load_config, get_api_key, call_ai
        api_key = get_api_key(load_config())
        if not api_key:
            print('\n[WARN] 没有可用的 API key，跳过观点总结', file=sys.stderr)
            return
        lines = [f"{it['date']} {it['title']}：{it['summary']}" for it in picked][-40:]
        prompt = (
            f"下面是同一个公众号「{picked[0]['source']}」按时间排列的文章与要点。\n"
            '请用中文回答：它的关注点或立场有没有随时间变化？如果有，指出从什么变成什么，'
            '并给出对应的日期作为证据；如果没有明显变化，就说明它一直关注什么。'
            '不要罗列所有篇目，不要空话。\n\n' + '\n'.join(lines))
        print('\n--- 观点变化（AI 总结）---')
        print(call_ai(prompt, 'deepseek', api_key, max_tokens=800))


if __name__ == '__main__':
    main()
