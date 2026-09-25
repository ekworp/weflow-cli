/**
 * 右键快速回复菜单的**内容**（`resources/panel/quick-menu.cjs`，纯模块）。
 *
 * 为什么拆出来测：菜单在真机上要"右键点出"才能看见，而 CI 里点不了。但**"有哪几项、点了
 * 各自该干什么"是我们的代码**——同 `tray-menu.cjs` 那套：把菜单内容做成纯数据 + 回调，
 * 这里把每个 `click` 真的调一遍。"两个 click 接反了"这种错，文本断言抓不到，这个抓得到。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL(join(process.cwd(), 'resources', 'panel', 'quick-menu.cjs')).href)
const { MAX_ITEMS, COST_NOTE, normalizeNames, quickMenuTemplate } = mod.default ?? mod

function recorder() {
  const picked: string[] = []
  return { picked, actions: { pick: (name: string) => { picked.push(name) } } }
}

test('菜单就是名单，每一项点了回的是它自己那个名字', () => {
  const { picked, actions } = recorder()
  const items = quickMenuTemplate(['咸鱼梦想家', '老王'], actions)
  const labels = items.filter((i: any) => i.click).map((i: any) => i.label)
  assert.deepEqual(labels, ['咸鱼梦想家', '老王'])
  for (const item of items) if (item.click) item.click()
  assert.deepEqual(picked, ['咸鱼梦想家', '老王'], '点的顺序就是回的名字')
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
  assert.equal(items[items.length - 2].type, 'separator')
})

test('名单为空时给两行说明（第二行是他可以直接抄的命令），且都不可点', () => {
  const { picked, actions } = recorder()
  const items = quickMenuTemplate([], actions)
  assert.equal(items.length, 2)
  for (const item of items) {
    assert.equal(item.enabled, false)
    assert.equal(item.click, undefined)
  }
  assert.equal(items[0].label, '还没配名单')
  assert.match(items[1].label, /quickReplyContacts/, '要把配置键的名字写出来')
  assert.deepEqual(picked, [])
})

test('脏名单要被规整：非字符串、空白、重复都丢掉', () => {
  assert.deepEqual(normalizeNames(['  甲  ', null, '甲', '', '  ', 42, '乙']), ['甲', '乙'])
  assert.deepEqual(normalizeNames(undefined), [], '不是数组就当空')
  assert.deepEqual(normalizeNames('甲'), [], '字符串不是数组')
})

test('名单再长也只列前 20 个（菜单不该被撑成一整屏）', () => {
  const many = Array.from({ length: 30 }, (_, i) => `联系人${i + 1}`)
  const items = quickMenuTemplate(many, recorder().actions)
  const labels = items.filter((i: any) => i.click).map((i: any) => i.label)
  assert.equal(labels.length, MAX_ITEMS)
  assert.equal(labels[0], '联系人1')
  assert.equal(labels[MAX_ITEMS - 1], `联系人${MAX_ITEMS}`)
})

test('缺 pick 回调就当场报错，而不是弹一个点了没反应的菜单', () => {
  assert.throws(() => quickMenuTemplate(['甲'], {} as any), /pick/)
})
