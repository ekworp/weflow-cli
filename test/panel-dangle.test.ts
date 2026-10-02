/**
 * 被拎起来时"左右晃"：**一按下就开始摆**（像挂在手里的挂件），拖动决定**哪一侧摆得更大、以及更大多少**。
 *
 * 用户 2026-10-02 的原话：「提起来的时候就开始左右晃动了，只不过往左边移动往左晃动的幅度更大，
 * 往右则是右边幅度大」，随后补了一句「往左移动速度的快，就往左多晃一点，**目前固定的**」。
 * 而这里的"多晃一点"指的是**整段摆幅**：只让倾斜量跟速度走、基础摆幅还是常数的话，慢拖与快甩看起来
 * 仍然是"一样晃"（上一轮就栽在这儿：倾斜 0→10° 跟着速度，正弦却是死的 ±12°，大头是常数）。
 * 三条都写进断言了：一按下就开始晃、往哪边偏、以及幅度随速度单调上升。旧版"按速度给静态倾角、方向与拖动**相反**"是照着
 * "被拎着的东西会向后滞"写的 —— 物理上对，但不是他要的。顺带删掉了旧版"4px 之内的一次点击不该晃"：
 * 点击本来就是"拎起来又放回去"，机制换了那条就不成立（是**删**，不是反着抄一遍）。
 *
 * 倾斜是程序算的、绕球心转（旋转不改变像素到球心的距离，所以不占圆的余量），角度经 body 上的
 * `--dangle-deg` 交给 CSS。jsdom 里 CSS 不跑，所以这里验的是**那个自定义属性**，不是"看起来像不像"。
 *
 * **这套测试跑在虚拟时钟上**（`setTimeout` / `performance.now` 换掉，由 `advance()` 推）：
 * 第一版用真实时钟，量出来 `await wait(20)` 实际是 25~31ms（Windows 的定时器粒度），
 * 于是"慢拖"到底多慢根本说不准 —— 变异检查里把吃满速度改回 450（**正是用户报的那个 bug**）
 * 是绿着溜过去的。虚拟时钟下速度 = 位移 ÷ 推进的毫秒数，精确可控；顺带六条测试从 5.6 秒变成几十毫秒。
 *
 * 五条容易静默写错的：
 *   1. **按下就开始摆**：不必等拖过 4px 阈值（阈值只管"算不算点击"，不管动作）。
 *   2. **同向偏心**：往右拖右边更大、左边被压小（反过来验就往左拖）。只断言一条，方向写反了也会绿。
 *   3. **越快摆得越大**：幅度要随速度走。写死一个恒定幅度能让 1、2 全绿 —— 所以这条单独盯着。
 *   4. **松手、换形态都要停并回正**：只回正不停定时器，球会继续在零度附近抖着写属性。
 *   5. **少动效一点不摆**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'

const RENDERER = readFileSync(join(process.cwd(), 'resources', 'panel', 'renderer.js'), 'utf8')

const HTML = `<!doctype html><html><body>
  <button id="ball" hidden><span class="face"></span><span class="iris"></span></button>
  <div id="bubble">
    <header><span class="brand">x</span><span id="status" class="status"></span>
      <button id="collapse" type="button" class="ghost" hidden>收起</button></header>
    <main id="log"></main>
    <form id="composer"><textarea id="input"></textarea><button id="send">发送</button></form>
    <footer id="foot"></footer>
    <div id="tail"></div>
  </div>
</body></html>`

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function boot(opts: { reducedMotion?: boolean } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://127.0.0.1:8766/panel' })
  const { window } = dom
  let modeListener: ((payload: any) => void) | null = null

  // ---- 虚拟时钟：只换"超时"与"现在几点"，别的照旧 ----
  let now = 0
  let nextId = 1
  const queue: Array<{ at: number; fn: () => void; id: number }> = []
  Object.defineProperty(window.performance, 'now', { value: () => now, configurable: true })
  window.setTimeout = ((fn: any, ms = 0) => {
    const id = nextId++
    queue.push({ at: now + (Number(ms) || 0), fn, id })
    return id
  }) as any
  window.clearTimeout = ((id: any) => {
    const i = queue.findIndex((q) => q.id === id)
    if (i >= 0) queue.splice(i, 1)
  }) as any
  window.setInterval = (() => 0) as any

  window.matchMedia = (q: string) => ({
    matches: q.includes('prefers-reduced-motion') && opts.reducedMotion === true,
    media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  })
  window.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ channelActive: true, aiConfigured: true, quota: { used: 0, limit: 100 }, memoryBucket: 'b', quickReplies: [] }) })) as any
  window.weflowPanel = {
    setMode: () => Promise.resolve({}), onCursor: () => {}, onMode: (cb: any) => { modeListener = cb },
    dragStart: () => Promise.resolve(), dragMove: () => Promise.resolve(), dragEnd: () => Promise.resolve(),
    info: () => Promise.resolve({}), quit: () => Promise.resolve(), openQuickMenu: () => Promise.resolve(null),
  }

  const ball = window.document.getElementById('ball') as any
  const degNum = () => Number.parseFloat(window.document.body.style.getPropertyValue('--dangle-deg')) || 0

  /** 跑掉所有**此刻已到期**的定时器（不推进时钟）：等价于真实时钟那边的 `await wait(0)`。 */
  function flush() {
    for (;;) {
      const i = queue.findIndex((q) => q.at <= now)
      if (i < 0) break
      const [item] = queue.splice(i, 1)
      item.fn()
    }
  }

  /** 把时钟往前推 ms，沿途跑掉到期的定时器，每 step 毫秒回采一次角度（所以极值抓得准）。 */
  function advance(ms: number, step = 4): number[] {
    const seen: number[] = []
    const until = now + ms
    while (now < until) {
      now = Math.min(until, now + step)
      flush()
      seen.push(degNum())
    }
    return seen
  }

  const script = window.document.createElement('script')
  script.textContent = RENDERER
  window.document.body.appendChild(script)
  await wait(0)
  await wait(0)
  flush()

  const ev = (type: string, x: number, y: number) =>
    new window.MouseEvent(type, { button: 0, screenX: x, screenY: y, bubbles: true })
  return {
    window,
    advance,
    deg: degNum,
    press: (x = 1000, y = 800) => ball.dispatchEvent(ev('pointerdown', x, y)),
    move: (x: number, y: number) => window.dispatchEvent(ev('pointermove', x, y)),
    release: (x = 1000, y = 800) => window.dispatchEvent(ev('pointerup', x, y)),
    notifyMode: (p: any) => modeListener?.(p),
  }
}

