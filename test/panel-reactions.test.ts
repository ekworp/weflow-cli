/**
 * 两个"事件反应"：**答完了高兴一下**（跳）与**偶尔眨一下眼**。
 *
 * 为什么值得一层测试：
 *   - 跳只在**答复成功**时播 —— 失败时球不该跳，而"成功"与"失败"在代码里只差一个分支，
 *     写反了不会有任何东西红；
 *   - 眨眼是**定时器驱动的**，最容易出的错是"忘了判门"：在 busy/半隐/被拎着的时候眨，或者
 *     少动效时还眨。这些都不会报错，只会让球在错误的时机动一下。
 *
 * jsdom 里 CSS 不跑，所以这里验的是**类名与那两个自定义属性**，不是"看起来像不像跳"。
 * 眨眼那 2 帧的像素不变量在 `panel-lift-frames.test.ts` 里（眼睛带以外必须与静止帧逐像素相同）。
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

async function boot(opts: { reducedMotion?: boolean; askFails?: boolean } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://127.0.0.1:8766/panel' })
  const { window } = dom
  // setTimeout 全部**接下来手动推**：眨眼的间隔是 7-13 秒，真等没法测
  const timers: (() => void)[] = []
  const realTimeout = window.setTimeout.bind(window)
  // **jsdom 把页面报成 prerender**（`document.hidden === true`），而生产代码的门槛里就有
  // "页面不可见时不眨" —— 不声明成可见的话，眨眼在测试里**永远不会触发**，那几条断言就成了
  // 空断言（第一版正是这样："有别的脸在场时不眨"因为压根没眨而通过）。真实窗口是可见的。
  Object.defineProperty(window.document, 'hidden', { configurable: true, value: false })
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, value: 'visible' })
  window.setInterval = () => 0
  ;(window as any).setTimeout = ((fn: () => void) => { timers.push(fn); return timers.length }) as any
  window.matchMedia = (q: string) => ({
    matches: q.includes('prefers-reduced-motion') && opts.reducedMotion === true,
    media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  })
  window.fetch = (async (url: any) => {
    if (String(url).includes('/api/ask')) {
      if (opts.askFails) return { ok: false, status: 500, json: async () => ({ ok: false, code: 'INTERNAL' }) }
      return { ok: true, status: 200, json: async () => ({ ok: true, reply: '好了' }) }
    }
    return { ok: true, status: 200, json: async () => ({ channelActive: true, aiConfigured: true, quota: { used: 0, limit: 100 }, memoryBucket: 'b', quickReplies: [] }) }
  }) as any
  window.weflowPanel = {
    setMode: () => Promise.resolve({}), onCursor: () => {}, onMode: () => {},
    dragStart: () => Promise.resolve(), dragMove: () => Promise.resolve(), dragEnd: () => Promise.resolve(),
    info: () => Promise.resolve({}), quit: () => Promise.resolve(), openQuickMenu: () => Promise.resolve(null),
  }

  const script = window.document.createElement('script')
  script.textContent = RENDERER
  window.document.body.appendChild(script)
  // 让页面自己的真实定时器（这里的真 = 我们用 realTimeout）跑完加载那几件事
  await new Promise((r) => realTimeout(r, 0))
  await new Promise((r) => realTimeout(r, 0))

  return {
    window,
    /** 推进最多 n 个"被接下来的"定时器回调 */
    pump: async (n = 12) => {
      for (let i = 0; i < n && timers.length; i++) {
        const fn = timers.shift()!
        fn()
        await new Promise((r) => realTimeout(r, 0))
      }
    },
    /** 一直推到某个条件成立（或推完 n 个为止）—— "第一个回调未必是我要等的那个" */
    pumpUntil: async (done: () => boolean, n = 12) => {
      for (let i = 0; i < n && timers.length; i++) {
        if (done()) return true
        const fn = timers.shift()!
        fn()
        await new Promise((r) => realTimeout(r, 0))
      }
      return done()
    },
    bodyHas: (cls: string) => window.document.body.classList.contains(cls),
    hopY: () => window.document.body.style.getPropertyValue('--hop-y'),
    send: () => {
      const input = window.document.getElementById('input') as any
      input.value = '在吗'
      window.document.getElementById('composer')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    },
    wait: (ms: number) => wait(ms),
  }
}

test('答完了高兴一下：答复成功 → 跳一下，带位移与笑脸', async () => {
  const app = await boot()
  try {
    app.send()
    await app.wait(30)
    assert.equal(app.bodyHas('ball-hop'), true, '答完了该跳一下')
    assert.equal(app.bodyHas('ball-hop-happy'), true, '跳的时候是那张笑脸')
    assert.notEqual(app.hopY(), '0px', `该有位移，实际 ${app.hopY()}`)
    // 三步是**被接下来的**回调（为了让眨眼可控，setTimeout 全被接管了），所以要推它，不能干等
    await app.pump(6)
    assert.equal(app.bodyHas('ball-hop'), false, '跳完要收干净')
    assert.equal(app.hopY(), '0px', '位移要归零')
  } finally { app.window.close() }

})
test('答复失败时不跳（球不该为了失败高兴）', async () => {
  const app = await boot({ askFails: true })
  try {
    app.send()
    await app.wait(40)
    assert.equal(app.bodyHas('ball-hop'), false, '失败时不该跳')
  } finally { app.window.close() }
})

test('reduced-motion 时不跳', async () => {
  const app = await boot({ reducedMotion: true })
  try {
    app.send()
    await app.wait(40)
    assert.equal(app.bodyHas('ball-hop'), false, '少动效时不跳')
  } finally { app.window.close() }
})

test('眨眼：定时器到点 → 半闭再全闭，然后睁开；藏虹膜层', async () => {
  const app = await boot()
  try {
    assert.equal(app.bodyHas('ball-blink'), false, '刚加载时不该在眨')
    // 第一个被接下来的回调未必是眨眼的那个，所以推到它出现为止
    assert.ok(await app.pumpUntil(() => app.bodyHas('ball-blink-1')), '迟早该推第一次眨眼（半闭）')
    assert.equal(app.bodyHas('ball-blink'), true, '要挂总开关类（虹膜层指着它）')
    assert.ok(await app.pumpUntil(() => app.bodyHas('ball-blink-2')), '第二步该是全闭')
    assert.ok(await app.pumpUntil(() => !app.bodyHas('ball-blink')), '然后要睁开、收干净')
  } finally { app.window.close() }

})
test('有别的脸在场时不眨（这里用 busy）', async () => {
  const app = await boot()
  try {
    app.window.document.body.classList.add('busy')   // 页面在"正在答"时的真实类名
    await app.pump(1)
    assert.equal(app.bodyHas('ball-blink'), false, 'busy 那张脸的眼睛是画死的，不该在上面眨')
  } finally { app.window.close() }
})

test('reduced-motion：不眨', async () => {
  const app = await boot({ reducedMotion: true })
  try {
    await app.pump(3)
    assert.equal(app.bodyHas('ball-blink'), false, '少动效时不眨')
  } finally { app.window.close() }
})
