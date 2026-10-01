/**
 * "被拎起来"那五帧的**像素断言**，外加三处接线。
 *
 * 为什么值得再解一次 PNG（本仓第二处解像素，第一处是 `panel-tray-pixels.test.ts`）：
 * 这五张图是**生图模型逐帧出的**，最容易翻的车恰恰是"什么都不报错"的那一类 ——
 *
 *   1. **轮廓被悄悄改了**。第一版里 "held" 那张把猫画成了尖顶斗篷、耳朵也没了：尺寸照旧
 *      256×256、白名单也登记了、圆外像素 0，所有几何断言全绿，而它贴到球上已经不是同一只猫。
 *      实测猫的 bbox 长宽比从 0.794 掉到 0.650（−18%）。所以下面按**最大连通域**（= 猫本身，
 *      不含旁白气泡与惊叹号）钉住长宽比与宽度。
 *   2. **五帧其实是同一张图**（或者忘了换）。所以有"相邻帧必须真的不一样"那条。
 *   3. **缩放没落进图里**。动作靠逐帧收小读出来，而那件事在文件名、白名单、CSS 里都看不出来。
 *
 * 口径与 `scripts/panel_frames.py` 一致（两处漂了就会对不上）：
 * 实心 = alpha >= 128；距离从**画布中心 (128,128)** 量，不是内容中心 —— 从内容中心量是另一个
 * 数（124.16 vs 125.25），混着用会得出相反的结论。上限 0.98 × 128 = 125.44。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { join } from 'node:path'

const ROOT = process.cwd()
const PANEL = join(ROOT, 'resources', 'panel')
const SERVER = join(ROOT, 'src', 'panel', 'server.ts')
const CSS = join(PANEL, 'panel.css')
const RENDERER = join(PANEL, 'renderer.js')

const CANVAS = 256
const ALPHA_SOLID = 128
const CAP = 0.98 * (CANVAS / 2)          // 125.44
const ASPECT_TOL = 0.06

/** 文件 -> 相对静止帧的缩放。**与 `scripts/panel_frames.py` 的 SCALES 是一份契约。 */
const FRAMES: [string, number][] = [
  ['mascot-lift-start.png', 0.975],
  ['mascot-lift-rise.png', 0.945],
  ['mascot-lift-held.png', 0.920],
  ['mascot-lift-down.png', 0.945],
  ['mascot-lift-settle.png', 0.975],
]
const BASE = 'mascot-base.png'

