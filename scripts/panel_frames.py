# -*- coding: utf-8 -*-
"""悬浮宠物"被拎起来"动作帧的生成、归一化与几何校验。

现有那套出图参数此前只写在 `resources/panel/panel.css` 的注释里（内容框、0.98R、
圆外实心 0），没有可执行的东西 —— 每次换素材都靠人眼比，而人眼看不出的错
（差 1 像素的错位、超圆的 4 个像素）是这里最容易翻的车。这个脚本把它变成可复跑的。

子命令：
  --gen        调生图模型出原始帧（需要 requests + IMAGE_API_KEY + IMAGE_API_BASE）
  --normalize  把原始帧归一化到契约上（需要 Pillow 做重采样）
  --check      校验成品帧是否落在契约里。**只用标准库**，因为测试会跑它

口径（必须与 `test/panel-frames.test.ts` 一致，两处漂了就会各说各话）：

  画布 256x256、8 位 RGBA、非隔行。
  "实心" = **alpha >= 128**（不是 alpha > 0）。这条是踩出来的：用 alpha>=1 会把描边的
  极淡锯齿也算进轮廓，于是同一张图量出 125.88、看着像"超了 4 个像素"，而按 alpha>=128
  量是 125.25 —— 后者才是 panel.css 记的那个 125.2。
  距离从**画布中心 (128,128)** 量（不是内容 bbox 中心；从 bbox 中心量是另一个数 124.16，
  两个口径混着用就会得出相反的结论）。
  上限 0.98 x 128 = 125.44，现有素材实测 125.25 —— 余下那 2% 的半径预算归悬停的
  `scale(1.02)`（125.25 x 1.02 = 127.76 < 128，正好不出圆）。

  动作帧另加两条：**逐帧收小**（s 见 SCALES，拎到最高点最小），以及**头顶锚定**
  （最上面那行实心像素的 y 与静止帧对齐）——被拎住的是后颈，身体缩小是往下坠的，
  锚点跟着跑就会看成"整只猫在飘"。

输出一律纯 ASCII：本机 Python 在 GBK 控制台上打非 ASCII 会崩（仓库已有记录）。
"""
import argparse
import base64
import json
import math
import os
import sys
import time
import zlib

CANVAS = 256
ALPHA_SOLID = 128
CAP = 0.98 * (CANVAS / 2.0)            # 125.44
BASE_EXTENT = 125.25                   # 现有静止帧实测的半径占用
BASE = 'mascot-base.png'
MODEL = 'gpt-image-2-ca'
PNG_DIR = os.path.join('resources', 'panel')
RAW_DIR = os.path.join('output', 'mascot-lift', 'raw')

