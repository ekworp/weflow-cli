/**
 * 右键"快速回复"菜单的**内容**：纯数据 + 回调，不 require electron。
 *
 * 为什么单独一个文件：菜单里的点击在 CI 里点不了，但**"有哪几项、点了各自该干什么"是我们的代码**，
 * 而 `Menu.buildFromTemplate` + `popup` 那一步才是 Electron 的。拆开之后这个函数能被测试直接
 * require 进来、把每个 `click` 真的调一遍——比拿正则去匹配源码文本结实得多（同 `tray-menu.cjs`）。
 *
 * **为什么球形态下用原生菜单而不是页内那个**：原生菜单画在**窗口外面**，所以球那 76x76 的
 * 窗口不用先展开成对话窗——用户的原话是"右键应该算是快速功能"，而"顺手把窗口弹出来"恰好
 * 是他要避免的那一下。页内菜单留给浏览器降级那条路（那条路没有 Electron，也就没有原生菜单，
 * 而它的窗口是正常的浏览器窗，画得下）。
 *
 * 一条不能松的语义：**代价写在菜单里**（"起草会把这段对话发给两个云端模型"）。
 * 点一下就 = 一次出境，这件事必须在菜单里看得见，而不是点完才知道。
 */
'use strict'

/** 菜单最多列几个人。窗口小、名单可能很长，超出部分不该把菜单撑成一整屏 */
const MAX_ITEMS = 20

/** 名单为空时菜单显示的两行：说清没配，并给出该跑的那条命令 */
const EMPTY_HINT = [
  '还没配名单',
  'weflow-cli config set quickReplyContacts "某人,另一人"',
]

/** 代价那一行。**不可点**：它是说明，不是按钮 */
const COST_NOTE = '起草会把这段对话发给两个云端模型（只产出文本，不会替你发送）'

/** 把名单规整成菜单项用的数组：只要非空字符串、去重、有上限 */
function normalizeNames(labels) {
  const seen = new Set()
  const names = []
  for (const raw of Array.isArray(labels) ? labels : []) {
    if (typeof raw !== 'string') continue
    const name = raw.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
    if (names.length >= MAX_ITEMS) break
  }
  return names
}

/**
 * @param {unknown} labels 名单（联系人名）
 * @param {{pick: (name: string) => void}} actions 选中了哪个人。
 *   关掉菜单这件事由调用方的 `popup({ callback })` 负责，这里不管。
 */
function quickMenuTemplate(labels, actions) {
  if (typeof actions?.pick !== 'function') {
    throw new Error('quickMenuTemplate 需要一个 pick 回调')
  }
  const names = normalizeNames(labels)
  if (!names.length) {
    return EMPTY_HINT.map(label => ({ label, enabled: false }))
  }
  return [
    ...names.map(name => ({ label: name, click: () => actions.pick(name) })),
    { type: 'separator' },
    { label: COST_NOTE, enabled: false },
  ]
}

module.exports = { MAX_ITEMS, EMPTY_HINT, COST_NOTE, normalizeNames, quickMenuTemplate }
