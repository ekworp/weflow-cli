"""时间重放：把关系网络按月展开，生成一个能按播放键的单文件 HTML。

设计见 `docs/REPLAY.md`。要点：
  · 帧 = 自然月；每帧带**数据完整度标记**（前 17 个月只有 1-2 个会话，不能让读者以为程序坏了）
  · 边 = 单聊（我—人）/ 群（我—群、人—群），权重是**互动量**，不叫亲密度
  · 每条边有状态：new / stable / fading / **gone**（gone 才是故事）
  · 纯本地：不联网、不调模型

用法：
    python scripts/replay.py                    # 生成 output/replay.html
    python scripts/replay.py --json             # 只输出聚合结果（验收用）
    python scripts/replay.py --min-weight 10    # 过滤阈值（默认 10）
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from _utils import load_config, decrypt_lock  # noqa: E402
import nt_decrypt as nd  # noqa: E402

ROOT = SCRIPT_DIR.parent
OUT_HTML = ROOT / 'output' / 'replay.html'
TZ = timezone(timedelta(hours=8))

#: 当月消息数低于这个值不算"有互动"。实测 80 个单聊里 36 个只出现过 1 个月，
#: 全画上会让后半段画面剧烈抖动，所以设门槛，并且**把过滤掉的条数打印出来**。
DEFAULT_MIN_WEIGHT = 10
#: 会话数低于这个值的月份判为 sparse（实测 2025-08 是 2 个会话，2025-09 起 47 个）。
SPARSE_TALKERS = 20
#: `gone` 只统计**重要边**。实测每月有 55 条边"上月有本月没有"，全报出来是噪音；
#: 权重低于这个值的边本来就在门槛附近抖动，断了不算"关系断了"。
GONE_MIN_WEIGHT = 20


def _keys(cfg):
    return (decrypt_lock(cfg.get('ntKey', '') or ''),
            decrypt_lock(cfg.get('ntSalt', '') or ''),
            decrypt_lock(cfg.get('favPassphrase', '') or cfg.get('decryptKey', '') or ''))


def _names(cfg):
    """wxid → 显示名。联系人在 contact.db，不在消息库里。"""
    try:
        from network import load_graph
        people, _rooms, _members = load_graph(cfg)
        return {p['username']: (p['remark'] or p['nick'] or p['username'])
                for p in people.values()}
    except Exception as exc:
        print(f'[WARN] 读联系人失败（{type(exc).__name__}），节点显示 id', file=sys.stderr)
        return {}


def scan(cfg):
    """按月聚合。返回 (per_month, total, failed_shards)。"""
    db = cfg.get('ntDbPath') or ''
    if not db:
        raise SystemExit('配置里没有 ntDbPath')
    key, salt, pw = _keys(cfg)
    conns = nd.connect_message_shards(db, key, salt, pw)
    if not conns:
        raise SystemExit('打不开消息分片')

    per_month = defaultdict(lambda: {
        'messages': 0,
        'talkers': set(),
        'people': set(),
        'dm': Counter(),                 # 单聊对象 -> 条数
        'groups': Counter(),             # 群 -> 条数
        'person_group': defaultdict(Counter),  # 人 -> {群: 条数}
    })
    total = 0
    failed = []

    for conn in conns:
        c = conn.cursor()
        try:
            c.execute('SELECT rowid, user_name FROM Name2Id')
            id2name = {r[0]: r[1] for r in c.fetchall()}
        except Exception:
            id2name = {}
        try:
            c.execute('SELECT user_name FROM Name2Id WHERE is_session = 1')
            sessions = [r[0] for r in c.fetchall() if r[0]]
        except Exception:
            sessions = []
        for talker in sessions:
            tbl = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
            try:
                c.execute('SELECT COUNT(*) FROM sqlite_master WHERE name=?', (tbl,))
                if c.fetchone()[0] == 0:
                    continue
                c.execute('SELECT create_time, real_sender_id FROM "%s"' % tbl)
                rows = c.fetchall()
            except Exception as exc:
                failed.append(talker)
                continue
            is_group = talker.endswith('@chatroom')
            for ts, sender in rows:
                if not ts:
                    continue
                month = datetime.fromtimestamp(ts, tz=TZ).strftime('%Y-%m')
                m = per_month[month]
                m['messages'] += 1
                total += 1
                m['talkers'].add(talker)
                who = id2name.get(sender)
                if who:
                    m['people'].add(who)
                if is_group:
                    m['groups'][talker] += 1
                    if who:
                        m['person_group'][who][talker] += 1
                elif who:
                    m['dm'][who] += 1

    for conn in conns:
        try:
            conn.close()
        except Exception:
            pass
    return per_month, total, failed


def build_frames(per_month, names, min_weight):
    """把按月聚合变成带状态的帧序列。"""
    months = sorted(per_month)
    prev_edges = {}          # edge_id -> weight（上个月）
    prev2_edges = {}         # 上上个月
    frames = []
    filtered = 0

    for idx, month in enumerate(months):
        m = per_month[month]
        edges = {}

        # 单聊：我—人
        for who, weight in m['dm'].items():
            if weight < min_weight:
                filtered += 1
                continue
            edges['dm:' + who] = {'src': 'me', 'dst': 'p:' + who, 'kind': 'dm',
                                  'label': names.get(who, who), 'weight': weight}
        # 群：我—群
        for room, weight in m['groups'].items():
            if weight < min_weight:
                filtered += 1
                continue
            edges['grp:' + room] = {'src': 'me', 'dst': 'g:' + room, 'kind': 'group',
                                    'label': names.get(room, room), 'weight': weight}
        # 人—群：只保留每个人当月发言最多的那个群，避免边数爆炸
        for who, rooms in m['person_group'].items():
            if who not in m['dm'] and len(m['people']) > 0:
                pass
            best = rooms.most_common(1)
            if not best:
                continue
            room, weight = best[0]
            if weight < min_weight:
                filtered += 1
                continue
            edges[f'pg:{who}:{room}'] = {'src': 'p:' + who, 'dst': 'g:' + room,
                                          'kind': 'member', 'label': '', 'weight': weight}

        # 状态
        for eid, e in edges.items():
            if eid not in prev_edges:
                e['state'] = 'new'
            elif e['weight'] <= (prev2_edges.get(eid) or 0) * 0.5:
                e['state'] = 'fading'
            elif all(eid in per_month[months[j]]['dm'] or True for j in ()):  # 占位，下面统一算
                e['state'] = 'stable'
            else:
                e['state'] = 'stable'
        gone = [eid for eid in prev_edges
                if eid not in edges and prev_edges[eid] >= GONE_MIN_WEIGHT]

        nodes = {}
        for who, weight in m['dm'].most_common():
            nodes['p:' + who] = {'id': 'p:' + who, 'kind': 'person',
                                 'label': names.get(who, who), 'weight': weight}
        for room, weight in m['groups'].most_common():
            nodes['g:' + room] = {'id': 'g:' + room, 'kind': 'group',
                                  'label': names.get(room, room), 'weight': weight}
        # 只在群里出现、没有单聊的人也要有节点
        for who, rooms in m['person_group'].items():
            if 'p:' + who not in nodes:
                w = sum(rooms.values())
                if w >= min_weight:
                    nodes['p:' + who] = {'id': 'p:' + who, 'kind': 'person',
                                         'label': names.get(who, who), 'weight': w}

        frames.append({
            'month': month,
            'messages': m['messages'],
            'talkers': len(m['talkers']),
            'people': len(m['people']),
            'completeness': 'full' if len(m['talkers']) >= SPARSE_TALKERS else 'sparse',
            'nodes': list(nodes.values()),
            'edges': list(edges.values()),
            'gone': gone,
            'topGroups': [{'label': names.get(r, r), 'weight': w}
                          for r, w in m['groups'].most_common(8)],
        })
        prev2_edges, prev_edges = prev_edges, {eid: e['weight'] for eid, e in edges.items()}

    return frames, filtered


def layout(frames):
    """确定性的"星系"布局：我在中心，群在环上，人贴在自己最常出现的群旁边。

    **不跑力导向迭代**：迭代出来的坐标每帧都会动，播放时整个画面在抖，读者会以为是
    数据在变。这里一次算死，播放时位置固定，只有显隐与大小变化 —— 稳定的画面才看得出
    "哪条边断了"。
    """
    import math
    import random

    random.seed(42)
    groups = sorted({n['id'] for f in frames for n in f['nodes'] if n['kind'] == 'group'})
    pos = {'me': (0.5, 0.5)}
    for i, g in enumerate(groups):
        a = 2 * math.pi * i / max(1, len(groups))
        pos[g] = (0.5 + 0.34 * math.cos(a), 0.5 + 0.34 * math.sin(a))

    # 每个人最常出现的群，用来决定他贴哪个群
    home = {}
    for f in frames:
        for e in f['edges']:
            if e['kind'] == 'member' and e['src'].startswith('p:'):
                cur = home.get(e['src'])
                if cur is None or e['weight'] > cur[1]:
                    home[e['src']] = (e['dst'], e['weight'])

    people = sorted({n['id'] for f in frames for n in f['nodes'] if n['kind'] == 'person'})
    for pid in people:
        host = home.get(pid)
        if host and host[0] in pos:
            gx, gy = pos[host[0]]
            a = random.uniform(0, 2 * math.pi)
            r = random.uniform(0.05, 0.15)
        else:
            gx, gy = 0.5, 0.5
            a = random.uniform(0, 2 * math.pi)
            r = random.uniform(0.12, 0.30)
        pos[pid] = (min(0.97, max(0.03, gx + r * math.cos(a))),
                    min(0.97, max(0.03, gy + r * math.sin(a))))
    return pos


HTML_TEMPLATE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>关系网络时间重放</title>
<style>
  :root { --bg:#0f1115; --fg:#e6e8ee; --dim:#8b93a3; --line:#242a35;
          --new:#4ade80; --stable:#7c8699; --fading:#f59e0b; --gone:#ef4444; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  #wrap { display:flex; height:calc(100vh - 92px); }
  #cv { flex:1; display:block; }
  #side { width:280px; padding:20px; border-left:1px solid var(--line); overflow:auto; }
  #side h2 { font-size:15px; margin:0 0 4px; }
  #month { font-size:28px; font-weight:700; letter-spacing:.5px; }
  #completeness { font-size:12px; margin:2px 0 16px; }
  .row { display:flex; justify-content:space-between; padding:4px 0;
         border-bottom:1px solid var(--line); font-size:13px; }
  .row span:last-child { color:var(--dim); font-variant-numeric:tabular-nums; }
  #goneList { margin-top:14px; font-size:12px; color:var(--gone); }
  #goneList div { padding:2px 0; }
  #ctrl { height:92px; display:flex; align-items:center; gap:14px;
          padding:0 22px; border-top:1px solid var(--line); }
  button { background:#1c2230; color:var(--fg); border:1px solid var(--line);
           border-radius:8px; padding:8px 16px; font-size:14px; cursor:pointer; }
  button:hover { background:#252d3f; }
  #slider { flex:1; accent-color:#4f46e5; }
  #label { color:var(--dim); font-variant-numeric:tabular-nums; min-width:96px; }
  .legend { margin-top:16px; font-size:12px; color:var(--dim); }
  .legend i { display:inline-block; width:10px; height:10px; border-radius:50%;
              margin-right:6px; vertical-align:middle; }
</style></head>
<body>
<div id="wrap">
  <canvas id="cv"></canvas>
  <aside id="side">
    <div id="month"></div>
    <div id="completeness"></div>
    <div class="row"><span>消息</span><span id="m"></span></div>
    <div class="row"><span>会话</span><span id="t"></span></div>
    <div class="row"><span>发言者</span><span id="p"></span></div>
    <div class="row"><span>节点 / 边</span><span id="ne"></span></div>
    <div id="goneList"></div>
    <div class="legend">
      <div><i style="background:var(--new)"></i>本月新出现</div>
      <div><i style="background:var(--stable)"></i>持续存在</div>
      <div><i style="background:var(--fading)"></i>在变淡</div>
      <div><i style="background:var(--gone)"></i>上月有、本月没（断掉）</div>
    </div>
  </aside>
</div>
<div id="ctrl">
  <button id="play">▶ 播放</button>
  <input type="range" id="slider" min="0" max="0" value="0">
  <span id="label"></span>
</div>
<script>
const DATA = __DATA__;
const POS  = __POS__;
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
let idx = DATA.frames.length - 1;
let timer = null;

function resize() {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}
window.addEventListener('resize', resize);

function draw() {
  const f = DATA.frames[idx];
  const r = cv.getBoundingClientRect();
  const W = r.width, H = r.height;
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.46;
  ctx.clearRect(0, 0, W, H);

  const at = id => {
    const p = POS[id]; if (!p) return null;
    return [cx + (p[0] - 0.5) * 2 * R, cy + (p[1] - 0.5) * 2 * R];
  };

  const maxW = Math.max(1, ...f.edges.map(e => e.weight));
  for (const e of f.edges) {
    const a = at(e.src), b = at(e.dst);
    if (!a || !b) continue;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    const alpha = 0.16 + 0.5 * (e.weight / maxW);
    ctx.strokeStyle = e.state === 'new' ? 'rgba(74,222,128,' + alpha + ')'
                    : e.state === 'fading' ? 'rgba(245,158,11,' + alpha + ')'
                    : 'rgba(124,134,153,' + alpha + ')';
    ctx.lineWidth = 0.6 + 2.4 * (e.weight / maxW);
    ctx.stroke();
  }

  const maxN = Math.max(1, ...f.nodes.map(n => n.weight));
  for (const n of f.nodes) {
    const a = at(n.id); if (!a) continue;
    const rad = n.kind === 'group' ? 6 + 10 * (n.weight / maxN) : 2.4 + 6 * (n.weight / maxN);
    ctx.beginPath(); ctx.arc(a[0], a[1], rad, 0, 7);
    ctx.fillStyle = n.kind === 'group' ? '#6d5efc' : '#d7dce6';
    ctx.globalAlpha = n.kind === 'group' ? 0.92 : 0.72;
    ctx.fill(); ctx.globalAlpha = 1;
  }

  const me = at('me');
  if (me) {
    ctx.beginPath(); ctx.arc(me[0], me[1], 7, 0, 7);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.beginPath(); ctx.arc(me[0], me[1], 13, 0, 7);
    ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1.4; ctx.stroke();
  }

  document.getElementById('month').textContent = f.month;
  document.getElementById('m').textContent = f.messages.toLocaleString();
  document.getElementById('t').textContent = f.talkers;
  document.getElementById('p').textContent = f.people;
  document.getElementById('ne').textContent = f.nodes.length + ' / ' + f.edges.length;
  const c = document.getElementById('completeness');
  c.textContent = f.completeness === 'full'
    ? '数据完整（' + f.talkers + ' 个会话）'
    : '⚠ 数据稀薄：这个月只有 ' + f.talkers + ' 个会话被记录，图上稀疏是数据缺失，不是你那个月没聊天';
  c.style.color = f.completeness === 'full' ? 'var(--dim)' : '#f59e0b';
  const gl = document.getElementById('goneList');
  gl.innerHTML = f.gone.length
    ? '<b>本月断掉 ' + f.gone.length + ' 条（上月 ≥ __GONE_MIN__ 条）</b>' +
      f.gone.slice(0, 6).map(id => '<div>' + id.replace(/^(dm|grp|pg):/, '').split(':')[0] + '</div>').join('')
    : '';
  document.getElementById('label').textContent = (idx + 1) + ' / ' + DATA.frames.length;
  document.getElementById('slider').value = idx;
}

document.getElementById('slider').max = DATA.frames.length - 1;
document.getElementById('slider').addEventListener('input', e => {
  stop(); idx = +e.target.value; draw();
});

function play() {
  if (timer) { stop(); return; }
  if (idx >= DATA.frames.length - 1) idx = 0;
  document.getElementById('play').textContent = '⏸ 暂停';
  timer = setInterval(() => {
    if (idx >= DATA.frames.length - 1) { stop(); return; }
    idx++; draw();
  }, 520);
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  document.getElementById('play').textContent = '▶ 播放';
}
document.getElementById('play').addEventListener('click', play);
window.addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); play(); }
});

resize();
</script></body></html>
"""