type App = Awaited<ReturnType<typeof boot>>

/** 按住 → 推进 `dtMs` → 用 `px / dtMs`（px/s = px/dtMs*1000）的速度横拖 → 再采一个完整摆动周期。
 *
 *  必须是**整周期**（950ms）：正弦的正峰在 ~225ms、负峰在 ~675ms。只看前 300ms 的话负峰压根不在
 *  窗口里 —— 实测过，那样连"偏心衰减短到只影响前半摆"这种坏法都拦不住（变异检查绿了）。 */
function dragAt(app: App, dir: 1 | -1, px: number, dtMs: number) {
  app.press()
  const before = app.advance(dtMs)
  app.move(1000 + px * dir, 800)
  const after = app.advance(950)
  const all = [...before, ...after]
  app.release(1000 + px * dir, 800)
  return { max: Math.max(...all), min: Math.min(...all) }
}

test('一按下就开始摆（不必先拖）', async () => {
  const app = await boot()
  try {
    app.press()
    const seen = app.advance(120)
    assert.ok(seen.some((v) => Math.abs(v) > 0.5), `按下不动也该晃，实测 ${seen.map((v) => v.toFixed(1)).join(', ')}`)
  } finally { app.window.close() }
})

test('同向偏心：往哪边拖，哪一边就摆得更大（同侧 ~22°，对侧被压到 ~10°）', async () => {
  const app = await boot()
  try {
    const right = dragAt(app, 1, 60, 12)      // 5000 px/s，劲头吃满
    const left = dragAt(app, -1, 60, 12)
    // 甩到最狠时：摆幅 16°、同向倾斜 6° —— 于是往右拖是 +22/−10，往左拖是 +10/−22。
    // 判据用**不对称度**（max + min）：往右该明显为正、往左该明显为负。只断言"最大值够大"的话，
    // 一个两边一起放大的实现也能过 —— 那就不叫"往哪边移动哪边更大"了。
    assert.ok(right.max > 18, `往右拖，右侧该接近 +22°（单次移动约 19°、连续拖到 22°）——实测 ${right.max.toFixed(1)}°`)
    assert.ok(left.min < -18, `往左拖，左侧该接近 −22°（单次移动约 −19°）——实测 ${left.min.toFixed(1)}°`)
    assert.ok(right.max + right.min > 7, `往右拖该偏右（向上不对称）——实测 ${(right.max + right.min).toFixed(1)}°`)
    assert.ok(left.max + left.min < -7, `往左拖该偏左（向下不对称）——实测 ${(left.max + left.min).toFixed(1)}°`)
  } finally { app.window.close() }
})

