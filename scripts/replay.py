"""关系网络时间重放：按**天**推进，生成可播放的单文件 HTML。

设计见 `docs/REPLAY.md`。与第一版（按月）的区别全部来自 2026-10-25 的实际反馈：
  · **尺度改成天**（按月看不出"哪天断的"）；边用**滚动 30 天窗口**聚合，
    否则大部分天只有零星几条、边会一天出现一天消失，看起来像数据在跳；
  · **节点带名字**（群全部标，人只标前 12 个，避免标签糊成一片），鼠标悬停看全部；
  · **图例**写明颜色与大小含义；
  · **播放速度可调**（970 天：慢档约 4 分钟，极快约 12 秒）；
  · 右侧写出**断掉的关系叫什么**，不只给 id。

纯本地：不联网、不调模型。

用法：
    python scripts/replay.py                       # output/replay.html
    python scripts/replay.py --window 30 --json    # 只输出聚合结果（验收用）
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
from collections import Counter, defaultdict, deque
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from _utils import load_config, decrypt_lock  # noqa: E402
import nt_decrypt as nd  # noqa: E402

ROOT = SCRIPT_DIR.parent
OUT_HTML = ROOT / 'output' / 'replay.html'
TZ = timezone(timedelta(hours=8))

#: 边权门槛：窗口内少于这么多条就不画。
DEFAULT_MIN_WEIGHT = 3
#: 边按"过去 N 天"聚合。按天推进时必须窗口化。
DEFAULT_WINDOW = 30
#: `gone` 只报重要边：窗口内曾 ≥ 这个权重、现在掉出门槛，才算"断了"。
GONE_MIN_WEIGHT = 8
#: 会话数低于这个值的那天判为 sparse（早期只有一两个会话）。
SPARSE_TALKERS = 20


def _keys(cfg):
    return (decrypt_lock(cfg.get('ntKey', '') or ''),
            decrypt_lock(cfg.get('ntSalt', '') or ''),
            decrypt_lock(cfg.get('favPassphrase', '') or cfg.get('decryptKey', '') or ''))


def _names(cfg):
    try:
        from network import load_graph
        people, _rooms, _members = load_graph(cfg)
        return {p['username']: (p['remark'] or p['nick'] or p['username'])
                for p in people.values()}
    except Exception as exc:
        print(f'[WARN] 读联系人失败（{type(exc).__name__}），节点显示 id', file=sys.stderr)
        return {}


def scan_days(cfg):
    """按天聚合。返回 (per_day, total, failed)。"""
    db = cfg.get('ntDbPath') or ''
    if not db:
        raise SystemExit('配置里没有 ntDbPath')
    key, salt, pw = _keys(cfg)
    conns = nd.connect_message_shards(db, key, salt, pw)
    if not conns:
        raise SystemExit('打不开消息分片')

    per_day = defaultdict(lambda: {
        'messages': 0, 'talkers': set(), 'people': set(),
        'dm': Counter(), 'groups': Counter(), 'person_group': defaultdict(Counter),
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
            except Exception:
                failed.append(talker)
                continue
            is_group = talker.endswith('@chatroom')
            for ts, sender in rows:
                if not ts:
                    continue
                day = datetime.fromtimestamp(ts, tz=TZ).strftime('%Y-%m-%d')
                d = per_day[day]
                d['messages'] += 1
                total += 1
                d['talkers'].add(talker)
                who = id2name.get(sender)
                if who:
                    d['people'].add(who)
                if is_group:
                    d['groups'][talker] += 1
                    if who:
                        d['person_group'][who][talker] += 1
                elif who:
                    d['dm'][who] += 1

    for conn in conns:
        try:
            conn.close()
        except Exception:
            pass
    return per_day, total, failed


def build_frames(per_day, names, min_weight, window):
    """每天一帧，边取过去 `window` 天的累积（滑动窗口）。"""
    days = sorted(per_day)
    if not days:
        return [], 0

    win = deque()
    dm_sum = Counter()
    grp_sum = Counter()
    pg_sum = defaultdict(Counter)
    win_talkers = Counter()          # 窗口内出现过的会话 -> 天数
    prev_edges = {}
    prev2_edges = {}
    frames = []
    filtered = 0

    for day in days:
        data = per_day[day]
        win.append((day, data))
        dm_sum.update(data['dm'])
        grp_sum.update(data['groups'])
        win_talkers.update(data['talkers'])
        for who, rooms in data['person_group'].items():
            pg_sum[who].update(rooms)
        while win and (datetime.strptime(day, '%Y-%m-%d') -
                       datetime.strptime(win[0][0], '%Y-%m-%d')).days > window:
            _old_day, old = win.popleft()
            for t in old['talkers']:
                win_talkers[t] -= 1
                if win_talkers[t] <= 0:
                    win_talkers.pop(t, None)
            for k, v in old['dm'].items():
                dm_sum[k] -= v
                if dm_sum[k] <= 0:
                    dm_sum.pop(k, None)
            for k, v in old['groups'].items():
                grp_sum[k] -= v
                if grp_sum[k] <= 0:
                    grp_sum.pop(k, None)
            for who, rooms in old['person_group'].items():
                for room, v in rooms.items():
                    pg_sum[who][room] -= v
                    if pg_sum[who][room] <= 0:
                        pg_sum[who].pop(room, None)
                if not pg_sum[who]:
                    pg_sum.pop(who, None)

        edges = {}
        for who, weight in dm_sum.items():
            if weight < min_weight:
                filtered += 1
                continue
            edges['dm:' + who] = {'src': 'me', 'dst': 'p:' + who, 'kind': 'dm',
                                  'label': names.get(who, who), 'weight': weight}
        for room, weight in grp_sum.items():
            if weight < min_weight:
                filtered += 1
                continue
            edges['grp:' + room] = {'src': 'me', 'dst': 'g:' + room, 'kind': 'group',
                                    'label': names.get(room, room), 'weight': weight}
        for who, rooms in pg_sum.items():
            best = rooms.most_common(1)
            if not best:
                continue
            room, weight = best[0]
            if weight < min_weight:
                filtered += 1
                continue
            edges['pg:' + who + ':' + room] = {'src': 'p:' + who, 'dst': 'g:' + room,
                                               'kind': 'member', 'label': '', 'weight': weight}

        for eid, e in edges.items():
            if eid not in prev_edges:
                e['state'] = 'new'
            elif e['weight'] <= (prev2_edges.get(eid) or 0) * 0.5:
                e['state'] = 'fading'
            else:
                e['state'] = 'stable'

        gone = []
        for eid, w in prev_edges.items():
            if eid in edges or w < GONE_MIN_WEIGHT:
                continue
            kind, _, rest = eid.partition(':')
            if kind == 'dm':
                gone.append({'label': names.get(rest, rest), 'kind': 'dm', 'weight': w})
            elif kind == 'grp':
                gone.append({'label': names.get(rest, rest), 'kind': 'group', 'weight': w})
            else:
                who = rest.split(':')[0]
                gone.append({'label': names.get(who, who), 'kind': 'member', 'weight': w})

        nodes = {}
        for who, weight in dm_sum.items():
            nodes['p:' + who] = {'id': 'p:' + who, 'kind': 'person',
                                 'label': names.get(who, who), 'weight': weight}
        for room, weight in grp_sum.items():
            nodes['g:' + room] = {'id': 'g:' + room, 'kind': 'group',
                                  'label': names.get(room, room), 'weight': weight}
        for who, rooms in pg_sum.items():
            if 'p:' + who not in nodes:
                w = sum(rooms.values())
                if w >= min_weight:
                    nodes['p:' + who] = {'id': 'p:' + who, 'kind': 'person',
                                         'label': names.get(who, who), 'weight': w}

        top = [{'label': names.get(r, r), 'weight': w} for r, w in grp_sum.most_common(5)]

        frames.append({
            'day': day,
            'messages': data['messages'],
            'window': sum(dm_sum.values()) + sum(grp_sum.values()),
            'talkers': len(data['talkers']),
            'people': len(data['people']),
            'completeness': 'full' if len(win_talkers) >= SPARSE_TALKERS else 'sparse',
            'nodes': list(nodes.values()),
            'edges': list(edges.values()),
            'gone': gone,
            'top': top,
        })
        prev2_edges, prev_edges = prev_edges, {eid: e['weight'] for eid, e in edges.items()}

    return frames, filtered


def layout(frames):
    """确定性的"星系"布局：我在中心，群在环上，人贴在自己最常出现的群旁边。

    不跑力导向迭代：坐标每帧都动的话，播放时整个画面在抖，读者会以为数据在变。
    """
    import math
    import random

    random.seed(42)
    groups = sorted({n['id'] for f in frames for n in f['nodes'] if n['kind'] == 'group'})
    pos = {'me': (0.5, 0.5)}
    for i, g in enumerate(groups):
        a = 2 * math.pi * i / max(1, len(groups))
        pos[g] = (0.5 + 0.42 * math.cos(a), 0.5 + 0.42 * math.sin(a))

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
            r = random.uniform(0.05, 0.16)
        else:
            gx, gy = 0.5, 0.5
            a = random.uniform(0, 2 * math.pi)
            r = random.uniform(0.14, 0.33)
        pos[pid] = (min(0.97, max(0.03, gx + r * math.cos(a))),
                    min(0.97, max(0.03, gy + r * math.sin(a))))
    return pos


HTML_TEMPLATE = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>关系网络时间重放</title>
<style>
  :root { --bg:#0d1014; --card:#141a22; --fg:#e8ebf2; --dim:#8b93a3; --line:#232b38;
          --new:#4ade80; --stable:#65708a; --fading:#f59e0b; --gone:#ef4444; --group:#7c6cff; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;overflow:hidden}
  #top{height:52px;display:flex;align-items:center;gap:18px;padding:0 20px;
       border-bottom:1px solid var(--line);background:var(--card)}
  #day{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:.4px}
  #legend{display:flex;gap:14px;font-size:12px;color:var(--dim);margin-left:auto;flex-wrap:wrap}
  #legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;
            vertical-align:middle}
  #wrap{display:flex;height:calc(100vh - 52px - 78px)}
  #cv{flex:1;display:block;cursor:crosshair}
  #side{width:300px;padding:16px 18px;border-left:1px solid var(--line);
        background:var(--card);overflow:auto}
  .k{display:flex;justify-content:space-between;padding:5px 0;
     border-bottom:1px solid var(--line);font-size:13px}
  .k span:last-child{color:var(--dim);font-variant-numeric:tabular-nums}
  .sec{margin-top:14px;font-size:11px;color:var(--dim);text-transform:uppercase;
       letter-spacing:.08em}
  .item{font-size:13px;padding:3px 0;display:flex;justify-content:space-between;gap:8px}
  .item em{font-style:normal;color:var(--dim);font-variant-numeric:tabular-nums}
  .gone{color:var(--gone)}
  #warn{margin-top:10px;padding:8px 10px;border-radius:6px;background:#3a2a12;
        color:#f5c26b;font-size:12px;display:none;line-height:1.5}
  #ctrl{height:78px;display:flex;align-items:center;gap:16px;padding:0 20px;
        border-top:1px solid var(--line);background:var(--card)}
  button{background:#1d2532;color:var(--fg);border:1px solid var(--line);
         border-radius:7px;padding:8px 16px;font-size:14px;cursor:pointer}
  button:hover{background:#26303f}
  #slider{flex:1;accent-color:#4f46e5}
  select{background:#1d2532;color:var(--fg);border:1px solid var(--line);
         border-radius:7px;padding:7px 10px;font-size:13px}
  #tip{position:fixed;pointer-events:none;background:#000c;color:#fff;font-size:12px;
       padding:3px 7px;border-radius:4px;display:none;white-space:nowrap}
</style></head>
<body>
<div id="top">
  <div id="day"></div>
  <div id="legend">
    <span><i style="background:var(--new)"></i>新出现</span>
    <span><i style="background:var(--stable)"></i>持续</span>
    <span><i style="background:var(--fading)"></i>变淡</span>
    <span><i style="background:var(--gone)"></i>断掉</span>
    <span><i style="background:var(--group)"></i>群</span>
    <span><i style="background:#d7dce6"></i>人（越大越活跃）</span>
  </div>
</div>
<div id="wrap">
  <canvas id="cv"></canvas>
  <aside id="side">
    <div class="k"><b>当天消息</b><span id="m"></span></div>
    <div class="k"><b>30 天窗口互动</b><span id="w"></span></div>
    <div class="k"><b>当天会话 / 发言者</b><span id="tp"></span></div>
    <div class="k"><b>图上节点 / 边</b><span id="ne"></span></div>
    <div class="k"><b>图上门槛</b><span>≥ __MINW__ 条</span></div>
    <div id="warn"></div>
    <div class="sec">断掉的关系（窗口内曾 ≥ __GONEMIN__ 条）</div>
    <div id="goneList"></div>
    <div class="sec">窗口内最活跃的群</div>
    <div id="topList"></div>
  </aside>
</div>
<div id="ctrl">
  <button id="play">▶ 播放</button>
  <input type="range" id="slider" min="0" max="0" value="0">
  <select id="speed">
    <option value="240">慢</option>
    <option value="90" selected>中</option>
    <option value="35">快</option>
    <option value="12">极快</option>
  </select>
  <span id="label" style="color:var(--dim);min-width:110px;text-align:right"></span>
</div>
<div id="tip"></div>
<script>
const DATA = __DATA__;
const POS  = __POS__;
const F = DATA.frames;
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
let idx = F.length - 1, timer = null;

function resize(){
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  draw();
}
addEventListener('resize', resize);

function project(){
  const r = cv.getBoundingClientRect();
  const W = r.width, H = r.height, R = Math.min(W, H) * 0.44;
  return {W:W, H:H, cx:W/2, cy:H/2, R:R};
}
function at(id, P){
  const p = POS[id]; if (!p) return null;
  return [P.cx + (p[0]-0.5)*2*P.R, P.cy + (p[1]-0.5)*2*P.R];
}
const COL = {new:'74,222,128', stable:'101,112,138', fading:'245,158,11'};

function draw(){
  const f = F[idx], P = project();
  ctx.clearRect(0,0,P.W,P.H);

  const maxW = Math.max.apply(null, f.edges.map(e=>e.weight).concat([1]));
  for (let i=0;i<f.edges.length;i++){
    const e = f.edges[i];
    const a = at(e.src,P), b = at(e.dst,P);
    if (!a||!b) continue;
    const al = 0.14 + 0.55*(e.weight/maxW);
    ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]);
    ctx.strokeStyle = 'rgba(' + (COL[e.state]||COL.stable) + ',' + al + ')';
    ctx.lineWidth = 0.5 + 2.6*(e.weight/maxW);
    ctx.stroke();
  }

  const maxN = Math.max.apply(null, f.nodes.map(n=>n.weight).concat([1]));
  const ranked = f.nodes.slice().sort((a,b)=>b.weight-a.weight);

  // 标签避让：按权重降序尝试放置，与已放标签的矩形重叠就跳过。
  // 不这样做的话，图上 30 多个群名会互相盖住（2026-10-25 实测反馈："太拥挤了"）。
  const boxes = [];
  function place(label, x, y, color, font){
    ctx.font = font;
    const w = ctx.measureText(label).width, h = 15;
    const cands = [[x, y - h/2], [x - w, y - h/2], [x - w/2, y - h - 4], [x - w/2, y + 4]];
    for (const c of cands){
      const box = {x:c[0], y:c[1], w:w, h:h};
      let hit = false;
      for (const b of boxes){
        if (box.x < b.x + b.w && box.x + box.w > b.x &&
            box.y < b.y + b.h && box.y + box.h > b.y){ hit = true; break; }
      }
      if (hit) continue;
      boxes.push(box);
      ctx.textAlign='left'; ctx.textBaseline='top';
      ctx.lineWidth = 3; ctx.strokeStyle='rgba(13,16,20,.9)';
      ctx.strokeText(label, box.x, box.y);
      ctx.fillStyle = color; ctx.fillText(label, box.x, box.y);
      return true;
    }
    return false;
  }

  // 群名太长会把整张图盖住：超过 14 字截断；没有真名的群（`xxx@chatroom`）不标，靠悬停。
  const shortName = s => {
    if (/@chatroom$/i.test(s) || /^\d+$/.test(s)) return '';
    return s.length > 14 ? s.slice(0, 14) + '…' : s;
  };

  const groupFont = '600 12px -apple-system,"Microsoft YaHei",sans-serif';
  const personFont = '11px -apple-system,"Microsoft YaHei",sans-serif';
  let personLabels = 0;
  for (const n of ranked){
    if (n.kind === 'group'){
      const nm = shortName(n.label);
      if (!nm) continue;
      const a = at(n.id,P); if (!a) continue;
      const rad = 6+11*(n.weight/maxN);
      place(nm, a[0]+rad+4, a[1], '#c9c2ff', groupFont);
    } else if (personLabels < 8){
      const nm = shortName(n.label);
      if (!nm) continue;
      const a = at(n.id,P); if (!a) continue;
      const rad = 2.5+6*(n.weight/maxN);
      if (place(nm, a[0]+rad+4, a[1], '#9aa3b5', personFont)) personLabels++;
    }
  }

  for (const n of f.nodes){
    const a = at(n.id,P); if (!a) continue;
    const rad = n.kind==='group' ? 6+11*(n.weight/maxN) : 2.5+6*(n.weight/maxN);
    ctx.beginPath(); ctx.arc(a[0],a[1],rad,0,7);
    ctx.fillStyle = n.kind==='group' ? '#7c6cff' : '#d7dce6';
    ctx.globalAlpha = n.kind==='group' ? 0.95 : 0.7;
    ctx.fill(); ctx.globalAlpha = 1;
  }

  const me = at('me',P);
  if (me){
    ctx.beginPath(); ctx.arc(me[0],me[1],7,0,7); ctx.fillStyle='#fff'; ctx.fill();
    ctx.beginPath(); ctx.arc(me[0],me[1],14,0,7);
    ctx.strokeStyle='rgba(255,255,255,.3)'; ctx.lineWidth=1.5; ctx.stroke();
    ctx.font='600 12px sans-serif'; ctx.textAlign='left'; ctx.textBaseline='middle';
    ctx.lineWidth=3; ctx.strokeStyle='rgba(13,16,20,.85)';
    ctx.strokeText('我', me[0]+11, me[1]); ctx.fillStyle='#fff';
    ctx.fillText('我', me[0]+11, me[1]);
  }

  document.getElementById('day').textContent = f.day;
  document.getElementById('m').textContent = f.messages.toLocaleString();
  document.getElementById('w').textContent = f.window.toLocaleString();
  document.getElementById('tp').textContent = f.talkers + ' / ' + f.people;
  document.getElementById('ne').textContent = f.nodes.length + ' / ' + f.edges.length;
  document.getElementById('label').textContent = (idx+1) + ' / ' + F.length;
  document.getElementById('slider').value = idx;

  const warn = document.getElementById('warn');
  if (f.completeness === 'sparse'){
    warn.style.display = 'block';
    warn.textContent = '⚠ 这天只有 ' + f.talkers + ' 个会话被记录。图上稀疏是数据缺失，不是那天没聊天。';
  } else { warn.style.display = 'none'; }

  const gl = document.getElementById('goneList');
  if (f.gone.length){
    gl.innerHTML = f.gone.slice(0,10).map(g=>'<div class="item gone"><span>'+g.label+'</span><em>'+g.weight+'</em></div>').join('');
  } else {
    gl.innerHTML = '<div class="item"><span style="color:var(--dim)">无</span></div>';
  }
  document.getElementById('topList').innerHTML =
    f.top.map(t=>'<div class="item"><span>'+t.label+'</span><em>'+t.weight+'</em></div>').join('');
}

addEventListener('mousemove', function(ev){
  if (!F.length) return;
  const r = cv.getBoundingClientRect();
  const x = ev.clientX - r.left, y = ev.clientY - r.top, P = project();
  let best = null, bd = 196;
  for (const n of F[idx].nodes){
    const a = at(n.id,P); if (!a) continue;
    const d = (a[0]-x)*(a[0]-x) + (a[1]-y)*(a[1]-y);
    if (d < bd){ bd = d; best = n; }
  }
  const tip = document.getElementById('tip');
  if (best){
    tip.style.display = 'block';
    tip.style.left = (ev.clientX + 12) + 'px';
    tip.style.top = (ev.clientY + 12) + 'px';
    tip.textContent = best.label + ' · ' + best.weight + ' 条';
  } else { tip.style.display = 'none'; }
});

document.getElementById('slider').max = F.length - 1;
document.getElementById('slider').addEventListener('input', function(e){
  stop(); idx = +e.target.value; draw();
});
function speed(){ return +document.getElementById('speed').value; }
function play(){
  if (timer){ stop(); return; }
  if (idx >= F.length - 1) idx = 0;
  document.getElementById('play').textContent = '⏸ 暂停';
  timer = setInterval(function(){
    if (idx >= F.length - 1){ stop(); return; }
    idx++; draw();
  }, speed());
}
function stop(){
  if (timer){ clearInterval(timer); timer = null; }
  document.getElementById('play').textContent = '▶ 播放';
}
document.getElementById('play').addEventListener('click', play);
document.getElementById('speed').addEventListener('change', function(){
  if (timer){ stop(); play(); }
});
addEventListener('keydown', function(e){
  if (e.code === 'Space'){ e.preventDefault(); play(); }
  if (e.code === 'ArrowRight'){ stop(); idx = Math.min(F.length-1, idx+1); draw(); }
  if (e.code === 'ArrowLeft'){ stop(); idx = Math.max(0, idx-1); draw(); }
});

resize();
</script></body></html>
"""


