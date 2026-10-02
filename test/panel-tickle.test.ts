/**
 * 挠痒痒：**在球身上晃过它就扭，停下就回正**。
 *
 * 为什么会有这一条（用户 2026-10-02 要的）：鼠标从它身上划过时像被挠到。分工是刻意的 ——
 * 4 张生图帧只负责表情与爪子的小动作，**倾斜由渲染进程按鼠标速度算**，因为固定帧做不出
 * "挠得越狠扭得越厉害"。
 *
 * jsdom 里 CSS 不跑，所以这里验的是**类名与那个自定义属性**（倾斜角经 `--tickle-deg` 传给 CSS），
 * 不是"看起来像不像被挠" —— 好看只能人看（而且这个透明窗口截图会假阴性，仓库有记录）。
 *
 * 三条容易静默写错的：
 *   1. **停下要回正**（不是"扭一次就挂着"）：回正的定时器漏了，球会歪着不动。
 *   2. **按下要立刻让位**给"被拎起来"那套 —— 两个动作同时挂类会互相打架。
 *   3. **reduced-motion 下一动都不许动**，半隐在屏幕边时也不许（那张图的直切边转一下就露缝）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'

const RENDERER = readFileSync(join(process.cwd(), 'resources', 'panel', 'renderer.js'), 'utf8')
const TICKLE_CLASSES = ['ball-tickle-1', 'ball-tickle-2', 'ball-tickle-3', 'ball-tickle-4']
const DECAY_MS = 260

const HTML = `<!doctype html><html><body>
  <button id="ball" hidden><span class="face"></span><span class="iris"></span></button>
  <header><span id="status"></span><button id="collapse" hidden>收起</button></header>
  <main id="log"></main>
  <form id="composer"><textarea id="input"></textarea><button id="send">发送</button></form>
  <footer id="foot"></footer>
</body></html>`

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Booted {
  window: any
  bodyHas: (cls: string) => boolean
  tickleClasses: () => string[]
  deg: () => string
  move: (x: number, y: number) => void
  press: () => void
  notifyMode: (payload: any) => void
}

async function boot(options: { reducedMotion?: boolean } = {}): Promise<Booted> {
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://127.0.0.1:8766/panel' })
  const { window } = dom
  let modeListener: ((payload: any) => void) | null = null

  window.setInterval = () => 0
  window.matchMedia = (query: string) => ({
    matches: query.includes('prefers-reduced-motion') && options.reducedMotion === true,
    media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  })
  window.fetch = (async () => ({ ok: true, json: async () => ({ channelActive: false, quota: { used: 0, limit: 100 } }) })) as any
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
  const move = (x: number, y: number) => {
    ball.dispatchEvent(new window.MouseEvent('pointermove', { button: 0, screenX: x, screenY: y, bubbles: true }))
  }
  return {
    window,
    bodyHas: (cls) => window.document.body.classList.contains(cls),
    tickleClasses: () => TICKLE_CLASSES.filter((c) => window.document.body.classList.contains(c)),
    deg: () => window.document.body.style.getPropertyValue('--tickle-deg'),
    move,
    press: () => { ball.dispatchEvent(new window.MouseEvent('pointerdown', { button: 0, screenX: 1000, screenY: 800, bubbles: true })) },
    notifyMode: (payload) => { modeListener?.(payload) },
  }
}

test('在它身上晃过就扭：挂上姿势帧 + 一个非零倾斜角', async () => {
  const app = await boot()
  try {
    app.move(1000, 800)
    await wait(12)                       // 留一点真实时间，速度才不是无穷大
    app.move(1040, 802)                  // 往右划 40px
    assert.equal(app.bodyHas('ball-tickle'), true, '划过之后应当进入挠痒痒状态')
    assert.equal(app.tickleClasses().length, 1, '同时只该挂一帧姿势')
    const deg = Number.parseFloat(app.deg())
    assert.ok(Number.isFinite(deg) && deg !== 0, `倾斜角应当非零，实际 ${app.deg()}`)
    // 往右划 → 往反方向（左）倒，所以是负角
    assert.ok(deg < 0, `往右划应当往左倒（负角），实际 ${deg}`)
  } finally { app.window.close() }
})

test('停下就回正：不再移动一段时间之后类与角度都清干净', async () => {
  const app = await boot()
  try {
    app.move(1000, 800)
    await wait(12)
    app.move(1050, 800)
    assert.equal(app.bodyHas('ball-tickle'), true)
    await wait(DECAY_MS + 300)   // 余量给足：满负载下定时器会晚
    assert.equal(app.bodyHas('ball-tickle'), false, '停下之后应当回正')
    assert.deepEqual(app.tickleClasses(), [], '姿势帧也要摘掉')
    assert.equal(app.deg(), '0deg', `角度应当归零，实际 ${app.deg()}`)
  } finally { app.window.close() }
})

test('按下时让位给"被拎起来"那套（两个动作不许同时挂着）', async () => {
  const app = await boot()
  try {
    app.move(1000, 800)
    await wait(12)
    app.move(1040, 800)
    assert.equal(app.bodyHas('ball-tickle'), true, '前提：此刻在挠痒痒')
    app.press()
    assert.deepEqual(app.tickleClasses(), [], '按下之后挠痒痒的姿势帧要让位')
    assert.equal(app.bodyHas('ball-tickle'), false)
    assert.equal(app.bodyHas('ball-lift-up-1'), true, '按下那一帧应当已经出了')
  } finally { app.window.close() }
})

test('reduced-motion：一动都不动', async () => {
  const app = await boot({ reducedMotion: true })
  try {
    app.move(1000, 800)
    await wait(12)
    app.move(1060, 800)
    await wait(20)
    assert.equal(app.bodyHas('ball-tickle'), false, '系统要求少动效时不挠')
    assert.deepEqual(app.tickleClasses(), [])
  } finally { app.window.close() }
})

test('半隐在屏幕边时不挠（那张图的直切边转一下就露缝）', async () => {
  const app = await boot()
  try {
    app.notifyMode({ mode: 'ball', done: true, peek: 'left' })
    assert.equal(app.bodyHas('ball-peek'), true, '前提：此刻是半隐态')
    app.move(1000, 800)
    await wait(12)
    app.move(1060, 800)
    await wait(20)
    assert.equal(app.bodyHas('ball-tickle'), false, '半隐态不挠')
  } finally { app.window.close() }
})