test('速度越快摆得越大（慢拖与快甩要拉开，不是固定的）', async () => {
  const app = await boot()
  try {
    const p100 = dragAt(app, 1, 5, 50)        // 100 px/s：几乎只剩静止那个最小晃动
    const p400 = dragAt(app, 1, 20, 50)       // 400 px/s
    const p900 = dragAt(app, 1, 45, 50)       // 900 px/s：吃满速度的一半
    const p1800 = dragAt(app, 1, 90, 50)      // 1800 px/s：正好吃满
    // **这一条就是拦"目前固定的"的**：整段摆幅若不跟速度走（MIN 写成与 MAX 相同），或吃满速度调回
    // 450（用户报的那个值），p400 都会从 ~9° 跳到 ~20°。
    assert.ok(p400.max < 13, `400 px/s 只该轻轻晃（~9°），实测 ${p400.max.toFixed(1)}°`)
    assert.ok(p1800.max > 18, `1800 px/s 该接近吃满（单次移动约 19°、连续拖到 22°），实测 ${p1800.max.toFixed(1)}°`)
    assert.ok(p1800.max - p400.max > 6, `快慢要拉开，实测 快 ${p1800.max.toFixed(1)}° / 慢 ${p400.max.toFixed(1)}°`)
    assert.ok(
      p900.max > p400.max && p400.max > p100.max,
      `幅度该随速度单调上升，实测 100:${p100.max.toFixed(1)} 400:${p400.max.toFixed(1)} 900:${p900.max.toFixed(1)}`,
    )
  } finally { app.window.close() }
})

test('静止拎着也有一点点晃（最小摆幅：不然"提起来就晃"会变成"动了才晃"）', async () => {
  const app = await boot()
  try {
    app.press()
    const seen = app.advance(950)                       // 一个完整周期，全程没移动
    const peak = Math.max(...seen.map(Math.abs))
    assert.ok(peak > 4.5 && peak < 7.5, `静止拎着该是 ~6° 的小晃，实测 ${peak.toFixed(2)}°`)
  } finally { app.window.close() }
})

test('松手后停下并回正（定时器不能漏着跑）', async () => {
  const app = await boot()
  try {
    app.press()
    app.advance(12)
    app.move(1080, 800)
    app.advance(60)
    app.release(1080, 800)
    const after = app.advance(400)
    assert.ok(Math.max(...after.map(Math.abs)) === 0, `松手后该一直是 0，实测最大 ${Math.max(...after.map(Math.abs)).toFixed(2)}`)
  } finally { app.window.close() }
})

test('换形态也要停并回正（托盘/快捷键那条路）', async () => {
  const app = await boot()
  try {
    app.press()
    app.advance(12)
    app.move(1080, 800)
    assert.ok(app.deg() !== 0, '前提：此刻有倾斜')
    app.notifyMode({ mode: 'ball', done: true, fadeMs: 0 })
    const after = app.advance(200)                                  // 给漏掉的定时器一次机会暴露自己
    assert.ok(Math.max(...after.map(Math.abs)) === 0, `换形态之后不该还歪着，实测最大 ${Math.max(...after.map(Math.abs)).toFixed(2)}`)
  } finally { app.window.close() }
})

test('被拎着时 body 上必须有 ball-lift（那条 CSS 只挂在它下面，漏了就等于"算了不画"）', async () => {
  // 晃动那条规则是 `body.ball-lift #ball { transform: rotate(var(--dangle-deg)) }`。也就是说
  // 上面所有断言读的 `--dangle-deg` 只是**算出来的数**：`ball-lift` 没挂上，CSS 就不生效，
  // 球看起来一动不动，而每一条断言照样全绿。这条把"算"与"画"之间的那根线也钉住。
  const app = await boot()
  try {
    app.press()
    app.advance(400)                       // 走完起势那几帧，停在悬空
    assert.ok(app.window.document.body.classList.contains('ball-lift'), '拎起来这一段里该有 ball-lift')
    app.release()
    app.advance(900)                       // 落地那几帧走完
    assert.ok(!app.window.document.body.classList.contains('ball-lift'), '落地之后要摘掉，否则球会一直挂着晃动状态')
  } finally { app.window.close() }
})

test('reduced-motion：一点不摆', async () => {
  const app = await boot({ reducedMotion: true })
  try {
    app.press()
    app.advance(12)
    app.move(1080, 800)
    const seen = app.advance(200)
    assert.ok(Math.max(...seen.map(Math.abs)) === 0, `少动效时不该摆，实测最大 ${Math.max(...seen.map(Math.abs)).toFixed(2)}`)
  } finally { app.window.close() }
})