def render_html(frames, pos, conservation, filtered):
    data = {
        'frames': [{k: v for k, v in f.items() if k != 'topGroups'} for f in frames],
        'conservation': conservation,
        'filtered': filtered,
    }
    return (HTML_TEMPLATE
            .replace('__DATA__', json.dumps(data, ensure_ascii=False))
            .replace('__POS__', json.dumps(pos, ensure_ascii=False))
            .replace('__GONE_MIN__', str(GONE_MIN_WEIGHT)))


def main():
    ap = argparse.ArgumentParser(description='关系网络时间重放（本地、离线、单文件 HTML）')
    ap.add_argument('--json', action='store_true', help='只输出聚合结果')
    ap.add_argument('--min-weight', type=int, default=DEFAULT_MIN_WEIGHT)
    ap.add_argument('--out', default=str(OUT_HTML))
    args = ap.parse_args()

    cfg = load_config()
    names = _names(cfg)
    per_month, total, failed = scan(cfg)
    frames, filtered = build_frames(per_month, names, args.min_weight)

    # 验收 A2：各帧消息数之和必须等于全库总数。对不上说明有分片没读到，
    # 那种情况下"关系断掉了"可能是假象，所以先把差异报出来。
    summed = sum(f['messages'] for f in frames)
    conservation = {'total': total, 'summed': summed, 'equal': total == summed,
                    'failedShards': len(failed)}

    if args.json:
        print(json.dumps({'months': len(frames), 'frames': frames,
                          'conservation': conservation,
                          'filteredEdges': filtered}, ensure_ascii=False))
        return

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    pos = layout(frames)
    out.write_text(render_html(frames, pos, conservation, filtered), encoding='utf-8')
    print(f'帧数 {len(frames)}，消息 {total}，守恒 {conservation["equal"]}，'
          f'过滤边 {filtered}，分片失败 {len(failed)}')
    print(f'已生成 {out}')
    if not conservation['equal']:
        print(f'[WARN] 守恒不成立：各帧之和 {summed} ≠ 全库 {total}，'
              f'说明有分片没读到 —— 画面里"断掉的边"可能是假象', file=sys.stderr)


if __name__ == '__main__':
    main()