/** 最小 PNG 解码：只处理 8 位 RGBA、非隔行（与 tray 那份同一手法，见那边的说明）。 */
function decodePng(file: string) {
  const b = readFileSync(file)
  const width = b.readUInt32BE(16)
  const height = b.readUInt32BE(20)
  if (b[24] !== 8 || b[25] !== 6) throw new Error(`${file} 不是 8 位 RGBA（生图通道会给 RGB）`)
  let off = 8
  const idat: Buffer[] = []
  while (off < b.length) {
    const len = b.readUInt32BE(off)
    if (b.subarray(off + 4, off + 8).toString('latin1') === 'IDAT') {
      idat.push(b.subarray(off + 8, off + 8 + len))
    }
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const out = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const cur = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? cur[x - 4] : 0
      const up = prev[x]
      const c = x >= 4 ? prev[x - 4] : 0
      if (filter === 1) cur[x] = (cur[x] + a) & 255
      else if (filter === 2) cur[x] = (cur[x] + up) & 255
      else if (filter === 3) cur[x] = (cur[x] + ((a + up) >> 1)) & 255
      else if (filter === 4) {
        const p = a + up - c
        const pa = Math.abs(p - a); const pb = Math.abs(p - up); const pc = Math.abs(p - c)
        cur[x] = (cur[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c)) & 255
      }
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  const at = (x: number, y: number) => {
    const i = (y * width + x) * 4
    return { r: out[i], g: out[i + 1], b: out[i + 2], a: out[i + 3] }
  }
  return { width, height, at }
}

interface Measured {
  solid: number
  maxDist: number
  outsideCircle: number
  minX: number; maxX: number; minY: number; maxY: number
  apexY: number
  cx: number
}

function measure(name: string): Measured & { cat: { w: number; h: number; aspect: number } } {
  const img = decodePng(join(PANEL, name))
  const { width: w, height: h, at } = img
  assert.equal(w, CANVAS, `${name} 宽度必须是 ${CANVAS}`)
  assert.equal(h, CANVAS, `${name} 高度必须是 ${CANVAS}`)
  const cx = CANVAS / 2
  const cy = CANVAS / 2
  let solid = 0
  let maxDist = 0
  let outside = 0
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1
  const rowCount = new Map<number, number>()
  // 连通域：按行扫描 + 并查集。**为了拿到"猫自己"**（最大连通域），
  // 因为整张内容里还有旁白气泡与四个惊叹号，它们的相对大小逐帧不同。
  const parent: number[] = []
  const stats: { area: number; minX: number; maxX: number; minY: number; maxY: number }[] = []
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a] } return a }
  const union = (a: number, b: number) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra }
  let prevRuns: [number, number, number][] = []
  let runs: [number, number, number][] = []

  for (let y = 0; y < h; y++) {
    runs = []
    let x = 0
    while (x < w) {
      if (at(x, y).a >= ALPHA_SOLID) {
        const x0 = x
        while (x < w && at(x, y).a >= ALPHA_SOLID) x++
        const idx = parent.length
        parent.push(idx)
        stats.push({ area: x - x0, minX: x0, maxX: x - 1, minY: y, maxY: y })
        for (const [px0, px1, pidx] of prevRuns) {
          if (px1 >= x0 && px0 <= x - 1) union(idx, pidx)
        }
        runs.push([x0, x - 1, idx])
      } else x++
    }
    prevRuns = runs

    for (let px = 0; px < w; px++) {
      if (at(px, y).a < ALPHA_SOLID) continue
      solid++
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      rowCount.set(y, (rowCount.get(y) ?? 0) + 1)
      const d = Math.hypot(px - cx, y - cy)
      if (d > maxDist) maxDist = d
      if (d > CANVAS / 2) outside++
    }
  }
  // 把每个 run 的统计并到它的根上
  for (let i = 0; i < parent.length; i++) {
    const root = find(i)
    if (root === i) continue
    const t = stats[root]
    const c = stats[i]
    t.area += c.area
    if (c.minX < t.minX) t.minX = c.minX
    if (c.maxX > t.maxX) t.maxX = c.maxX
    if (c.minY < t.minY) t.minY = c.minY
    if (c.maxY > t.maxY) t.maxY = c.maxY
  }
  let cat = { area: -1, w: 0, h: 0, aspect: 0 }
  for (let i = 0; i < parent.length; i++) {
    if (find(i) !== i) continue
    const t = stats[i]
    const bw = t.maxX - t.minX + 1
    const bh = t.maxY - t.minY + 1
    if (t.area > cat.area) cat = { area: t.area, w: bw, h: bh, aspect: bw / bh }
  }
  const apexY = [...rowCount.entries()].filter(([, n]) => n >= 4).map(([y]) => y).sort((a, b) => a - b)[0]
  return { solid, maxDist, outsideCircle: outside, minX, maxX, minY, maxY, apexY, cx: (minX + maxX) / 2, cat }
}

/** 两帧有多少**实心像素**不同（用来证明它们确实不是同一张图）。 */
function diffRatio(a: string, b: string): number {
  const A = decodePng(join(PANEL, a))
  const B = decodePng(join(PANEL, b))
  let differ = 0
  let both = 0
  for (let y = 0; y < CANVAS; y++) {
    for (let x = 0; x < CANVAS; x++) {
      const p = A.at(x, y)
      const q = B.at(x, y)
      if (p.a < ALPHA_SOLID && q.a < ALPHA_SOLID) continue
      both++
      if (Math.abs(p.r - q.r) > 12 || Math.abs(p.g - q.g) > 12 || Math.abs(p.b - q.b) > 12) differ++
    }
  }
  return both === 0 ? 0 : differ / both
}

const base = measure(BASE)

test('动作帧都在、都在目录清单与静态白名单里（漏一处线上就 404，而页面看不见）', () => {
  const packaging = readFileSync(join(ROOT, 'test', 'panel-packaging.test.ts'), 'utf8')
  const server = readFileSync(SERVER, 'utf8')
  for (const [name] of FRAMES) {
    assert.ok(existsSync(join(PANEL, name)), `缺文件 resources/panel/${name}`)
    assert.ok(packaging.includes(`'${name}'`), `PANEL_FILES 里要登记 ${name}`)
    assert.ok(server.includes(`'/panel/${name}': '${name}'`),
      `静态白名单里要有 ${name} —— 漏了它，那一段动作里球会闪成空图`)
  }
})

test('五帧都落在圆里、且都还在球的那个尺寸上', () => {
  for (const [name] of FRAMES) {
    const m = measure(name)
    assert.ok(m.solid > 1000, `${name} 只有 ${m.solid} 个实心像素，像是空的`)
    assert.ok(m.maxDist <= CAP, `${name} 到中心 ${m.maxDist.toFixed(2)} 超过 ${CAP.toFixed(2)}`)
    // 这条是"球不会被切掉一块"的全部：球是 border-radius 50%，圆外的实心像素会被剪掉
    assert.equal(m.outsideCircle, 0, `${name} 有 ${m.outsideCircle} 个实心像素落在圆外`)
  }
})

