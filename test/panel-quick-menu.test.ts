/**
 * 右键菜单的**内容**（`resources/panel/quick-menu.cjs`，纯模块）。
 *
 * 为什么拆出来测：菜单在真机上要"右键点出"才能看见，而 CI 里点不了。但**"有哪几项、点了
 * 各自该干什么"是我们的代码**——同 `tray-menu.cjs` 那套：把菜单内容做成纯数据 + 回调，
 * 这里把每个 `click` 真的调一遍。"两个 click 接反了"这种错，文本断言抓不到，这个抓得到。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL(join(process.cwd(), 'resources', 'panel', 'quick-menu.cjs')).href)
const { MAX_ITEMS, COST_NOTE, CLOSE_LABEL, normalizeNames, quickMenuTemplate } = mod.default ?? mod

/** 名单那几项（带 click、又不是"关闭悬浮球"那一项） */
const personItems = (items: any[]) => items.filter((i: any) => i.click && i.label !== CLOSE_LABEL)

function recorder() {
  const picked: string[] = []
  const calls: string[] = []
  return {
    picked,
    calls,
    actions: {
      pick: (name: string) => { picked.push(name); calls.push(`pick:${name}`) },
      close: () => { calls.push('close') },
    },
  }
}

test('名单那几项点了各自回自己那个名字', () => {
  const { picked, calls, actions } = recorder()
  const items = quickMenuTemplate(['咸鱼梦想家', '老王'], actions)
  assert.deepEqual(personItems(items).map((i: any) => i.label), ['咸鱼梦想家', '老王'])
  for (const item of personItems(items)) item.click()
  assert.deepEqual(picked, ['咸鱼梦想家', '老王'], '点的顺序就是回的名字')
  assert.deepEqual(calls, ['pick:咸鱼梦想家', 'pick:老王'])
})

test('代价那行写在菜单里，而且**不可点**（它是说明，不是按钮）', () => {
  // 点一下 = 一次出境。这件事必须在菜单里看得见，而不是点完才知道。
  const { actions } = recorder()
  const items = quickMenuTemplate(['甲'], actions)
  const cost = items.find((i: any) => i.label === COST_NOTE)
  assert.ok(cost, '菜单里要有代价那行')
  assert.equal(cost.enabled, false, '说明行不该能点')
  assert.equal(cost.click, undefined, '也不该带回调')
  assert.match(COST_NOTE, /两个云端模型/)
  assert.match(COST_NOTE, /不会替你发送/)
})

test('菜单项与代价之间有一条分隔线', () => {
  const { actions } = recorder()
  const items = quickMenuTemplate(['甲'], actions)
  assert.equal(items[1].type, 'separator', '名单之后、代价之前')
})

test('最后一项是「关闭悬浮球」，点了调 close 而不是 pick', () => {
  const { actions, calls, picked } = recorder()
  const items = quickMenuTemplate(['甲', '乙'], actions)
  assert.deepEqual(items.map((i: any) => i.label ?? `[${i.type}]`), [
    '甲', '乙', `[separator]`, COST_NOTE, `[separator]`, CLOSE_LABEL,
  ])
  const close = items[items.length - 1]
  assert.equal(close.enabled, undefined, '这一项要能点')
  close.click()
  assert.deepEqual(calls, ['close'], '点它绝不能当成交付一次起草')
  assert.deepEqual(picked, [], '也不该回任何联系人名')
})

test('「关闭悬浮球」的标签要写明它收得回来（从托盘）', () => {
  // 球藏起来之后任务栏没有它的位置（setSkipTaskbar）。不写出"从哪叫回来"，
  // 这一项对用户就是"点一下它永远消失了"。
  assert.match(CLOSE_LABEL, /托盘/, '要写出收回来靠托盘')
  assert.doesNotMatch(CLOSE_LABEL, /退出/, '"收起来"与"退出"是两件事，别用同一个词')
})

test('名单为空时也给得出「关闭悬浮球」——这个菜单不能变成点什么都没用的空框', () => {
  const { actions, calls, picked } = recorder()
  const items = quickMenuTemplate([], actions)
  assert.equal(items.length, 4, '两行说明 + 分隔线 + 关闭')
  assert.equal(items[0].label, '还没配名单')
  assert.match(items[1].label, /quickReplyContacts/, '要把配置键的名字写出来')
  for (const item of items.slice(0, 2)) {
    assert.equal(item.enabled, false)
    assert.equal(item.click, undefined)
  }
  assert.equal(items[2].type, 'separator')
  assert.equal(items[3].label, CLOSE_LABEL)
  for (const item of items) if (item.click) item.click()
  assert.deepEqual(calls, ['close'])
  assert.deepEqual(picked, [])
})

test('脏名单要被规整：非字符串、空白、重复都丢掉', () => {
  assert.deepEqual(normalizeNames(['  甲  ', null, '甲', '', '  ', 42, '乙']), ['甲', '乙'])
  assert.deepEqual(normalizeNames(undefined), [], '不是数组就当空')
  assert.deepEqual(normalizeNames('甲'), [], '字符串不是数组')
})

test('名单再长也只列前 20 个（菜单不该被撑成一整屏）', () => {
  const many = Array.from({ length: 30 }, (_, i) => `联系人${i + 1}`)
  const people = personItems(quickMenuTemplate(many, recorder().actions))
  assert.equal(people.length, MAX_ITEMS)
  assert.equal(people[0].label, '联系人1')
  assert.equal(people[MAX_ITEMS - 1].label, `联系人${MAX_ITEMS}`)
})

test('缺 pick 或 close 回调就当场报错，而不是弹一个点了没反应的菜单', () => {
  assert.throws(() => quickMenuTemplate(['甲'], {} as any), /pick/)
  assert.throws(() => quickMenuTemplate(['甲'], { pick: () => {} } as any), /close/)
})

test('菜单只有这一份：main.cjs 必须用这个模块，而不是自己再写一份', () => {
  const main = readFileSync(join(process.cwd(), 'resources', 'panel', 'main.cjs'), 'utf8')
  assert.match(main, /require\('\.\/quick-menu\.cjs'\)/, '要 require 这个模块')
  assert.match(main, /quickMenuTemplate\(/)
  // 两处实现早晚分叉。这两个标签只许在这个模块里出现一次。
  // **只查带引号的形式**：注释里提到它（说明这一项干什么）不算第二份实现——同 tray-menu 那条。
  for (const label of [CLOSE_LABEL, COST_NOTE]) {
    for (const quote of ["'", '"', '`']) {
      assert.equal(main.includes(`${quote}${label}${quote}`), false,
        `main.cjs 里不该再出现 ${quote}${label}${quote}`)
    }
  }
})

test('main.cjs 把「关闭悬浮球」接成了收起窗口，而且没有顺手退出', () => {
  // 这一项是纯主进程动作（不经过页面），所以只能在这里验接线：它调的是 hide，不是 quit。
  const main = readFileSync(join(process.cwd(), 'resources', 'panel', 'main.cjs'), 'utf8')
  const from = main.indexOf("ipcMain.handle('panel:quickMenu'")
  // 只取这一个 handler：后面 `panel:quit` 那个**本来就该**调 app.quit()，切到文件尾会误判
  const to = main.indexOf('ipcMain.handle(', from + 10)
  const handler = main.slice(from, to === -1 ? undefined : to)
  assert.match(handler, /close:\s*\(\)/, 'menu 模板要收到 close 这个动作')
  assert.match(handler, /win\.hide\(\)/, '收起 = win.hide()')
  assert.doesNotMatch(handler, /app\.quit\(\)/, '这一项不是"退出面板"——那是托盘菜单里的事')
})
