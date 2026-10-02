/**
 * "被拎起来"那套动作的**时序**：按下逐帧升到悬空、松手落回原样。
 *
 * jsdom 里 CSS 不跑，所以这里验的是**类名的推进**（哪一帧、什么时候、有没有留尾巴），
 * 不是"看起来顺不顺" —— 好看只能人看，而且这个透明窗口截图会假阴性（仓库有记录）。
 *
 * 三条最容易静默出错的：
 *
 *   1. **松手不留尾巴**。用户否掉过 900ms 的保留期（"手指松开了表情还挂着，像卡在那儿"），
 *      所以落地那几帧播完必须回到"什么都没挂"。这条只能靠等真实的定时器来验。
 *   2. **拖动那条路也要落回**。`onUp` 里 `endLift()` 必须在 `if (dragging) return` **之前**，
 *      否则拖到屏幕边上会留着一张悬空的脸，而"拖拽不触发点击"那条测试照样绿。
 *   3. **reduced-motion 下一帧都不许播**，但仍然要变脸 —— 系统要求少动效时，那张被捏的笑脸
 *      就是它存在的理由（否则那条分支上的 `ball-happy` 成了死码）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'

const RENDERER = readFileSync(join(process.cwd(), 'resources', 'panel', 'renderer.js'), 'utf8')
const LIFT_CLASSES = [...[1, 2, 3, 4, 5, 6].map((n) => 'ball-lift-up-' + n),
  ...[1, 2, 3, 4, 5, 6].map((n) => 'ball-lift-down-' + n)]
const STEP_MS = 60                   // 与 renderer.js 的 LIFT_STEP_MS 一致
/** 升到悬空要走 3 帧、落回也要 3 帧，各留一帧余量 */
const RISE_MS = STEP_MS * 7          // 6 帧 + 一帧余量
const FALL_MS = STEP_MS * 7

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
  calls: { mode: string; opts: any }[]
  bodyHas: (cls: string) => boolean
  liftClasses: () => string[]
  press: (x?: number, y?: number) => void
  move: (x: number, y: number) => void
  release: (x?: number, y?: number) => void
  cancel: () => void
  /** 主进程说换形态（托盘/快捷键那条路走的就是这个通道） */
  notifyMode: (payload: any) => void
}

async function boot(options: { reducedMotion?: boolean } = {}): Promise<Booted> {
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://127.0.0.1:8766/panel' })
  const { window } = dom
  const calls: { mode: string; opts: any }[] = []
  let modeListener: ((payload: any) => void) | null = null

  window.setInterval = () => 0            // 30 秒状态轮询在测试里只会制造噪音
  window.matchMedia = (query: string) => ({
    matches: query.includes('prefers-reduced-motion') && options.reducedMotion === true,
    media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  })
  window.fetch = (async () => ({ ok: true, json: async () => ({ channelActive: false, quota: { used: 0, limit: 100 } }) })) as any
  window.weflowPanel = {
    setMode: (mode: string, opts: any) => { calls.push({ mode, opts: { ...opts } }); return Promise.resolve({ mode }) },
    onMode: (cb: (payload: any) => void) => { modeListener = cb }, onCursor: () => {},
    dragStart: () => Promise.resolve(), dragMove: () => Promise.resolve(), dragEnd: () => Promise.resolve(),
    info: () => Promise.resolve({}), quit: () => Promise.resolve(), openQuickMenu: () => Promise.resolve(null),
  }

  const script = window.document.createElement('script')
  script.textContent = RENDERER
  window.document.body.appendChild(script)
  await wait(0)
  await wait(0)

  const pointer = (type: string, x: number, y: number) =>
    new window.MouseEvent(type, { button: 0, screenX: x, screenY: y, bubbles: true })
  const ball = window.document.getElementById('ball') as any

  return {
    window,
    calls,
    bodyHas: (cls) => window.document.body.classList.contains(cls),
    liftClasses: () => LIFT_CLASSES.filter((c) => window.document.body.classList.contains(c)),
    press: (x = 1000, y = 800) => { ball.dispatchEvent(pointer('pointerdown', x, y)) },
    move: (x, y) => { window.dispatchEvent(pointer('pointermove', x, y)) },
    release: (x = 1000, y = 800) => { window.dispatchEvent(pointer('pointerup', x, y)) },
    cancel: () => { window.dispatchEvent(pointer('pointercancel', 1000, 800)) },
    notifyMode: (payload) => { modeListener?.(payload) },
  }
}