test('逐帧收小：缩放落在**猫的宽度**上，五帧按设计递减再回来', () => {
  // **别用"到画布中心的距离"来判缩放。** 静止帧 125.25、held 只有 115.23 × 缩放…… 实际上
  // held 量的距离反而更大（124.20），因为头顶锚定把内容往上挪了：距离被"位置"主导，
  // 不反映"缩了多少"。真正承诺给视觉的是**猫的宽度**，所以断言它。
  for (const [name, scale] of FRAMES) {
    const m = measure(name)
    const target = base.cat.w * scale
    assert.ok(Math.abs(m.cat.w - target) <= 4,
      `${name} 的猫宽 ${m.cat.w} 偏离目标 ${target.toFixed(1)}（±4）—— 缩放没落进图里`)
  }
  const widths = FRAMES.map(([name]) => measure(name).cat.w)
  assert.ok(widths[2] < widths[1] && widths[1] < widths[0],
    `三帧应当逐级收小，实际 ${widths.slice(0, 3).join(' > ')}`)
  assert.ok(Math.abs(widths[4] - widths[0]) <= 3, '落回那帧应当回到与起势帧相当的宽度')
})

test('轮廓不许被生图模型改掉：猫的长宽比与静止帧一致，头顶对齐', () => {
  // 这条盯的正是第一版翻的车：held 被画成尖顶斗篷 + 细长身子，长宽比 0.650（−18%）。
  // 尺寸、白名单、圆外像素那几条**全都不会红**——只有这条会。
  for (const [name] of FRAMES) {
    const m = measure(name)
    const drift = m.cat.aspect / base.cat.aspect - 1
    assert.ok(Math.abs(drift) <= ASPECT_TOL,
      `${name} 的猫长宽比 ${m.cat.aspect.toFixed(3)} 相对静止帧漂了 ${(drift * 100).toFixed(1)}%（上限 ±${ASPECT_TOL * 100}%）`)
    assert.ok(Math.abs(m.apexY - base.apexY) <= 2,
      `${name} 头顶在第 ${m.apexY} 行，静止帧在 ${base.apexY} —— 超过 2 像素就会看着跳`)
    assert.ok(Math.abs(m.cx - base.cx) <= 2,
      `${name} 水平中心 ${m.cx}，静止帧 ${base.cx}`)
  }
})

test('五帧两两都不是同一张图（否则"动作"是假的，而上面每条都会过）', () => {
  // **两两比，不是只比相邻。** 第一版只比相邻，于是"把 rise 复制成 down"这个变异**全绿通过**
  // —— 它俩在列表里不相邻，从来没被比过。是变异检查把这条空洞查出来的。
  // 阈值 10% 是量出来的，不是拍的：实测最接近的一对是 rise vs held = 27.1%，留足余量。
  const names = [BASE, ...FRAMES.map(([n]) => n)]
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const r = diffRatio(names[i], names[j])
      assert.ok(r >= 0.10,
        `${names[i]} 与 ${names[j]} 只有 ${(r * 100).toFixed(1)}% 的像素不同 —— 像是同一张图`)
    }
  }
})

test('接线：CSS 指向这五张、且排在 ball-happy 之后；预取列表里有它们', () => {
  const css = readFileSync(CSS, 'utf8')
  const renderer = readFileSync(RENDERER, 'utf8')
  const happyAt = css.indexOf('body.ball-happy #ball .face')
  assert.ok(happyAt > 0, '要有 ball-happy 那条')
  for (const [name, ] of FRAMES) {
    // 文件名与类名的对应是 `mascot-X.png` ↔ `body.ball-X`，**推导出来**而不是写死：
    // 写死的话，哪天有人把某个类名改了、CSS 指向另一张图，这条也照样绿。
    const cls = 'body.' + name.replace(/^mascot-/, 'ball-').replace(/\.png$/, '')
    // 类名与文件名必须一一对应，否则换了帧却指向同一张图（而且不会报错）
    const at = css.indexOf(cls + ' #ball .face')
    assert.ok(at > 0, `panel.css 里要有 ${cls} 那条规则`)
    assert.ok(css.slice(at, css.indexOf('}', at)).includes(`/panel/${name}`),
      `${cls} 那条要指向 /panel/${name}`)
    assert.ok(at > happyAt, `${cls} 要写在 ball-happy 之后，否则按下时看不到动作`)
    assert.ok(renderer.includes(`'${name}'`), `预取列表里要有 ${name} —— 不然第一帧是空的`)
  }
  // 动作期间虹膜层必须藏掉：这五帧的眼睛是画死的，叠上会动的虹膜就是两个瞳仁
  assert.ok(/body\.ball-lift #ball \.iris \{\s*display: none/.test(css),
    '动作期间要把虹膜层藏掉')
})
