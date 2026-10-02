/**
 * 空状态里那几个"点一下就问"的示例按钮。
 *
 * 为什么值得单独一条：它们是面板上**唯一一处不用打字就能问出东西**的入口，而此前没有任何测试盯着
 * 它们（`panel-packaging` 只断言了"例子要做成按钮"那一句正则）。其中「谁在等我回话？」是用户
 * 2026-10-03 明确要的入口 —— 它此前只藏在右键菜单里，不去点右键就发现不了。
 *
 * 这里验的是"点了之后那句话真的发出去了"，不是"按钮在不在"：链路上只要断一环（chip 没绑事件、
 * 上一句还在飞时没拦住、`requestSubmit` 没触发），按钮照样在，而点了什么都不会发生。
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
    <header><span class="brand">第二大脑</span><span id="status" class="status"></span>
      <button id="collapse" type="button" class="ghost" hidden>收起</button>
      <button id="memory" type="button" class="ghost">记忆</button></header>
    <main id="log" aria-live="polite"></main>
    <form id="composer"><textarea id="input"></textarea><button id="send">发送</button></form>
    <footer id="foot"></footer>
    <section id="memory-panel" hidden><div class="memhead"><span id="memory-note"></span>
      <button id="memory-close">关闭</button></div><div id="memory-list"></div></section>
    <div id="tail"></div>
  </div>
</body></html>`

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function boot() {
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://127.0.0.1:8766/panel' })
  const { window } = dom
  const asked: string[] = []

  window.setInterval = () => 0
  window.matchMedia = (query: string) => ({
    matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  })
  window.fetch = (async (url: any, init: any) => {
    if (String(url).includes('/api/ask')) {
      asked.push(String(JSON.parse(String(init?.body ?? '{}')).text ?? ''))
      return { ok: true, status: 200, json: async () => ({ ok: true, status: 'replied', text: '嗯' }) }
    }
    if (String(url).includes('/api/memory')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, bucket: 'b', facts: [], summary: '', workingTurns: 0, saveError: '' }) }
    }
    // `aiConfigured` 必须在：有外壳时页面会按它决定要不要禁用输入框，缺了它输入框是禁用的，
      // 于是示例按钮的 `if (input.disabled) return` 会安静地什么都不做（第一版就是这么红的）
      return { ok: true, status: 200, json: async () => ({ channelActive: false, aiConfigured: true, quota: { used: 0, limit: 100 } }) }
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

  const chips = () => Array.from(window.document.querySelectorAll('.chip')) as any[]
  const chipWith = (text: string) => chips().find((c) => c.textContent === text) as any
  return {
    window,
    asked,
    chipTexts: () => chips().map((c) => c.textContent),
    chipWith,
    click: (el: any) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    input: () => window.document.getElementById('input') as any,
  }
}

test('「谁在等我回话？」在示例里，点一下就把这句话发出去', async () => {
  const app = await boot()
  try {
    assert.ok(app.chipTexts().includes('谁在等我回话？'),
      `示例里要有这一条，实际：${app.chipTexts().join(' / ')}`)
    app.click(app.chipWith('谁在等我回话？'))
    await wait(30)
    assert.deepEqual(app.asked, ['谁在等我回话？'],
      '点了之后那句话要真的发出去（按钮在、点了没反应，是这条要防的）')
  } finally { app.window.close() }
})

test('上一句还在飞的时候点示例不生效（按钮在也不该假装有反应）', async () => {
  const app = await boot()
  try {
    app.input().disabled = true
    app.click(app.chipWith('谁在等我回话？'))
    await wait(20)
    assert.deepEqual(app.asked, [], '输入框禁用时点示例不该发出任何东西')
  } finally { app.window.close() }
})
