/**
 * 拖着走时"垂着晃"：按住会播"被拎起来"，而**拖动的过程中**它该跟着拖动滞一下。
 *
 * 与挠痒同一套做法 —— 倾斜是**程序算的**（按速度），绕球心转（旋转不改变像素到球心的距离，
 * 所以不占圆的余量），角度经 body 上的 `--dangle-deg` 交给 CSS。jsdom 里 CSS 不跑，所以这里验的是
 * **那个自定义属性**，不是"看起来像不像被拎着"。
 *
 * 三条容易静默写错的：
 *   1. **点击不该晃**：4px 阈值之内是点击，那时候球根本不该动（阈值判断在拖动那条分支里）。
 *   2. **方向要相反**：往右拖，身体该往**左**滞（像被拎着的东西落在后面），不是跟着倒。
 *   3. **松手与换形态都要回正**：漏了任一条，球会歪着不动。
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

  window.setInterval = () => 0
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

  const script = window.document.createElement('script')
  script.textContent = RENDERER
  window.document.body.appendChild(script)
  await wait(0)
  await wait(0)

  const ball = window.document.getElementById('ball') as any
  const ev = (type: string, x: number, y: number) =>
    new window.MouseEvent(type, { button: 0, screenX: x, screenY: y, bubbles: true })
  return {
    window,
    deg: () => window.document.body.style.getPropertyValue('--dangle-deg'),
    press: (x = 1000, y = 800) => ball.dispatchEvent(ev('pointerdown', x, y)),
    move: (x: number, y: number) => window.dispatchEvent(ev('pointermove', x, y)),
    release: (x = 1000, y = 800) => window.dispatchEvent(ev('pointerup', x, y)),
    notifyMode: (p: any) => modeListener?.(p),
  }
}

test('往右拖 → 身体往左滞（方向相反），松手回正', async () => {
  const app = await boot()
  try {
    app.press()
    await wait(12)                       // 留一点真实时间，速度才不是无穷大
    app.move(1060, 800)                  // 往右拖 60px
    const deg = Number.parseFloat(app.deg())
    assert.ok(Number.isFinite(deg) && deg !== 0, `拖动时该有倾斜，实际 ${app.deg()}`)
    assert.ok(deg < 0, `往右拖该往左滞（负角），实际 ${deg}`)
    app.release(1060, 800)
    await wait(20)
    assert.equal(Number.parseFloat(app.deg()) || 0, 0, `松手要回正，实际 ${app.deg()}`)
  } finally { app.window.close() }
})

test('4px 阈值之内的一次点击不该晃', async () => {
  const app = await boot()
  try {
    app.press()
    await wait(12)
    app.move(1002, 801)                  // 只动 2px：这是点击，不是拖动
    assert.equal(Number.parseFloat(app.deg()) || 0, 0, `点击不该产生倾斜，实际 ${app.deg()}`)
  } finally { app.window.close() }
})

test('换形态也要回正（托盘/快捷键那条路）', async () => {
  const app = await boot()
  try {
    app.press()
    await wait(12)
    app.move(1080, 800)
    assert.ok(Number.parseFloat(app.deg()) !== 0, '前提：此刻有倾斜')
    app.notifyMode({ mode: 'ball', done: true, fadeMs: 0 })
    assert.equal(Number.parseFloat(app.deg()) || 0, 0, `换形态之后不该还歪着，实际 ${app.deg()}`)
  } finally { app.window.close() }
})

test('reduced-motion：一点不晃', async () => {
  const app = await boot({ reducedMotion: true })
  try {
    app.press()
    await wait(12)
    app.move(1080, 800)
    assert.equal(Number.parseFloat(app.deg()) || 0, 0, `少动效时不该有倾斜，实际 ${app.deg()}`)
  } finally { app.window.close() }
})