def render_html(frames, pos, conservation, filtered, min_weight):
    data = {'frames': frames, 'conservation': conservation, 'filtered': filtered}
    return (HTML_TEMPLATE
            .replace('__DATA__', json.dumps(data, ensure_ascii=False))
            .replace('__POS__', json.dumps(pos, ensure_ascii=False))
            .replace('__MINW__', str(min_weight))
            .replace('__GONEMIN__', str(GONE_MIN_WEIGHT)))


def main():
    ap = argparse.ArgumentParser(description='关系网络时间重放（按天，单文件 HTML）')
    ap.add_argument('--json', action='store_true', help='只输出聚合结果')
    ap.add_argument('--min-weight', type=int, default=DEFAULT_MIN_WEIGHT)
    ap.add_argument('--window', type=int, default=DEFAULT_WINDOW, help='边的滚动窗口天数')
    ap.add_argument('--out', default=str(OUT_HTML))
    args = ap.parse_args()

    cfg = load_config()
    names = _names(cfg)
    per_day, total, failed = scan_days(cfg)
    frames, filtered = build_frames(per_day, names, args.min_weight, args.window)

    summed = sum(f['messages'] for f in frames)
    conservation = {'total': total, 'summed': summed, 'equal': total == summed,
                    'failedShards': len(failed), 'days': len(frames)}

    if args.json:
        print(json.dumps({'days': len(frames), 'frames': frames,
                          'conservation': conservation, 'filteredEdges': filtered},
                         ensure_ascii=False))
        return

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_html(frames, layout(frames), conservation, filtered, args.min_weight),
                   encoding='utf-8')
    print(f'天数 {len(frames)}，消息 {total}，守恒 {conservation["equal"]}，'
          f'过滤边 {filtered}，分片失败 {len(failed)}')
    print(f'已生成 {out}（{out.stat().st_size/1024/1024:.1f} MB）')
    if not conservation['equal']:
        print(f'[WARN] 守恒不成立：各帧之和 {summed} ≠ 全库 {total}，'
              f'画面里"断掉的边"可能是假象', file=sys.stderr)


if __name__ == '__main__':
    main()
