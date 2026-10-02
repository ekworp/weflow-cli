/**
 * 面板"它记住了什么"：只读视图，**并且必须把记忆当成文本渲染**。
 *
 * 为什么这条值得单独一个文件：记忆里存的是**用户聊天里的话**（`sourceQuote` 就是原句），
 * 而这个窗口是没有地址栏的。用 `innerHTML` 渲染它，等于让"某人在微信里发过的一句话"在那个
 * 窗口里执行（`renderer.js` 的头部把这条列为本仓库最硬的纪律之一，`panel-packaging` 也在盯）。
 * 所以下面那条注入探针是这份测试的重点：一个长得像标签的记忆，必须原样显示成字。
 *
 * jsdom 里 CSS 不跑，所以这里验的是"点了按钮之后 DOM 里有什么"，不是"看起来怎么样"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'

const RENDERER = readFileSync(join(process.cwd(), 'resources', 'panel', 'renderer.js'), 'utf8')

/** 一个长得像标签的记忆 —— 它必须原样显示成字（这也是记忆最可能的形态：别人发过什么） */
const NASTY = '<img src=x onerror="window.__pwned=true">'
const MEMORY = {
  ok: true,
  bucket: 'wxid_me',
  facts: [
    { content: '喜欢喝美式', ts: 1750000000000, sourceQuote: '我平时喝美式' },
    { content: NASTY, ts: 1750000001000, sourceQuote: '' },
  ],
  summary: '聊过天气与咖啡',
  workingTurns: 2,
  saveError: '',
}

const HTML = `<!doctype html><html><body>
  <button id="ball" hidden><span class="face"></span><span class="iris"></span></button>
  <div id="bubble">
    <header>
      <span class="brand">第二大脑</span>
      <span id="status" class="status">连接中…</span>
      <button id="collapse" type="button" class="ghost" hidden>收起</button>
      <button id="memory" type="button" class="ghost">记忆</button>
    </header>
    <main id="log"></main>
    <form id="composer"><textarea id="input"></textarea><button id="send">发送</button></form>
    <footer id="foot"></footer>
    <section id="memory-panel" hidden>
      <div class="memhead">
        <span class="brand">它记住了什么</span>
        <span id="memory-note" class="status"></span>
        <button id="memory-close" type="button" class="ghost">关闭</button>
      </div>
      <div id="memory-list" class="memlist"></div>
    </section>
    <div id="tail" aria-hidden="true"></div>
  </div>
</body></html>`

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function boot(opts: { memoryFails?: boolean } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://127.0.0.1:8766/panel' })
  const { window } = dom
  let modeListener: ((payload: any) => void) | null = null

  window.setInterval = () => 0
  window.matchMedia = (query: string) => ({
    matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  })
  window.fetch = (async (url: any) => {
    if (String(url).includes('/api/memory')) {
      if (opts.memoryFails) return { ok: false, status: 500, json: async () => ({ ok: false }) }
      return { ok: true, status: 200, json: async () => MEMORY }
    }
    return { ok: true, status: 200, json: async () => ({ channelActive: false, quota: { used: 0, limit: 100 } }) }
  }) as any
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

  return {
    window,
    panel: () => window.document.getElementById('memory-panel') as any,
    list: () => window.document.getElementById('memory-list') as any,
    note: () => window.document.getElementById('memory-note') as any,
    clickMemory: () => (window.document.getElementById('memory') as any)
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    clickClose: () => (window.document.getElementById('memory-close') as any)
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    notifyMode: (payload: any) => { modeListener?.(payload) },
  }
}

test('点"记忆"才拉一次，列出事实，并且把记忆当**文本**渲染', async () => {
  const app = await boot()
  try {
    assert.equal(app.panel().hidden, true, '默认不显示')
    app.clickMemory()
    await wait(20)
    assert.equal(app.panel().hidden, false, '点开之后要显示')
    const text = app.list().textContent
    assert.ok(text.includes('喜欢喝美式'), `列表里要有那条事实，实际：${text.slice(0, 80)}`)
    // **注入探针**：记忆里那条长得像标签的，必须是字，不能变成元素
    assert.equal((app.window as any).__pwned, undefined, '没有被执行')
    assert.equal(app.list().querySelector('img'), null, '标签没有被解析成元素')
    assert.ok(text.includes('<img src=x'), '它应当原样显示出来')
    // 状态行报清家底：条数、工作窗口
    assert.ok(app.note().textContent.includes('长期事实 2 条'), `状态行：${app.note().textContent}`)
    assert.ok(app.note().textContent.includes('工作窗口 2 条'))
    // 来源那句也要露出来（用户才审得动"它凭什么这么记"）
    assert.ok(text.includes('来自「我平时喝美式」'), '要显示它是从哪句话来的')
  } finally { app.window.close() }
})

test('读不到记忆时给一句人话，而不是一片空白', async () => {
  const app = await boot({ memoryFails: true })
  try {
    app.clickMemory()
    await wait(20)
    assert.equal(app.panel().hidden, false, '读失败也要把面板打开，否则用户不知道为什么没反应')
    assert.ok(app.list().textContent.includes('读不到记忆'), `实际：${app.list().textContent}`)
  } finally { app.window.close() }
})

test('"关闭"收起它；换形态（展开/收起）也收起它', async () => {
  const app = await boot()
  try {
    app.clickMemory()
    await wait(20)
    assert.equal(app.panel().hidden, false)
    app.clickClose()
    assert.equal(app.panel().hidden, true, '点关闭要收起来')

    app.clickMemory()
    await wait(20)
    assert.equal(app.panel().hidden, false)
    app.notifyMode({ mode: 'ball', done: true, fadeMs: 0 })
    assert.equal(app.panel().hidden, true, '换形态之后它不该还盖在对话上')
  } finally { app.window.close() }
})