# 文件名 -> (相对静止帧的缩放, 姿势)
#
# 12 帧：6 帧拎起来 + 6 帧落回去（再加静止帧，共 13 个状态）。缩放不是线性的，走的是一条
# 缓入缓出的弧线 —— 起步慢、中段快、接近悬空时收敛，看着才像被"提"起来而不是匀速缩放。
#
# 姿势全部**收敛**写：只让四肢与表情动，不许改轮廓。第一版把"被拎起来"写得太用力，模型
# 于是把猫画成了尖顶斗篷 + 细长身子（实测猫的 bbox 长宽比从 0.794 掉到 0.650，差 18%），
# 耳朵也一起没了 —— 那已经不是同一只猫，贴上球也不再是"那颗球"。
SCALES = [
    ('mascot-lift-up-1.png', 0.992, 'eyes wide and startled, the two cat ears pricked up, front paws '
     'just beginning to lift off the ground'),
    ('mascot-lift-up-2.png', 0.980, 'the two cat ears still upright, front paws off the ground, head '
     'tilted slightly up, body still round'),
    ('mascot-lift-up-3.png', 0.965, 'front paws hanging loose, hind paws curling under the body, the two '
     'cat ears tilting back but clearly still two ears'),
    ('mascot-lift-up-4.png', 0.948, 'body clearly lifted with all four paws off the ground, the two cat '
     'ears pressed further back, eyes wide'),
    ('mascot-lift-up-5.png', 0.933, 'hanging with the front paws straight down, the two cat ears almost '
     'flat, eyes wide, small mouth'),
    ('mascot-lift-up-6.png', 0.920, 'held up at the highest point by the scruff, front paws dangling '
     'straight down, hind paws tucked, the two cat ears pressed back but still clearly TWO triangular '
     'ears, tiny round mouth, and the hood still perfectly round like a ball'),
    ('mascot-lift-down-1.png', 0.928, 'still hanging but the two cat ears starting to lift back up, eyes wide'),
    ('mascot-lift-down-2.png', 0.940, 'front paws reaching slightly downward as the body starts to come '
     'down, the two cat ears half back, the body keeps exactly the same width and height as the reference image, only the limbs move'),
    ('mascot-lift-down-3.png', 0.955, 'body descending, hind paws reaching for the ground, the two cat '
     'ears coming back up, the body keeps exactly the same width and height as the reference image, only the limbs move'),
    ('mascot-lift-down-4.png', 0.968, 'nearly landed, paws touching the ground, the two cat ears back to normal'),
    ('mascot-lift-down-5.png', 0.982, 'just landed, body back to its normal round shape with no squash at '
     'all, eyes wide, the body keeps exactly the same width and height as the reference image, only the limbs move'),
    ('mascot-lift-down-6.png', 0.992, 'almost back to the resting pose, eyes still a little wide'),
]
# 挠痒痒那一族：4 张姿势帧，**缩放固定 1.0** —— 扭动不该让球变大变小（与"被拎起来"那套的
# 逐帧收小正相反）。它们只负责表情与爪子的小动作；倾斜由渲染进程的程序化旋转负责。
TICKLE_SCALE = 0.985   # 留一点点余量：静止帧已经用掉 125.25/125.44，
                       # 同尺寸的姿势帧只要稍宽一点就会顶出圆（实测 tickle-2 就是这样），
                       # 而回退缩放会让它在循环里比别的帧小一圈、看得出跳。
TICKLE = [
    ('mascot-tickle-1.png', 'eyes squeezed shut in a giggle, one front paw raised as if warding the '
     'tickle off, the two cat ears flicked slightly outward'),
    ('mascot-tickle-2.png', 'mouth open laughing, front paws pulled in close to the chest, the two cat '
     'ears tilted back a little'),
    ('mascot-tickle-3.png', 'eyes squeezed shut with a small tongue sticking out, one paw up near the '
     'cheek, the two cat ears flicked outward'),
    ('mascot-tickle-4.png', 'a big open laugh, both front paws up, the two cat ears flicked back'),
]



# "偶尔眨一下眼"那 2 帧：半闭 -> 闭。**缩放固定 1.0**（眨眼不该改大小）。
# 收回来之后要**只把眼睛那块贴回静止帧**（见 README/脚本里的 normalize_blink），因为生图模型
# 会把整张脸重画一遍，那点像素差在动画里就是"整颗球闪一下"。
BLINK = [
    ('mascot-blink-1.png', 'eyes half closed, mid blink, everything else in the drawing identical to the reference'),
    ('mascot-blink-2.png', 'eyes fully closed, a calm contented expression, everything else in the drawing '
     'identical to the reference'),
]


def all_frames():
    """两族帧合起来：被拎起来那套（有序、逐帧收小）+ 挠痒痒那族（同尺寸）。"""
    return (list(SCALES) + [(n, TICKLE_SCALE, p) for n, p in TICKLE]
            + [(n, 1.0, p) for n, p in BLINK])


FRAME_FILES = [f for f, _, _ in SCALES]
TICKLE_FILES = [f for f, _ in TICKLE]

BLINK_FILES = [f for f, _ in BLINK]
REFERENCE_FILES = [BASE, 'mascot-happy.png', 'mascot-sorry.png', 'mascot-tired.png']

