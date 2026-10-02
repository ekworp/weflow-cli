/**
 * 被拎起来时"左右晃"：**一按下就开始摆**（像挂在手里的挂件），拖动只决定**哪一侧摆得更大**。
 *
 * 2026-10-04 重做过一次。上一版是"按拖动速度给一个静态倾角、方向与拖动**相反**（被拎着的东西会向后滞）"，
 * 用户试完把要的东西说得更具体：「提起来的时候就开始左右晃动了，只不过往左边移动往左晃动的幅度更大，
 * 往右则是右边幅度大」。所以现在是**持续的正弦摆动 + 一个跟着移动方向走的偏心**（同向）。
 * 这条也顺手改掉了一个旧断言：**点击也摆** —— 点击本来就是"拎起来又放回去"，旧版"4px 之内不许晃"
 * 是照着上一版的机制写的，机制换了它就不成立了。
 *
 * 倾斜仍然是程序算的、绕球心转（旋转不改变像素到球心的距离，所以不占圆的余量），角度经 body 上的
 * `--dangle-deg` 交给 CSS。jsdom 里 CSS 不跑，所以这里验的是**那个自定义属性**，不是"看起来像不像被拎着"。
 *
 * 四条容易静默写错的：
 *   1. **按下就开始摆**：不必等拖过 4px 阈值（阈值只管"算不算点击"，不管动作）。
 *   2. **同向偏心**：往右拖，右边那一侧摆得更大、左边被压小（反过来验就往左拖）。这是本次的**主旨**，
 *      所以两条并排量：只断言其中一条，方向写反了也会绿。
 *   3. **松手、换形态都要停并回正**：只回正不停定时器，球会继续在零度附近抖着写属性。
 *   4. **少动效一点不摆**。
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
    deg: () => Number.parseFloat(window.document.body.style.getPropertyValue('--dangle-deg')) || 0,
    press: (x = 1000, y = 800) => ball.dispatchEvent(ev('pointerdown', x, y)),
    move: (x: number, y: number) => window.dispatchEvent(ev('pointermove', x, y)),
    release: (x = 1000, y = 800) => window.dispatchEvent(ev('pointerup', x, y)),
    notifyMode: (p: any) => modeListener?.(p),
  }
}

/** 在一段时间里连续采样：摆动是**随时间变**的，只看一个瞬间的值等于测运气。 */
async function sampleDeg(app: Awaited<ReturnType<typeof boot>>, ms: number) {
  const out: number[] = []
  const until = Date.now() + ms
  while (Date.now() < until) {
    out.push(app.deg())
    await wait(20)
  }
  return out
}

/** 往一个方向拖 60px，采**一个完整摆动周期**，返回上下两个极值。
 *
 *  必须是整周期：正弦的正峰在 ~225ms、负峰在 ~675ms。只看前 300ms 的话，负峰压根不在窗口里 ——
 *  实测过，那样连"偏心衰减短到只影响前半摆"这种坏法都拦不住（变异检查绿了）。 */
async function drag(dir: 1 | -1) {
  const app = await boot()
  try {
    app.press()
    await wait(12)                                          // 留一点真实时间，速度才不是无穷大
    app.move(1000 + 60 * dir, 800)
    const vals = await sampleDeg(app, 950)
    return { max: Math.max(...vals), min: Math.min(...vals) }
  } finally { app.window.close() }
}

test('一按下就开始摆（不必先拖）', async () => {
  const app = await boot()
  try {
    app.press()
    const vals = await sampleDeg(app, 120)
    assert.ok(vals.some((v) => Math.abs(v) > 0.5), `按下不动也该晃，实测 ${vals.join(', ')}`)
  } finally { app.window.close() }
})

test('同向偏心：往哪边拖，哪一边就摆得更大（同侧 ~21°，对侧被压到 ~3°）', async () => {
  const right = await drag(1)
  const left = await drag(-1)
  // 摆动本身是 ±12°；偏心把它抬到 12+9=21° 那一侧、压到 12−9=3° 那一侧。
  // 四条都要断言：往右那两条若只留一条，往左那半边（也就是"往左移动往左幅度大"）就没人看着了。
  assert.ok(right.max > 15, `往右拖，右侧该摆过摆动本身（12°）——实测 ${right.max.toFixed(1)}`)
  assert.ok(right.min > -9, `往右拖，左侧该被压小到摆动本身以下——实测 ${right.min.toFixed(1)}`)
  assert.ok(left.min < -15, `往左拖，左侧该摆过摆动本身（12°）——实测 ${left.min.toFixed(1)}`)
  assert.ok(left.max < 9, `往左拖，右侧该被压小到摆动本身以下——实测 ${left.max.toFixed(1)}`)
})

test('松手后停下并回正（定时器不能漏着跑）', async () => {
  const app = await boot()
  try {
    app.press()
    await wait(12)
    app.move(1080, 800)
    await wait(60)
    app.release(1080, 800)
    await wait(30)
    const after = await sampleDeg(app, 200)
    assert.ok(Math.max(...after.map(Math.abs)) === 0, `松手后该一直是 0，实测 ${after.join(', ')}`)
  } finally { app.window.close() }
})

test('换形态也要停并回正（托盘/快捷键那条路）', async () => {
  const app = await boot()
  try {
    app.press()
    await wait(12)
    app.move(1080, 800)
    assert.ok(app.deg() !== 0, '前提：此刻有倾斜')
    app.notifyMode({ mode: 'ball', done: true, fadeMs: 0 })
    await wait(60)                                          // 给漏掉的定时器一次机会暴露自己
    const after = await sampleDeg(app, 120)
    assert.ok(Math.max(...after.map(Math.abs)) === 0, `换形态之后不该还歪着，实测 ${after.join(', ')}`)
  } finally { app.window.close() }
})

test('reduced-motion：一点不摆', async () => {
  const app = await boot({ reducedMotion: true })
  try {
    app.press()
    await wait(12)
    app.move(1080, 800)
    const vals = await sampleDeg(app, 120)
    assert.ok(Math.max(...vals.map(Math.abs)) === 0, `少动效时不该摆，实测 ${vals.join(', ')}`)
  } finally { app.window.close() }
})
