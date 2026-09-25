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
 *
 * 最后一项是**「关闭悬浮球」**，它是这个菜单里唯一不碰 AI 的一项。三条取舍：
 * - 它是 `win.hide()`（收起来），**不是退出**。退出面板 / 退出并停止助手属于"退出"那一类，
 *   在托盘菜单里（`tray-menu.cjs` 把它们和"显示 / 展开"分隔开了），这里塞进来就把两类混了。
 * - 所以它**可逆**，而收回来的路（托盘图标）必须写在标签里——球藏起来以后任务栏没有它的位置
 *   （`setSkipTaskbar(true)`），不写清楚就成了"点一下它永远消失了"。
 * - **名单为空时它也必须在**：没配过联系人的人照样得有个办法把球收起来，否则这个菜单对他
 *   就是个只有两行灰字、什么也点不动的空框。
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

/**
 * 收起来那一项的标签。括号里那句**不是凑字数的**：球藏起来之后任务栏里没有它
 * （`setSkipTaskbar(true)`），不写出"托盘图标能再打开"，这一项看上去就像"永久关掉"。
 */
const CLOSE_LABEL = '关闭悬浮球（托盘图标能再打开）'

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
 * @param {{
 *   pick: (name: string) => void,
 *   close: () => void,
 * }} actions 选中了哪个人 / 选了"收起来"。
 *   关掉菜单这件事由调用方的 `popup({ callback })` 负责，这里不管。
 *
 * 两项都必填：少给一个就当场抛，而不是弹出一个点了没反应的菜单。
 */
function quickMenuTemplate(labels, actions) {
  if (typeof actions?.pick !== 'function') {
    throw new Error('quickMenuTemplate 需要一个 pick 回调')
  }
  if (typeof actions?.close !== 'function') {
    throw new Error('quickMenuTemplate 需要一个 close 回调')
  }
  const closeItem = { label: CLOSE_LABEL, click: () => actions.close() }
  const names = normalizeNames(labels)
  if (!names.length) {
    // 空名单也要给得出「关闭悬浮球」——见文件头那条取舍
    return [
      ...EMPTY_HINT.map(label => ({ label, enabled: false })),
      { type: 'separator' },
      closeItem,
    ]
  }
  return [
    ...names.map(name => ({ label: name, click: () => actions.pick(name) })),
    { type: 'separator' },
    // 代价那行紧挨着名单：它说的是"点上面那些人"的代价
    { label: COST_NOTE, enabled: false },
    { type: 'separator' },
    closeItem,
  ]
}

module.exports = { MAX_ITEMS, EMPTY_HINT, COST_NOTE, CLOSE_LABEL, normalizeNames, quickMenuTemplate }