# 不变式：每帧都带同样这段话，只换姿势那一句。生图模型最容易"顺手"改的就是比例与构图。
INVARIANT = (
    'Keep the character exactly as it is: same style, same palette, same line weight, same facing '
    'direction, same proportions of face and body. Same camera, same distance -- do NOT change the '
    'overall size of the character or where it sits in the frame, except for the pose described. '
    'THE SILHOUETTE MUST STAY ROUND AND BALL-LIKE, exactly as round as in the reference image: do '
    'not turn the hood into a pointed hat, a cone or a triangle, and do not stretch the body into '
    'a long column. Keep BOTH triangular cat ears clearly visible on top of the head, same size and '
    'same place as in the reference. Keep the body wide and round; only the limbs and the face may '
    'move. Keep the whole character comfortably inside a centred circle, well away from every edge. '
    'Transparent background. No shadow, no glow, no floor, no ground, no props, no text, no border. '
    'Whole body visible. Not sad, not worried, not angry, not sleepy, no tears.'
)


# ---------------------------------------------------------------- PNG 解码（标准库）

def decode_png(path):
    """最小 PNG 解码：只处理 8 位 RGBA、非隔行。返回 (w, h, bytearray)。"""
    with open(path, 'rb') as fh:
        b = fh.read()
    if b[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('not a PNG: %s' % path)
    w = int.from_bytes(b[16:20], 'big')
    h = int.from_bytes(b[20:24], 'big')
    depth, ctype = b[24], b[25]
    if depth != 8 or ctype != 6:
        # 生图通道会返回 RGB（ctype=2）。那不是"透明底没抠干净"，是格式不对：
        # 这里替它补一个 alpha 就等于把整张图当成实心方块，必须让它重出。
        raise ValueError('need 8-bit RGBA, got depth=%d ctype=%d: %s' % (depth, ctype, path))
    idat = []
    off = 8
    while off < len(b):
        ln = int.from_bytes(b[off:off + 4], 'big')
        if b[off + 4:off + 8] == b'IDAT':
            idat.append(b[off + 8:off + 8 + ln])
        off += 12 + ln
    raw = zlib.decompress(b''.join(idat))
    stride = w * 4
    out = bytearray(h * stride)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        ft = raw[pos]
        pos += 1
        cur = bytearray(raw[pos:pos + stride])
        pos += stride
        if ft == 1:
            for x in range(4, stride):
                cur[x] = (cur[x] + cur[x - 4]) & 255
        elif ft == 2:
            for x in range(stride):
                cur[x] = (cur[x] + prev[x]) & 255
        elif ft == 3:
            for x in range(stride):
                a = cur[x - 4] if x >= 4 else 0
                cur[x] = (cur[x] + ((a + prev[x]) >> 1)) & 255
        elif ft == 4:
            for x in range(stride):
                a = cur[x - 4] if x >= 4 else 0
                up = prev[x]
                c = prev[x - 4] if x >= 4 else 0
                p = a + up - c
                pa, pb, pc = abs(p - a), abs(p - up), abs(p - c)
                cur[x] = (cur[x] + (a if (pa <= pb and pa <= pc) else (up if pb <= pc else c))) & 255
        elif ft != 0:
            raise ValueError('bad PNG filter %d in %s' % (ft, path))
        out[y * stride:(y + 1) * stride] = cur
        prev = cur
    return w, h, out


def metrics(path):
    """量一张帧。距离一律从**画布中心**量，实心一律 alpha>=128。"""
    w, h, buf = decode_png(path)
    solid = []
    for y in range(h):
        base = y * w * 4
        for x in range(w):
            if buf[base + x * 4 + 3] >= ALPHA_SOLID:
                solid.append((x, y))
    if not solid:
        return None
    minx = min(p[0] for p in solid)
    maxx = max(p[0] for p in solid)
    miny = min(p[1] for p in solid)
    maxy = max(p[1] for p in solid)
    rows = {}
    for x, y in solid:
        rows[y] = rows.get(y, 0) + 1
    apex_y = min(y for y, n in rows.items() if n >= 4)
    cx, cy = CANVAS / 2.0, CANVAS / 2.0
    maxd = 0.0
    over_cap = 0
    over_circle = 0
    for x, y in solid:
        d = math.hypot(x - cx, y - cy)
        if d > maxd:
            maxd = d
        if d > CAP:
            over_cap += 1
        if d > CANVAS / 2.0:
            over_circle += 1
    return {
        'file': os.path.basename(path), 'w': w, 'h': h, 'opaque': len(solid),
        'bbox_w': maxx - minx + 1, 'bbox_h': maxy - miny + 1,
        'x': minx, 'y': miny, 'cx': (minx + maxx) / 2.0, 'apex_y': apex_y,
        'maxd': maxd, 'over_cap': over_cap, 'over_circle': over_circle,
    }


def describe(m):
    return ('%-24s %dx%d solid=%-6d bbox=%dx%d at=%d,%d apex=%d maxDist=%.2f >cap=%d >R=%d' % (
        m['file'], m['w'], m['h'], m['opaque'], m['bbox_w'], m['bbox_h'],
        m['x'], m['y'], m['apex_y'], m['maxd'], m['over_cap'], m['over_circle']))


def expected_scale(name):
    for f, s, _ in SCALES:
        if f == name:
            return s
    return None


ASPECT_DRIFT_TOL = 0.06        # 猫的长宽比相对静止帧允许漂多少（生成期闸门是 4%，这里留余量）
CAT_W_TOL = 4                 # 猫的 bbox 宽相对目标允许差几个像素


def problems(m, cat, ref_cat, target_cat_w):
    """契约检查。cat/ref_cat 为 None 时跳过"猫"那两条。返回挑错清单（空 = 通过）。"""
    if m is None:
        return ['empty image (no solid pixel)']
    bad = []
    if m['w'] != CANVAS or m['h'] != CANVAS:
        bad.append('canvas %dx%d != %dx%d' % (m['w'], m['h'], CANVAS, CANVAS))
    if m['maxd'] > CAP:
        bad.append('maxDist %.2f > cap %.2f' % (m['maxd'], CAP))
    if m['over_circle']:
        bad.append('%d solid pixel(s) outside r=%d -- the ball would lose a chunk'
                   % (m['over_circle'], CANVAS // 2))
    if m['opaque'] < 1000:
        bad.append('only %d solid pixels (suspiciously empty)' % m['opaque'])
    if cat is not None and ref_cat is not None and target_cat_w is not None:
        if abs(cat['w'] - target_cat_w) > CAT_W_TOL:
            bad.append('cat width %d not near the target %.1f (+- %d) -- the scale is off'
                       % (cat['w'], target_cat_w, CAT_W_TOL))
        drift = cat['aspect'] / ref_cat['aspect'] - 1.0
        if abs(drift) > ASPECT_DRIFT_TOL:
            bad.append('cat aspect drifted %+.1f%% from the resting frame (limit +-%.0f%%)'
                       % (drift * 100, ASPECT_DRIFT_TOL * 100))
    return bad


def cmd_check(panel_dir, sample, include_reference):
    base_path = os.path.join(panel_dir, BASE)
    try:
        baseline = metrics(base_path)
        ref_cat = main_component(base_path)
    except (OSError, ValueError) as exc:
        print('cannot read the baseline %s: %s' % (BASE, exc))
        return 1
    print('baseline %s: apex=%d cx=%.1f maxDist=%.2f cat=%dx%d aspect=%.3f' % (
        BASE, baseline['apex_y'], baseline['cx'], baseline['maxd'],
        ref_cat['w'], ref_cat['h'], ref_cat['aspect']))
    targets = []
    if include_reference:
        targets += [os.path.join(panel_dir, f) for f in REFERENCE_FILES]
    targets += [os.path.join(panel_dir, f) for f in FRAME_FILES]
    targets += [os.path.join(panel_dir, f) for f in TICKLE_FILES]

    targets += [os.path.join(panel_dir, f) for f in BLINK_FILES]
    if sample:
        targets = targets[:sample]
    failed = 0
    for p in targets:
        name = os.path.basename(p)
        if not os.path.exists(p):
            print('MISSING  %s' % name)
            failed += 1
            continue
        try:
            m = metrics(p)
            cat = main_component(p)
        except ValueError as exc:
            print('BAD      %s (%s)' % (name, exc))
            failed += 1
            continue
        s = expected_scale(name)
        target_w = None if s is None else ref_cat['w'] * s
        bad = problems(m, cat if s is not None else None, ref_cat, target_w)
        if s is not None:
            if abs(m['apex_y'] - baseline['apex_y']) > 2:
                bad.append('apex y %d drifts from the baseline %d by more than 2px'
                           % (m['apex_y'], baseline['apex_y']))
            if abs(m['cx'] - baseline['cx']) > 2:
                bad.append('horizontal centre %.1f drifts from the baseline %.1f'
                           % (m['cx'], baseline['cx']))
        print(('OK       ' if not bad else 'FAIL     ') + describe(m) +
              ('' if cat is None else ' cat=%dx%d aspect=%.3f' % (cat['w'], cat['h'], cat['aspect'])))
        for b in bad:
            print('           - %s' % b)
            failed += 1
    print('%d problem(s)' % failed)
    return 1 if failed else 0


def cmd_gen(only):
    try:
        import requests
    except ImportError:
        print('requests is required for --gen (pip install requests)')
        return 2
    key = os.environ.get('IMAGE_API_KEY')
    base_url = os.environ.get('IMAGE_API_BASE')
    if not key or not base_url:
        print('set IMAGE_API_KEY and IMAGE_API_BASE (no default is committed on purpose)')
        return 2
    src = os.path.join(PNG_DIR, 'mascot.png')
    if not os.path.exists(src):
        print('missing the generation base: %s' % src)
        return 2
    if not os.path.isdir(RAW_DIR):
        os.makedirs(RAW_DIR)
    url = base_url.rstrip('/') + '/images/edits'
    rc = 0
    for name, _scale, pose in all_frames():
        if only and name not in only:
            continue
        out = os.path.join(RAW_DIR, name)
        if os.path.exists(out):
            print('SKIP     %s (already generated)' % name)
            continue
        prompt = INVARIANT + ' Pose: ' + pose + '.'
        started = time.time()
        print('GEN      %s ...' % name, end='')
        sys.stdout.flush()
        try:
            with open(src, 'rb') as fh:
                resp = requests.post(
                    url,
                    headers={'Authorization': 'Bearer ' + key,
                             # 这条通道按 UA 拦截：不带正常 UA 会 403，别把 403 读成"没权限"
                             'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                                           'AppleWebKit/537.36 (KHTML, like Gecko) '
                                           'Chrome/131.0.0.0 Safari/537.36'},
                    files={'image': ('mascot.png', fh, 'image/png')},
                    data={'model': MODEL, 'prompt': prompt, 'n': '1'},
                    timeout=1800,
                )
        except Exception as exc:                       # noqa: BLE001 - 网络层什么都可能抛
            print(' request failed: %s' % (type(exc).__name__,))
            rc = 1
            continue
        mins = (time.time() - started) / 60.0
        if resp.status_code != 200:
            print(' HTTP %d after %.1f min: %s' % (resp.status_code, mins, resp.text[:200]))
            rc = 1
            continue
        try:
            payload = resp.json()
            item = (payload.get('data') or [{}])[0]
        except ValueError:
            print(' unparsable body after %.1f min' % mins)
            rc = 1
            continue
        blob = None
        if item.get('b64_json'):
            blob = base64.b64decode(item['b64_json'])
        elif item.get('url'):
            got = requests.get(item['url'], timeout=300,
                               headers={'User-Agent': 'Mozilla/5.0'})
            if got.status_code == 200:
                blob = got.content
        if not blob:
            print(' no image in the response after %.1f min: %s' % (mins, json.dumps(item)[:160]))
            rc = 1
            continue
        with open(out, 'wb') as fh:
            fh.write(blob)
        # 只报格式与尺寸，不用 Pillow：raw 是"待归一化"的，这一步只确认拿到了东西
        head = open(out, 'rb').read(26)
        fmt = 'png' if head[:8] == b'\x89PNG\r\n\x1a\n' else 'not-png'
        dims = ''
        if fmt == 'png':
            dims = '%dx%d depth=%d ctype=%d' % (int.from_bytes(head[16:20], 'big'),
                                                int.from_bytes(head[20:24], 'big'),
                                                head[24], head[25])
        print(' ok in %.1f min -> %s (%s %s)' % (mins, out, fmt, dims))
    return rc


# ---------------------------------------------------------------- 归一化

def blink_band(panel_dir):
    """眨眼带：虹膜层的不透明范围 + 一圈余量。用它把生成的眨眼帧"只取眼睛那块"。"""
    w, h, buf = decode_png(os.path.join(panel_dir, 'mascot-iris.png'))
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            if buf[(y * w + x) * 4 + 3] >= 8:
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    # 余量取得不大：带子越大，把生成帧"顺手重画"的部分带进来的越多（那正是要避免的）
    return (max(0, min(xs) - 15), max(0, min(ys) - 12), min(w, max(xs) + 16), min(h, max(ys) + 13))


def composite_blink(blink_path, base_path, band):
    """把眨眼帧的眼睛带贴到静止帧的副本上，写回 blink_path。返回带外不同的像素数（必须是 0）。"""
    from PIL import Image
    band_img = Image.open(blink_path).convert('RGBA')
    base = Image.open(base_path).convert('RGBA')
    patch = band_img.crop(band)
    base.paste(patch, (band[0], band[1]), patch)
    base.save(blink_path)
    a = Image.open(blink_path).convert('RGBA')
    b = Image.open(base_path).convert('RGBA')
    pa, pb = a.load(), b.load()
    outside = 0
    for y in range(a.size[1]):
        if band[1] <= y < band[3]:
            continue
        for x in range(a.size[0]):
            if pa[x, y] != pb[x, y]:
                outside += 1
    for y in range(band[1], band[3]):
        for x in range(a.size[0]):
            if not (band[0] <= x < band[2]) and pa[x, y] != pb[x, y]:
                outside += 1
    return outside


def cmd_normalize(panel_dir, raw_dir):
    """按**猫自己**（最大连通域）的 bbox 宽缩放，头顶对齐静止帧，水平居中。

    缩放基准是猫的宽度而不是整张内容：画布上还有旁白气泡与惊叹号，按整张缩放会让装饰件
    决定角色的比例，逐帧就跳。但**硬契约优先** —— 某帧整体更宽时，按猫宽缩放会把整张内容
    顶出圆（实测 down-5 的 maxDist 到过 127.88，上限 125.44）。那种情况就**回退这一帧的
    缩放**直到不出圆；猫宽那 ±4 的余量足够吸收（实测回退约 2%）。宁可让这一帧比设计值小一点点，
    也不能让球被圆裁掉一块 —— 后者是看得见的坏。
    """
    try:
        from PIL import Image
    except ImportError:
        print('Pillow is required for --normalize (pip install pillow); '
              '--check needs only the stdlib')
        return 2
    base_path = os.path.join(panel_dir, BASE)
    baseline = metrics(base_path)          # 静止帧不进归一化，只当锚点与比例基准
    ref_cat = main_component(base_path)
    if ref_cat is None:
        print('cannot measure the resting cat')
        return 1
    rc = 0
    for name, scale, _pose in all_frames():
        raw = os.path.join(raw_dir, name)
        if not os.path.exists(raw):
            print('MISSING  %s (run --gen first)' % raw)
            rc = 1
            continue
        cat = main_component(raw)
        if cat is None:
            print('EMPTY    %s' % name)
            rc = 1
            continue
        target_w = ref_cat['w'] * scale
        im = Image.open(raw).convert('RGBA')
        alpha = im.getchannel('A').point(lambda v: 255 if v >= ALPHA_SOLID else 0)
        box = alpha.getbbox()
        if box is None:
            print('EMPTY    %s' % name)
            rc = 1
            continue
        crop = im.crop(box)
        k = target_w / float(cat['w'])        # 猫是内容的一部分，所以同一个 k 也缩放了猫
        out = os.path.join(panel_dir, name)
        m2 = None
        for attempt in range(10):
            new_w = max(1, int(round(crop.width * k)))
            new_h = max(1, int(round(crop.height * k)))
            resized = crop.resize((new_w, new_h), Image.LANCZOS)
            canvas = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
            apex_row = _apex_row(resized)
            left = int(round(CANVAS / 2.0 - new_w / 2.0))
            top = int(round(baseline['apex_y'] - apex_row))
            canvas.paste(resized, (left, top), resized)
            canvas.save(out)
            m2 = metrics(out)
            if m2 is None or m2['maxd'] <= CAP - 0.2:
                break
            if attempt == 5:
                break
            print('  note: %s would exceed the cap (maxDist %.2f) -- backing the scale off'
                  % (name, m2['maxd']))
            # 固定比例回退（用 maxDist 反推时收敛太慢：实测每步只掉 0.6%）
            k *= 0.94
        if name in BLINK_FILES:
            # 眨眼帧只取眼睛那块，其余用静止帧（见 composite_blink 的说明）
            band = blink_band(panel_dir)
            if band is None:
                print('  note: cannot find the eye band; leaving %s as generated' % name)
            else:
                stray = composite_blink(out, base_path, band)
                print('  note: %s -> eye band %s, %d pixel(s) differ outside it' % (name, band, stray))
                if stray:
                    print('  !! %s 的眼睛带之外动了 %d 个像素 —— 那会让整颗球闪一下' % (name, stray))

        cat2 = main_component(out)
        bad = problems(m2, cat2, ref_cat, target_w)
        if m2 is not None:
            if abs(m2['apex_y'] - baseline['apex_y']) > 2:
                bad.append('apex y %d vs baseline %d' % (m2['apex_y'], baseline['apex_y']))
            if abs(m2['cx'] - baseline['cx']) > 2:
                bad.append('centre x %.1f vs baseline %.1f' % (m2['cx'], baseline['cx']))
        print(('OK       ' if not bad else 'FAIL     ') + describe(m2) +
              ('' if cat2 is None else ' cat=%dx%d aspect=%.3f' % (cat2['w'], cat2['h'], cat2['aspect'])))
        for b in bad:
            print('           - %s' % b)
            rc = 1
    return rc


def _apex_row(img):
    """最上面那行"实心像素 >= 4"的相对 y（抗单像素噪点）。"""
    w, h = img.size
    px = img.load()
    for y in range(h):
        n = 0
        for x in range(w):
            if px[x, y][3] >= ALPHA_SOLID:
                n += 1
                if n >= 4:
                    return y
    return 0


# ---------------------------------------------------------------- 轮廓漂移闸门

# 生图模型每帧独立出图，最容易翻的车是**悄悄改了轮廓**：第一版里"被拎起"写成尖顶斗篷、
# 耳朵也没了，肉眼看还觉得"挺可爱"，而猫的 bbox 长宽比已经掉到 0.650（静止帧 0.794）。
# 那种帧贴到球上就不再是同一只猫，而所有几何断言照样全绿（它确实在圆里）。
# 所以这里按**最大连通域**（= 猫本身，不含旁白气泡与惊叹号）的长宽比设一道闸门。
ASPECT_TOL = 0.04          # 与静止帧相比，猫的长宽比允许漂移多少


def main_component(path):
    """最大连通域（4 邻域）的 bbox 与长宽比。按行扫描 + 并查集：1254^2 也很快。"""
    w, h, buf = decode_png(path)
    parent = []

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    runs = []          # 每行: [ (x0,x1,idx), ... ]
    stats = []         # 每个 run 所属集合的累计 (area, minx, maxx, miny, maxy)
    for y in range(h):
        base = y * w * 4
        row = []
        x = 0
        while x < w:
            if buf[base + x * 4 + 3] >= ALPHA_SOLID:
                x0 = x
                while x < w and buf[base + x * 4 + 3] >= ALPHA_SOLID:
                    x += 1
                idx = len(parent)
                parent.append(idx)
                stats.append([x - x0, x0, x - 1, y, y])
                for px0, px1, pidx in (runs[-1] if runs else []):
                    if px1 >= x0 and px0 <= x - 1:
                        union(idx, pidx)
                row.append((x0, x - 1, idx))
            else:
                x += 1
        runs.append(row)
    best = None
    for idx in range(len(parent)):
        root = find(idx)
        if root == idx:
            continue
        t = stats[root]
        c = stats[idx]
        t[0] += c[0]
        if c[1] < t[1]: t[1] = c[1]
        if c[2] > t[2]: t[2] = c[2]
        if c[3] < t[3]: t[3] = c[3]
        if c[4] > t[4]: t[4] = c[4]
    for idx in range(len(parent)):
        if find(idx) != idx:
            continue
        area, minx, maxx, miny, maxy = stats[idx]
        bw, bh = maxx - minx + 1, maxy - miny + 1
        if best is None or area > best[0]:
            best = (area, bw, bh, bw / float(bh))
    if best is None:
        return None
    return {'area': best[0], 'w': best[1], 'h': best[2], 'aspect': best[3]}


def cmd_check_raw(panel_dir, raw_dir):
    """原始帧的轮廓漂移：与静止帧比最大连通域的长宽比。"""
    ref = main_component(os.path.join(panel_dir, BASE))
    if ref is None:
        print('cannot measure the baseline')
        return 1
    print('baseline %s: cat %dx%d aspect %.3f' % (BASE, ref['w'], ref['h'], ref['aspect']))
    failed = 0
    for name, _s, _p in all_frames():
        raw = os.path.join(raw_dir, name)
        if not os.path.exists(raw):
            print('MISSING  %s' % name)
            failed += 1
            continue
        m = main_component(raw)
        if m is None:
            print('EMPTY    %s' % name)
            failed += 1
            continue
        drift = m['aspect'] / ref['aspect'] - 1.0
        ok = abs(drift) <= ASPECT_TOL
        print('%s %-24s cat %dx%d aspect %.3f drift %+.1f%%' % (
            'OK      ' if ok else 'OFF-MODEL', name, m['w'], m['h'], m['aspect'], drift * 100))
        if not ok:
            failed += 1
    print('%d frame(s) drifted beyond +-%.0f%%' % (failed, ASPECT_TOL * 100))
    return 1 if failed else 0


def main(argv):
    ap = argparse.ArgumentParser(description='panel mascot lift frames')
    ap.add_argument('--gen', action='store_true', help='generate raw frames from the image model')
    ap.add_argument('--only', nargs='+', metavar='FILE', help='with --gen: only these frame files')
    ap.add_argument('--normalize', action='store_true', help='normalize raw frames into place')
    ap.add_argument('--check', action='store_true', help='check shipped frames against the contract')
    ap.add_argument('--check-raw', action='store_true',
                    help='measure silhouette drift of the RAW frames against the resting frame')
    ap.add_argument('--panel-dir', default=PNG_DIR)
    ap.add_argument('--raw-dir', default=RAW_DIR)
    ap.add_argument('--include-reference', action='store_true',
                    help='with --check: also check the existing expression frames')
    ap.add_argument('--sample', type=int, default=0, help='with --check: only the first N targets')
    args = ap.parse_args(argv)

    if args.gen:
        return cmd_gen(set(args.only or []))
    if args.normalize:
        return cmd_normalize(args.panel_dir, args.raw_dir)
    if args.check_raw:
        return cmd_check_raw(args.panel_dir, args.raw_dir)
    if args.check or not argv:
        return cmd_check(args.panel_dir, args.sample, args.include_reference)
    ap.print_help()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