test('按下逐帧升到悬空，松手落回原样、不留尾巴', async () => {
  const app = await boot()
  try {
    app.press()
    // 第一帧必须**同步**就挂上：等一个定时器才出第一帧的话，按下的瞬间球是空的
    assert.equal(app.bodyHas('ball-lift-up-1'), true, '按下那一帧应当立刻出')
    assert.ok(app.bodyHas('ball-lift'), '动作期间要有总开关类（虹膜层与形变都指着它）')

    await wait(RISE_MS)
    assert.equal(app.bodyHas('ball-lift-up-6'), true, '按住一会儿之后应当停在"悬空"那帧')
    assert.deepEqual(app.liftClasses(), ['ball-lift-up-6'], '同时只该挂一帧')

    app.release()
    await wait(FALL_MS)
    assert.deepEqual(app.liftClasses(), [], '落回之后一帧都不该留着')
    assert.equal(app.bodyHas('ball-lift'), false, '总开关也要摘掉，否则虹膜层一直藏着')
    assert.equal(app.bodyHas('ball-happy'), false, '被捏那张脸也要收（既有规矩：不留尾巴）')
    // 单击（指针没动）仍然算一次点击
    assert.equal(app.calls.length, 1, '一次点击应当请求一次展开')
    assert.equal(app.calls[0].mode, 'chat')
  } finally { app.window.close() }
})

test('按一下就松（普通单击）不留悬空的帧', async () => {
  const app = await boot()
  try {
    app.press()
    app.release()
    await wait(STEP_MS * 2)
    assert.deepEqual(app.liftClasses(), [], '还没升到顶就松手，应当立刻回原样')
  } finally { app.window.close() }
})

test('拖动那条路也要落回（endLift 必须在 dragging 那条 return 之前）', async () => {
  const app = await boot()
  try {
    app.press()
    app.move(1060, 830)          // 动了 60px：这是拖，不是点
    await wait(RISE_MS)
    assert.equal(app.bodyHas('ball-lift-up-6'), true, '拖动中也在播动作（"被拎着"跟着鼠标）')
    app.release(1060, 830)
    await wait(FALL_MS)
    assert.deepEqual(app.liftClasses(), [], '拖完松手也要落回')
    assert.equal(app.calls.length, 0, '拖过就不算点击，不该请求展开')
  } finally { app.window.close() }
})

test('指针被系统抢走（pointercancel）也要把动作收干净', async () => {
  const app = await boot()
  try {
    app.press()
    await wait(STEP_MS)
    app.cancel()
    await wait(FALL_MS)
    assert.deepEqual(app.liftClasses(), [], '取消之后不许留着一张悬空的脸')
  } finally { app.window.close() }
})

test('reduced-motion：一帧都不播，但仍然变脸', async () => {
  const app = await boot({ reducedMotion: true })
  try {
    app.press()
    await wait(RISE_MS)
    assert.deepEqual(app.liftClasses(), [],
      '系统要求减少动效时不播逐帧动画（常驻小球不能对着系统设置跳舞）')
    assert.equal(app.bodyHas('ball-happy'), true,
      '但要变脸 —— 这就是那张笑脸在 reduced-motion 下的职责，否则它成了死码')
  } finally { app.window.close() }
})

test('形态一变就把动作清干净（托盘/快捷键也能直接改形态）', async () => {
  // 为什么需要这条：展开/收起会让球藏起来或挪位置，而"悬空那张脸"是挂在 body 上的类。
  // 不清就会留到下一次回来 —— 用户看到的是"球一回来就摆着被拎的姿势"。
  const app = await boot()
  try {
    app.press()
    await wait(RISE_MS)
    assert.equal(app.bodyHas('ball-lift-up-6'), true, '前提：此刻确实停在悬空那帧')

    app.notifyMode({ mode: 'chat', side: 'left', anchorY: 'bottom', bubbleHeight: 560 })
    assert.deepEqual(app.liftClasses(), [], '换形态之后不该再挂着任何一帧')
    assert.equal(app.bodyHas('ball-lift'), false, '总开关也要摘掉')
  } finally { app.window.close() }
})
