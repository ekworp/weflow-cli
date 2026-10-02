/**
 * 球的状态脸：**一次瞬时失败不许永久粘住**。
 *
 * 这条是被用户报出来的：他说"默认初始表情变了 —— 委屈、月亮眼睛"。查下来素材没动（与 git 逐字节
 * 一致）、真守护进程也健康（`channelActive: true` / quota 0/100 / aiConfigured: true），也就是说
 * **新开的窗口不会是委屈**。真因在代码：`offline` 只在状态拉取失败的 `catch` 里挂上，而成功那条
 * 路径**从不主动清它** —— 于是守护进程重启的那几十秒里拉不到状态、挂上委屈，之后再也回不来。
 *
 * 所以这里盯的是"恢复"：拉不到 → 委屈；能拉到了 → **必须自己收掉**。只测"失败会变委屈"是不够的，
 * 那半边本来就对。
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
      <button id="collapse" type="button" class="ghost" hidden>收起</button>
      <button id="memory" type="button" class="ghost">记忆</button></header>
    <main id="log"></main>
    <form id="composer"><textarea id="input"></textarea><button id="send">发送</button></form>
    <footer id="foot"></footer>
    <section id="memory-panel" hidden><div class="memhead"><span id="memory-note"></span>
      <button id="memory-close">关闭</button></div><div id="memory-list"></div></section>
    <div id="tail"></div>
  </div>
</body></html>`

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const OK_STATUS = { channelActive: true, quota: { used: 0, limit: 100 }, aiConfigured: true, memoryBucket: 'b', memoryNote: '', quickReplies: [] }

async function boot(opts: { statusFails?: boolean; overQuota?: boolean } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://127.0.0.1:8766/panel' })
  const { window } = dom
  const state: { fails: boolean; overQuota: boolean } = { fails: !!opts.statusFails, overQuota: !!opts.overQuota }
  const poll: { fn: null | (() => void) } = { fn: null }

  // 30 秒轮询太慢，这里把回调**接下来**手动触发 —— 那就是生产里那条路径
  window.setInterval = ((fn: any) => { poll.fn = fn; return 0 }) as any
  window.matchMedia = (q: string) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
  let release: (() => void) | null = null
  window.fetch = (async (url: any) => {
    if (String(url).includes('/api/status')) {
      if (state.fails) throw new Error('network down')
      const quota = state.overQuota ? { used: 100, limit: 100 } : OK_STATUS.quota
      return { ok: true, status: 200, json: async () => ({ ...OK_STATUS, quota }) }
    }
    if (String(url).includes('/api/ask')) {
      // **挂住不 resolve**：`busy` 是"正在答"，桩里立刻返回的话，等一个宏任务它就已经被
      // finally 收掉了 —— 断言"此刻正在答"根本来不及成立（第一版就是这么红的）。
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true, reply: '嗯' }) })
      })
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }) as any
  window.weflowPanel = {
    setMode: () => Promise.resolve({}), onCursor: () => {}, onMode: () => {},
    dragStart: () => Promise.resolve(), dragMove: () => Promise.resolve(), dragEnd: () => Promise.resolve(),
    info: () => Promise.resolve({}), quit: () => Promise.resolve(), openQuickMenu: () => Promise.resolve(null),
  }

  const script = window.document.createElement('script')
  script.textContent = RENDERER
  window.document.body.appendChild(script)
  await wait(0)
  await wait(0)
  return {
    window,
    state,
    poll: async () => { poll.fn?.(); for (let i = 0; i < 3; i++) await wait(0) },
    releaseAsk: () => { release?.() },
    bodyHas: (cls: string) => window.document.body.classList.contains(cls),
    statusText: () => (window.document.getElementById('status') as any).textContent,
  }
}

test('拉不到状态 → 委屈；恢复了 → **必须自己收掉**（这条就是用户报的那个 bug）', async () => {
  const app = await boot({ statusFails: true })
  try {
    assert.equal(app.bodyHas('offline'), true, '拉不到时该显示委屈')
    assert.equal(app.statusText(), '连不上本机入口')
    app.state.fails = false
    await app.poll()
    assert.equal(app.bodyHas('offline'), false,
      '状态恢复之后必须自己收掉——否则一次瞬时失败会把委屈那张脸永久粘在球上（实测就是这样）')
  } finally { app.window.close() }
})

test('超额 → 琥珀；不超额之后也要收掉', async () => {
  const app = await boot({ overQuota: true })
  try {
    await app.poll()
    assert.equal(app.bodyHas('quota'), true, '额度用尽要看得出来')
    app.state.overQuota = false
    await app.poll()
    assert.equal(app.bodyHas('quota'), false, '没超额之后不该还挂着它')
  } finally { app.window.close() }
})

test('正在答的时候，一次成功的状态轮询不许把 busy 收掉', async () => {
  const app = await boot()
  try {
    // 发一句，让轮次进行中（`ask` 一进来就挂 busy，结束的 finally 才收）
    const input = app.window.document.getElementById('input') as any
    input.value = '在吗'
    app.window.document.getElementById('composer')!.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }))
    await wait(0)
    assert.equal(app.bodyHas('busy'), true, '前提：此刻正在答')
    await app.poll()
    assert.equal(app.bodyHas('busy'), true, '状态轮询不许替 ask 收 busy（它由 finally 负责）')
    app.releaseAsk()
    for (let i = 0; i < 4; i++) await wait(0)
    for (let i = 0; i < 3; i++) await wait(0)
    assert.equal(app.bodyHas('busy'), false, '答完了该由 finally 收掉')
  } finally { app.window.close() }
})
