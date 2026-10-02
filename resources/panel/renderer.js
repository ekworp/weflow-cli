/**
 * 面板的渲染层。**这是整条链路上最不可信的一层**——它显示的东西来自助手的回复，
 * 而助手的回复里会有用户自己的聊天内容。所以两条死规矩：
 *
 * 1. **一律 `textContent`，绝不 `innerHTML`**。回复里出现 `<script>` 或 `<img onerror>` 之类的
 *    内容时，用 innerHTML 就等于在那个窗口里执行它。这个窗口没有地址栏，用户看不出被导航走了。
 * 2. **拿不到 token，也拿不到端口**：凭据在 `HttpOnly` cookie 里（脚本读不到），
 *    请求只发相对路径 `/api/...`。所以这个文件里不该出现任何凭据相关的东西。
 *
 * 页面本身由守护进程从回环端点递过来（`GET /panel`），CSP 走响应头：`default-src 'none'` +
 * `script-src 'self'`，所以也没有内联脚本、没有外部资源。
 */
'use strict'

const log = document.getElementById('log')
const input = document.getElementById('input')
const send = document.getElementById('send')
const statusEl = document.getElementById('status')
const foot = document.getElementById('foot')

const COPY_LABEL = '复制'
const COPIED_LABEL = '已复制'
const MANUAL_LABEL = '按 Ctrl+C'

/** 把节点内容全选上。用于剪贴板 API 用不了时的退路 */
function selectContents(node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * 助手回答下面的复制按钮。
 *
 * 为什么要有：起草回复那条路**只产出文本**——不碰微信窗口、不模拟按键（见 D-047），
 * 所以"把这几条候选拿到别处去用"这一步只能由用户自己做，那就得让他一键拿得走。
 * 它是**整条回答**的复制，不做"逐条候选分别复制"：候选是模型用自己的话重述过的，
 * 在客户端按行去猜哪行是候选，猜错就是把半句话复制走。
 *
 * 反馈必须落在按钮自己身上（窗口只有巴掌大，用户不会去看别处）。
 */
function addCopyButton(turn, textNode, text) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'copy'
  button.textContent = COPY_LABEL
  let timer = null
  const flash = (label) => {
    button.textContent = label
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { button.textContent = COPY_LABEL }, 1500)
  }
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text)
      flash(COPIED_LABEL)
    } catch {
      // 剪贴板 API 拿不到时**不许假装复制成功**：用户会以为剪贴板里有东西，粘出来
      // 是上一次的旧内容——那比什么都不做更坏。改成把这段选上，让他自己按 Ctrl+C。
      selectContents(textNode)
      flash(MANUAL_LABEL)
    }
  })
  turn.appendChild(button)
}

/** 把一条消息加进对话区。`who` 决定样式，**内容永远走 textContent** */
function addTurn(who, text) {
  const empty = log.querySelector('.empty')
  if (empty) empty.remove()      // 第一句话一来，开头那段提示就该让位
  const div = document.createElement('div')
  div.className = 'turn ' + who
  const body = document.createElement('div')
  body.className = 'turn-text'
  body.textContent = text
  div.appendChild(body)
  // 只有助手的回答带复制按钮：用户自己发的不用复制，"正在输入"没有内容可复制，
  // 错误提示也不该被粘到别处去。
  if (who === 'it') addCopyButton(div, body, text)
  log.appendChild(div)
  log.scrollTop = log.scrollHeight
  return div
}

/**
 * 把这一轮的**轨迹**折叠着挂在回答下面（服务端 `/api/ask` 一并给回来）。
 *
 * **默认折叠**是有意的：轨迹多数时候是"我查了什么"，摊开会把每次回答都变成一屏日志，
 * 而不想看的人还得滚过它。想核对"它到底查没查、查的是什么"的人点一下展开。
 * 内容与微信里发「轨迹」看到的是同一份（同一个格式函数），所以两处不会各说各话。
 *
 * 全用 `textContent`（不用 innerHTML）：轨迹里有工具参数，是**用户数据**。
 */
function addThinking(turn, trace) {
  const lines = trace && Array.isArray(trace.lines)
    ? trace.lines.filter((line) => typeof line === 'string' && line.trim()) : []
  const reasoning = trace && typeof trace.reasoning === 'string' ? trace.reasoning.trim() : ''
  if (!lines.length && !reasoning) return      // 没有轨迹就什么都不挂（不是显示一个空壳）
  const details = document.createElement('details')
  details.className = 'thinking'
  const summary = document.createElement('summary')
  summary.textContent = '思考过程'
  details.appendChild(summary)
  for (const line of lines) {
    const row = document.createElement('div')
    row.className = 'thinking-line'
    row.textContent = line
    details.appendChild(row)
  }
  if (reasoning) {
    const row = document.createElement('div')
    row.className = 'thinking-line thinking-reasoning'
    row.textContent = reasoning
    details.appendChild(row)
  }
  turn.appendChild(details)
}

/**
 * 还没聊过时的开头。**空白是这里最糟的状态**：第一次打开的人看到一整片黑，
 * 既不知道它能干什么，也看不出它是活的（下面没有正在输入之类的动静）。
 * 例子做成可点的按钮——点一下就是真的问一句，走的还是同一条提交路径。
 */
const EXAMPLES = [
  '我最近都在忙什么？',
  '总结我和某某的聊天',
  '收藏里有哪些 AI 文章？',
  '我最近都在读什么？',
  // 这条此前只藏在右键菜单里（"谁在等我回话"是那些一键功能之一），很多人不会去点右键。
  // 措辞与 `who_owes_reply` 的工具描述一致（"看看谁在等你回话"），所以路由是稳的 ——
  // 那个工具自己还带 confirm 闸门，问之前会先把代价说清楚。
  '谁在等我回话？',
]

function renderEmptyState() {
  if (log.children.length) return
  const box = document.createElement('div')
  box.className = 'empty'

  const title = document.createElement('div')
  title.className = 'empty-title'
  title.textContent = '直接问就行，我会查本机数据回答'
  box.appendChild(title)

  const sub = document.createElement('div')
  sub.className = 'empty-sub'
  sub.textContent = '聊天、收藏、公众号、微信读书、待办都在本机，数据库不出这台机器。'
  box.appendChild(sub)

  for (const example of EXAMPLES) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'chip'
    chip.textContent = example
    chip.addEventListener('click', () => {
      if (input.disabled) return          // 上一句还在飞的时候点了没用，就不该有反应
      input.value = example
      document.getElementById('composer').requestSubmit()
    })
    box.appendChild(chip)
  }
  log.appendChild(box)
}

/**
 * 球的**脸**跟着状态走（CSS 里 `body.busy/.offline/.quota #ball .face`）——
 * 2026-09-29 之前还有一层会变色/呼吸的光晕，按用户要求整层去掉了（见 panel.css 那段注释）。
 *
 * 集中在一个函数里改：之前这些类名散在 ask()/refreshStatus() 各处的话，
 * 迟早有一条分支忘了摘掉 `busy`，球就一直挂着那张脸——那种"看起来在忙其实没在忙"比不显示更糟。
 * 传进来的每一项都**整体替换**，不做增量。
 */
function setBallState(state) {
  document.body.classList.remove('busy', 'offline', 'quota')
  if (state) document.body.classList.add(state)
}

/** 服务端的状态码 → 一句人话。**别把 code 原样丢给用户** */
function explain(code, fallback) {
  switch (code) {
    case 'BUSY': return '上一句还在处理，等它说完再发。'
    case 'NOT_RUNNING': return '助手没在运行。在电脑上跑一次 `weflow-cli assistant start`。'
    case 'QUOTA_EXCEEDED': return '今天的额度用完了。'
    case 'TIMEOUT': return '这一轮太久没结束（它可能还在后台跑）。稍等一下再问。'
    case 'UNAUTHORIZED': return '凭据失效了。重新用 `weflow-cli panel` 打开这个窗口。'
    case 'ORIGIN_DENIED': return '这个来源被拒绝了。'
    default: return fallback || ('没成（' + code + '）')
  }
}

/** 已请求过几次自愈。成功会重载页面，这个计数自然归零 */
let repairTries = 0

/**
 * 凭据失效时请主进程换一张。
 *
 * **为什么需要它**：token 是守护进程每次启动新生成的，而窗口的 cookie 是打开那一刻种的。
 * 所以 `assistant stop/start` 之后，还开着的窗口手里是死凭据——`/api/status` 与**球的脸图**
 * （`Cache-Control: no-store`）一起 401，表现是**球变成空白**。2026-09-28 实测到：窗口比守护
 * 进程早 25 小时，用户看到的是"图标不见了"，而状态栏那句"凭据失效了"在球形态下根本没人看。
 *
 * 连试三次还不行就停手：**重载风暴比空白球更难排查**，剩下的交给状态栏那句话。
 */
async function requestRepair() {
  if (repairTries >= 3) return
  repairTries += 1
  try {
    const r = await weflowPanel.repair()
    if (r && r.ok) return                       // 主进程会重载页面，这里不用做别的
    if (r && r.code === 'DAEMON_DOWN') {
      statusEl.textContent = '助手没在运行。先在终端跑 weflow-cli assistant start。'
    }
  } catch {
    // 主进程没接上就算了这个（例如旧版 preload），状态栏那句话已经说了该做什么
  }
}

async function refreshStatus() {
  try {
    const res = await fetch('/api/status', { credentials: 'same-origin' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      statusEl.textContent = explain(body.code, '连接异常')
      // 只有**凭据过期**这一类能自愈；别的 401/403 重载多少次都一样
      if (body.code === 'UNAUTHORIZED') requestRepair()
      return
    }
    const s = await res.json()
    quickReplies = Array.isArray(s.quickReplies) ? s.quickReplies.filter(n => typeof n === 'string') : []
    const mode = s.channelActive ? '微信 + 本机' : '仅本机入口'
    statusEl.textContent = mode + '｜今日 ' + s.quota.used + '/' + s.quota.limit
    // 额度用尽是"今天不能再用"，值得在球上看得出来（琥珀），但**不是**错误。
    //
    // **而且必须显式收掉 `offline`。** 拉到状态这件事本身就说"连不上"结束了，而这条成功路径
    // 原先从不主动清它 —— 于是守护进程重启的那几十秒里页面拉不到状态、挂上那张"委屈"的脸，
    // 之后（守护进程早就回来了）再也回不来。实测症状：球一直是委屈，而状态条其实写着"微信 + 本机"。
    // 不动 `busy`（那是"正在答"，由 `ask` 的 finally 负责收）；没超额就恢复成没有状态脸。
    if (!document.body.classList.contains('busy')) {
      setBallState(s.quota.used >= s.quota.limit ? 'quota' : null)
    }

    // 记忆桶那句话说清"是不是同一个大脑"——这是用户最容易误解的地方
    foot.textContent = ''
    const line = document.createElement('div')
    line.textContent = s.memoryNote || ('记忆桶：' + s.memoryBucket)
    foot.appendChild(line)
    if (!s.aiConfigured) {
      const warn = document.createElement('div')
      warn.className = 'warn'
      warn.textContent = '还没配置 LLM：在电脑上跑 `weflow-cli config set deepseekApiKey "..."`'
      foot.appendChild(warn)
      input.disabled = true
      send.disabled = true
    }
  } catch {
    statusEl.textContent = '连不上本机入口'
    setBallState('offline')     // 暖色且停住流动：不动的东西才会被注意到
  }
}

/** 让助手给这个人起草一条回复。**只产文本**——发送在这条链路上结构性不可达。 */
function draftRequest(name) {
  return `用 draft_reply 给「${name}」起草 3 条候选回复，把候选原样列出来。只产文本，不要发送。`
}

/**
 * 问一句。`display` 用来把"用户看到的那句话"和"实际发出去的那句"分开：
 * 快速回复要发的是一句点名工具的请求（要模型选对工具），但那句话长得像机器指令，
 * 摆进对话里读起来不像人说的——所以对话里显示「快速回复：咸鱼梦想家」。
 */
async function ask(text, display = null) {
  addTurn('me', display || text)
  const pending = addTurn('it pending', '…')
  input.disabled = true
  send.disabled = true
  // 球收起来的时候，此前完全看不出它在干活——这是这条状态最主要的用处
  setBallState('busy')

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    })
    const body = await res.json().catch(() => ({}))
    pending.remove()

    if (res.ok && body.ok) {
      const turn = addTurn('it', body.reply)
      hopAfterTurn = true          // 答复成功：busy 收掉之后高兴一下
      addThinking(turn, body.trace)
      // 配额用尽时服务端回的是一句**回答**（不是错误），所以上面照常显示；
      // 这里只是把状态条上的数字刷新一下
      void refreshStatus()
      return
    }
    addTurn('err', explain(body.code, body.error))
  } catch {
    pending.remove()
    addTurn('err', '请求没发出去（助手进程可能刚停）。')
  } finally {
    input.disabled = false
    send.disabled = false
    setBallState(null)
    if (hopAfterTurn) {
      hopAfterTurn = false
      startHop()
    }
    void refreshStatus()      // 顺手把用量与配额状态刷新（额度用尽会换成琥珀色）
    input.focus()
  }
}

document.getElementById('composer').addEventListener('submit', (event) => {
  event.preventDefault()
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  void ask(text)
})

input.addEventListener('keydown', (event) => {
  // Enter 发送，Shift+Enter 换行
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    document.getElementById('composer').requestSubmit()
  }
})

// ---------------------------------------------------------------- 球 / 对话窗
//
// 只在**有外壳**（Electron）时才起小球：浏览器那条路（Edge `--app`）给不了无边框置顶的小球，
// 硬做只会做出一个奇怪的方窗口。所以这里靠 `window.weflowPanel` 在不在来判断，
// 而且这正是 preload 唯一暴露的东西——页面拿不到凭据，也不该拿得到。

const ball = document.getElementById('ball')
const collapse = document.getElementById('collapse')
const hasShell = typeof window.weflowPanel !== 'undefined'

/**
 * 右键"快速回复"的名单。来自 `/api/status`——页面本来每 30 秒就轮询那个端点，
 * 所以这份名单**不必再开一个入口**（面板那条路上不加新端点、不加 IPC）。
 */
let quickReplies = []

/**
 * 系统关了动画没有。**这一条只有渲染进程能问**（`prefers-reduced-motion` 是媒体查询，
 * 主进程那边没有等价 API），而窗口几何的补间在主进程、CSS 管不着——所以读出来的结果
 * 要随 `setMode` 带过去。
 *
 * `typeof` 那半不是客套：`matchMedia` 在 jsdom 里**根本不存在**（测试就是拿 jsdom 跑这个
 * 文件的），直接调会在加载时就抛。
 */
function prefersReducedMotion() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// ------------------------------------------------------- 眼珠跟着鼠标（2026-09-30）

/**
 * 鼠标位置来自**主进程**（`onCursor`），不是页面的 `mousemove`：球只有 96×96，鼠标绝大多数
 * 时间在窗口**外面**，渲染进程一个事件都收不到。
 *
 * 位移上限是**从美术上量出来的**，不是拍的（量法见提交信息里的脚本）：
 *   - 虹膜到左边那道深色描边只剩约 2.6px（球上），再往左就裂开一条白缝；
 *   - **向上几乎没有余量**（上面就是眼皮），向下宽一些；
 *   - 所以夹的是一个**椭圆**，不是一个圆 —— 横向 2.6、向上 0.8、向下 2.6。
 *
 * 常量按**球的 96px** 写；球尺寸将来变了，下面按实测宽度等比缩放，不用回来改这些数。
 */
const IRIS_MAX_X = 2.6
const IRIS_MAX_UP = 0.8
const IRIS_MAX_DOWN = 2.6
const IRIS_EASE = 0.18      // 每帧逼近目标的比例（一阶低通）
const IRIS_FAR = 260        // 鼠标远过这个距离就当"看向最边上"，不再加分
const IRIS_EPS = 0.02       // 到位判定（球上像素）

let cursorTarget = null     // 鼠标的屏幕坐标；null = 还不知道它在哪
let irisX = 0
let irisY = 0
let irisRaf = null

/** 球心在屏幕上的位置。载荷是 DIP、`getBoundingClientRect` 也是 DIP，所以可以直接相减。 */
function ballCenterOnScreen() {
  const rect = ball.getBoundingClientRect()
  return {
    x: window.screenX + rect.left + rect.width / 2,
    y: window.screenY + rect.top + rect.height / 2,
  }
}

/** 往目标挪一帧。返回"还在动吗"——不动了外层就把 rAF 停掉。 */
function stepIris() {
  const size = ball.offsetWidth || 96
  const k = size / 96
  let tx = 0
  let ty = 0
  if (cursorTarget && !prefersReducedMotion()) {
    const center = ballCenterOnScreen()
    const dx = cursorTarget.x - center.x
    const dy = cursorTarget.y - center.y
    const dist = Math.hypot(dx, dy) || 1
    const strength = Math.min(1, dist / (IRIS_FAR * k))   // 远处饱和：屏幕另一头也是"看那边"
    const ux = (dx / dist) * strength
    const uy = (dy / dist) * strength
    tx = ux * IRIS_MAX_X * k
    ty = uy * (uy < 0 ? IRIS_MAX_UP : IRIS_MAX_DOWN) * k
  }
  irisX += (tx - irisX) * IRIS_EASE
  irisY += (ty - irisY) * IRIS_EASE
  const done = Math.abs(irisX - tx) < IRIS_EPS && Math.abs(irisY - ty) < IRIS_EPS
  if (done) {
    irisX = tx
    irisY = ty
  }
  const iris = ball.querySelector('.iris')
  if (iris) iris.style.transform = `translate(${irisX.toFixed(2)}px, ${irisY.toFixed(2)}px)`
  return !done
}

/**
 * **静止就停 rAF**。一直跑 60fps 写 transform 会让合成器一直忙——那是为装饰付的电，
 * 不值得（这个窗口是常驻的）。所以：鼠标动了才起循环，到位就停，下一次推送再起。
 */
function pumpIris() {
  if (irisRaf !== null) return
  if (typeof requestAnimationFrame !== 'function') return
  irisRaf = requestAnimationFrame(() => {
    irisRaf = null
    if (stepIris()) pumpIris()
  })
}

if (hasShell && window.weflowPanel && typeof window.weflowPanel.onCursor === 'function') {
  window.weflowPanel.onCursor((point) => {
    cursorTarget = point
    pumpIris()
  })
}

/** 气泡方位相关的类，每次切形态先全摘掉再按主进程说的挂上 */
const LAYOUT_CLASSES = ['bubble-left', 'bubble-right', 'anchor-top']

/**
 * 半隐相关的类：`ball-peek` 换成探头那张脸（并去掉球的圆角，好让那条直切边落在屏幕边上），
 * `ball-peek-right` 再把图水平镜像一次给右边用。
 *
 * 贴哪条边只有主进程知道（它才管窗口位置），所以这一组**和形态一样是主进程说了算**，
 * 页面只照着挂。同样先整体摘掉再按说的挂——散着写迟早有一条分支忘了摘。
 */
const PEEK_CLASSES = ['ball-peek', 'ball-peek-right']

/**
 * 按主进程说的形态切 class。**这里是唯一改形态的地方**。
 *
 * 载荷带方位：`side` 是气泡在球的哪一边（球就在窗口的另一边），`anchorY` 是球贴窗口的
 * 上边还是下边（气泡跟着它竖着对齐），`bubbleHeight` 是气泡该有多高——**屏幕不够高时
 * 气泡会变矮**，那是为了让球待在窗口的角上不动（见 `ball-position.cjs` 的 `bubbleLayout`）。
 *
 * 页面自己算不出这些：它不知道自己在屏幕上的位置，也不知道工作区多大。
 */

// ---------------------------------------------- 被拎起来那一下（2026-10-02）
//
// 按下球时它像被拎住后颈提起来，松手落回。**六帧硬切，不做淡入** —— 理由同上面那张笑脸：
// 换帧本来就是一帧的事，淡入反而像"图片正在加载"。
//
// 为什么整套动作都待在渲染进程里：它不需要主进程知道任何事。加一条 IPC 就得动
// preload 的方法表（那份表被测试逐行钉死）与三处测试替身，代价远大于收益。
//
// 帧图**必须在页面加载时就全部预取**：从守护进程取一张脸实测约 15ms（≈60Hz 一帧），
// 按下那一刻才开始取，第一帧就是空的 —— 那正是当初"点一下会闪一下"的成因。
  // 12 帧：6 帧拎起来 + 6 帧落回去（再加静止帧，共 13 个状态）。
  // 每帧 60ms：半边 360ms，全程约 0.7 秒 —— 比 5 帧那版慢一点，但帧多了之后观感反而更连贯。
  const LIFT_STEP_MS = 60
  const LIFT_RISE = [1, 2, 3, 4, 5, 6].map((n) => 'ball-lift-up-' + n)
  const LIFT_FALL = [1, 2, 3, 4, 5, 6].map((n) => 'ball-lift-down-' + n)
  const LIFT_CLASSES = LIFT_RISE.concat(LIFT_FALL)
  let liftTimer = null
let liftAtPeak = false

/** 换帧的**唯一入口**：五个类先清干净再加一个。散着写迟早有一条分支忘了摘，
 *  球就一直停在半空那张脸上（同 setBallState / setBallFace 的理由）。 */
function showLift(name) {
  for (const cls of LIFT_CLASSES) document.body.classList.remove(cls)
  document.body.classList.toggle('ball-lift', !!name)
  if (name) document.body.classList.add(name)
}

function stopLift() {
  if (liftTimer !== null) {
    clearTimeout(liftTimer)
    liftTimer = null
  }
}

/** 按下：第一帧同步出（不留空档），其后逐帧走到悬空停住。 */
function startLift() {
  stopLift()
  liftAtPeak = false
  showLift(LIFT_RISE[0])
  let i = 1
  const step = () => {
    if (i >= LIFT_RISE.length) {
      liftAtPeak = true
      liftTimer = null
      return
    }
    showLift(LIFT_RISE[i])
    i += 1
    liftTimer = setTimeout(step, LIFT_STEP_MS)
  }
  liftTimer = setTimeout(step, LIFT_STEP_MS)
}

/** 松手：接着往下走完落地那几帧。**不留尾巴** —— 用户试过 900ms 的保留期，说像卡住了。
 *  还没升到顶就松手（一次普通点击）直接回原样：那时它本来也没离开地面多远。 */
function endLift() {
    settleDangle()
  stopLift()
  if (!liftAtPeak) {
    showLift(null)
    return
  }
  let i = 0
  const step = () => {
    if (i >= LIFT_FALL.length) {
      showLift(null)
      liftTimer = null
      return
    }
    showLift(LIFT_FALL[i])
    i += 1
    liftTimer = setTimeout(step, LIFT_STEP_MS)
  }
  step()
}

/** 什么时候**不**播：系统要求减少动态效果时只留那张被捏的脸；球半隐在屏幕边时，
 *  第一次点击的含义是"回来"（主进程那条 reveal 是异步的，此刻窗口还贴着边）。 */
function canPlayLift() {
  return !prefersReducedMotion() && !document.body.classList.contains('ball-peek')
}

  // ---------------------------------------------- 挠痒痒（2026-10-02）
  //
  // 鼠标在球身上晃过 = 挠它。**分工**：生图的 4 帧只负责表情与爪子的小动作，**倾斜由这里算**，
  // 幅度跟着移动快慢走、停下 260ms 回正 —— 固定帧做不出"挠得越狠扭得越厉害"。
  //
  // 倾斜是**绕球心**旋转：球是圆形裁切的，绕圆心转的每个像素到圆心的距离不变，所以耳朵不会
  // 被转出圆外裁掉（平移会，旋转不会）。默认 transform-origin 就是 50% 50%，正合这个前提。
  const TICKLE_FRAMES = [1, 2, 3, 4].map((n) => 'ball-tickle-' + n)
  const TICKLE_STEP_MS = 110      // 换姿势的间隔（比动作帧慢：挠痒痒是持续的小扭，不是急抖）
  const TICKLE_DECAY_MS = 260     // 停止移动多久后回正
  const TICKLE_MAX_DEG = 4        // 最大倾斜角
  const TICKLE_FULL_SPEED = 900   // 每秒移动多少像素算"挠得最狠"
  let tickleTimer = null
  let tickleSettle = null
  let tickleIndex = 0
  let tickleDir = 1
  let tickleLastX = 0
  let tickleLastY = 0
  let tickleLastT = 0

  /** 换姿势的**唯一入口**（同 showLift / setBallFace 的理由：散着写迟早有一条分支忘了摘）。 */
  function showTickleFrame(name) {
    for (const cls of TICKLE_FRAMES) document.body.classList.remove(cls)
    document.body.classList.toggle('ball-tickle', !!name)
    if (name) document.body.classList.add(name)
  }

  /** 回正：清帧、清角度、清定时器。**按下**与**换形态**都会调它（见下面两处）。 */
  function settleTickle() {
    if (tickleTimer !== null) {
      clearTimeout(tickleTimer)
      tickleTimer = null
    }
    if (tickleSettle !== null) {
      clearTimeout(tickleSettle)
      tickleSettle = null
    }
    tickleIndex = 0
    document.body.style.setProperty('--tickle-deg', '0deg')
    showTickleFrame(null)
  }

  /** 什么时候**不**挠：系统要求少动效；球半隐在屏幕边（那张图有一条直切边，转一下就露缝）；
   *  正在被拎起来（那是更强的交互，先按下的那个赢）。 */
  function canTickle() {
    return !prefersReducedMotion()
      && !document.body.classList.contains('ball-peek')
      && !document.body.classList.contains('ball-lift')
  }

  /** 在球身上移动一次：按水平方向给倾斜、按速度给幅度，并推进姿势帧。 */
  function onTickleMove(event) {
    if (!canTickle()) return
    const now = typeof performance === 'object' && performance.now ? performance.now() : Date.now()
    const dx = event.screenX - tickleLastX
    const dy = event.screenY - tickleLastY
    const dt = Math.max(1, now - tickleLastT)        // 除以 0 会把速度算成无穷大
    tickleLastX = event.screenX
    tickleLastY = event.screenY
    tickleLastT = now
    const speed = Math.hypot(dx, dy) / dt * 1000
    const amp = Math.min(1, speed / TICKLE_FULL_SPEED)
    if (Math.abs(dx) >= 1) tickleDir = dx > 0 ? -1 : 1   // 往哪边推，就往反方向倒
    document.body.style.setProperty('--tickle-deg', (tickleDir * amp * TICKLE_MAX_DEG).toFixed(2) + 'deg')
    if (!document.body.classList.contains('ball-tickle')) {
      tickleIndex = 0
      showTickleFrame(TICKLE_FRAMES[0])
    }
    if (tickleTimer === null) {
      const step = () => {
        tickleIndex = (tickleIndex + 1) % TICKLE_FRAMES.length
        showTickleFrame(TICKLE_FRAMES[tickleIndex])
        tickleTimer = setTimeout(step, TICKLE_STEP_MS)
      }
      tickleTimer = setTimeout(step, TICKLE_STEP_MS)
    }
    if (tickleSettle !== null) clearTimeout(tickleSettle)
    tickleSettle = setTimeout(() => {
      tickleSettle = null
      settleTickle()
    }, TICKLE_DECAY_MS)
  }

function applyMode(payload) {
  // 形态一变就把动作清干净：托盘与全局快捷键都能直接改形态，停在第 3 帧上等它回来
  // 就是一张"永远悬在半空"的脸。这里只清类与定时器，形态本身仍由下面那段决定。
  stopLift()
  showLift(null)
  settleTickle()
  closeMemory()
  settleDangle()
  const mode = payload && payload.mode === 'ball' ? 'ball' : 'chat'
  const side = payload && payload.side === 'right' ? 'right' : 'left'
  // **只摆锚、不切形态**（`anchorOnly`）：展开分两步走，见 `main.cjs` 里"先摆锚、等页面
  // 画完、再改窗口尺寸"那段。切形态会连带把气泡显出来，而那会儿窗口还是 96px ——
  // 气泡恰好盖住球。所以第一步只动 `LAYOUT_CLASSES`。
  const anchorOnly = !!(payload && payload.anchorOnly)
  document.body.classList.remove(
    ...(anchorOnly ? LAYOUT_CLASSES : ['mode-ball', 'mode-chat', 'closing', ...LAYOUT_CLASSES]))
  // 半隐与"锚"无关，所以 `anchorOnly` 那一步（展开的两个阶段）不许把它摘掉
  if (!anchorOnly) {
    document.body.classList.remove(...PEEK_CLASSES)
    if (mode === 'ball' && payload && payload.peek) {
      document.body.classList.add('ball-peek')
      if (payload.peek === 'right') document.body.classList.add('ball-peek-right')
    }
  }
  if (!anchorOnly) document.body.classList.add(mode === 'chat' ? 'mode-chat' : 'mode-ball')
  if (mode === 'chat') {
    document.body.classList.add(side === 'right' ? 'bubble-right' : 'bubble-left')
    if (payload && payload.anchorY === 'top') document.body.classList.add('anchor-top')
    const height = Number(payload && payload.bubbleHeight)
    document.body.style.setProperty('--bubble-height',
      `${Number.isFinite(height) && height > 0 ? Math.round(height) : 560}px`)
    if (!anchorOnly) input.focus()
  }
}

/**
 * 请主进程换形态。**页面自己不先换 class**：从前这条路是页面直接 `classList.replace`，
 * 而托盘那条走的是 `panel:mode`，两条路行为不一样（一边球瞬间消失、一边等主进程）。
 * 现在形态只有主进程一个来源，页面照着 `panel:mode` 做，展开与收起于是必然对称。
 */
function requestMode(mode) {
  void window.weflowPanel.setMode(mode, { animate: !prefersReducedMotion() })
}

/**
 * 点球 = 开关：站着就展开、展开了就收起。**球全程不消失**——它是"在说话的那个图标"，
 * 让它先撤下去再冒出个窗口，就是用户嫌的那股突兀劲。
 */
function toggleMode() {
  requestMode(document.body.classList.contains('mode-chat') ? 'ball' : 'chat')
}

// **这一段必须在顶层。** 函数声明在块里是**块作用域**，而 `applyMode`（它要在换形态时收起这一层）
// 是顶层函数 —— 放进 `if (hasShell) { … }` 里，`applyMode` 调 `closeMemory()` 就会抛
// `ReferenceError: closeMemory is not defined`。同一个坑在这份文件里已经栽过两次（上一次是
// "被拎起来"那块），所以这行说明留在这儿。
// ------------------------------------------------------- 看它在记什么（2026-10-03）
//
// 只读视图：它记了什么、什么时候记的、从哪句话来的。**这一份不经过模型** —— 面板那条路由
// 只把数据交出来，页面只负责渲染；模型看到的是另外一份（带预算与脱敏）。
//
// 渲染一律 textContent + createElement：记忆里存的是**用户聊天里的话**，用 innerHTML 就等于
// 在那个窗口里执行它（这是本仓库最硬的一条纪律，测试盯着）。
const memoryButton = document.getElementById('memory')
const memoryPanel = document.getElementById('memory-panel')
const memoryList = document.getElementById('memory-list')
const memoryNote = document.getElementById('memory-note')

function closeMemory() {
  if (memoryPanel) memoryPanel.hidden = true
}

function memoryLine(text, className) {
  const p = document.createElement('p')
  if (className) p.className = className
  p.textContent = text
  return p
}

async function openMemory() {
  if (!memoryPanel || !memoryList || !memoryNote) return
  memoryPanel.hidden = false
  memoryList.replaceChildren()
  memoryNote.textContent = '读取中…'
  try {
    const res = await fetch('/api/memory', { headers: { accept: 'application/json' } })
    const data = await res.json()
    if (!res.ok || !data || data.ok !== true) throw new Error('bad response')
    const facts = Array.isArray(data.facts) ? data.facts : []
    const nodes = []
    if (!facts.length) {
      nodes.push(memoryLine('还没有长期记忆 —— 它只在值得记的时候才写（每 6 轮看一次）。', 'muted'))
    }
    for (const fact of facts.slice().reverse()) {
      const item = document.createElement('article')
      item.className = 'fact'
      item.append(memoryLine(String(fact.content ?? '')))
      const when = Number(fact.ts) ? new Date(Number(fact.ts)).toLocaleString() : '时间未知'
      const quote = String(fact.sourceQuote ?? '').trim()
      item.append(memoryLine(quote ? `${when} · 来自「${quote.slice(0, 40)}」` : when, 'muted'))
      nodes.push(item)
    }
    memoryList.replaceChildren(...nodes)
    const notes = [`长期事实 ${facts.length} 条`]
    if (Number(data.workingTurns) > 0) notes.push(`工作窗口 ${data.workingTurns} 条`)
    if (data.summary) notes.push(`滚动摘要 ${String(data.summary).length} 字`)
    if (data.saveError) notes.push(`⚠ 上次保存失败：${data.saveError}`)
    memoryNote.textContent = notes.join(' · ')
  } catch {
    memoryList.replaceChildren(memoryLine('读不到记忆（守护进程重启过的话，窗口里的凭据就过期了）', 'muted'))
    memoryNote.textContent = ''
  }
}

if (memoryButton) memoryButton.addEventListener('click', () => { void openMemory() })
const memoryClose = document.getElementById('memory-close')
if (memoryClose) memoryClose.addEventListener('click', closeMemory)

  // ------------------------------------------ 拖着走的时候"垂着晃"（2026-10-04）
  //
  // 按住会播"被拎起来"，但**拖着移动**时它是僵的。这里按拖动速度给一个倾斜，方向与拖动相反
  // （被拎着走的东西会向后滞一下），和挠痒同一套：绕球心转、纯程序算、不占圆的余量。
  //
  // 角度经 body 上的自定义属性交给 CSS（`body.ball-lift #ball` 那条读它）—— 与 `--tickle-deg`
  // 同一个理由：自定义属性会继承，顶层的 applyMode 也能清。
  const DANGLE_MAX_DEG = 14         // **品味值，不是预算**：绕球心转不占圆的余量，想大就大
  const DANGLE_FULL_SPEED = 450      // 每秒拖多少像素算"甩得最狠"（700 太快，正常拖动只晃出一两度）
  let dangleLastX = 0
  let dangleLastY = 0
  let dangleLastT = 0
  let dangleDir = 1

  function setDangle(deg) {
    document.body.style.setProperty('--dangle-deg', deg.toFixed(2) + 'deg')
  }

  /** 松手/换形态时回正。 */
  function settleDangle() {
    dangleDir = 1
    setDangle(0)
  }

  /** 按下时记下起点：不然第一次移动的 dt 会是"上次拖动到这次"的间隔，算出来的速度没意义。 */
  function startDangle(x, y) {
    dangleLastX = x
    dangleLastY = y
    dangleLastT = typeof performance === 'object' && performance.now ? performance.now() : Date.now()
  }

  /** 拖动的每一次移动：按水平速度给倾斜（往哪边拖，就往反方向滞）。 */
  function trackDangle(event) {
    if (prefersReducedMotion()) return
    const now = typeof performance === 'object' && performance.now ? performance.now() : Date.now()
    const dx = event.screenX - dangleLastX
    const dy = event.screenY - dangleLastY
    const dt = Math.max(1, now - dangleLastT)
    dangleLastX = event.screenX
    dangleLastY = event.screenY
    dangleLastT = now
    const speed = Math.hypot(dx, dy) / dt * 1000
    const amp = Math.min(1, speed / DANGLE_FULL_SPEED)
    if (Math.abs(dx) >= 1) dangleDir = dx > 0 ? -1 : 1
    setDangle(dangleDir * amp * DANGLE_MAX_DEG)
  }

  // ------------------------------------------ 答完了"高兴一下"（2026-10-04）
  //
  // 球收起来时看不出"它答完了"：busy 那张脸管的是"正在答"，这半边一直空着。
  //
  // **没有生图帧，是刻意的**：模型画"蹲下去"一定会把身体压扁（实测轮廓 +9.2% / +8.0%，换个轻一点的
  // 措辞也一样），连着放就是 270 毫秒里胖瘦四回。而跳本来就只是位移 —— 跳起来的是那只猫，它没变形。
  // 所以：位移 + 轻微缩放 + 复用现有的眯眼笑脸（`mascot-happy.png`）。
  //
  // 位移的余量是算出来的：静止帧内容到球心 125.25、圆半径 128，所以空中那步缩到 0.96（内容 → 120.2）
  // 之后才抬得起那 7 像素（120.2 + 7 = 127.2 < 128）。改这几个数之前先把这条算式重算一遍。
  const HOP_STEPS = [
    { y: -7, scale: 0.96, ms: 95 },
    { y: -2, scale: 0.985, ms: 95 },
    { y: 0, scale: 1, ms: 110 },
  ]
  let hopTimer = null
  let hopAfterTurn = false

  function showHop(step) {
    document.body.classList.toggle('ball-hop', !!step)
    document.body.classList.toggle('ball-hop-happy', !!step)
    if (step) {
      document.body.style.setProperty('--hop-y', step.y + 'px')
      document.body.style.setProperty('--hop-scale', String(step.scale))
    } else {
      document.body.style.setProperty('--hop-y', '0px')
      document.body.style.setProperty('--hop-scale', '1')
    }
  }

  function stopHop() {
    if (hopTimer !== null) {
      clearTimeout(hopTimer)
      hopTimer = null
    }
    showHop(null)
  }

  /** 答复成功、且不忙了之后才播（失败时球不该跳）。 */
  function startHop() {
    if (prefersReducedMotion()) return
    stopHop()
    let i = 0
    const step = () => {
      if (i >= HOP_STEPS.length) {
        showHop(null)
        hopTimer = null
        return
      }
      showHop(HOP_STEPS[i])
      const ms = HOP_STEPS[i].ms
      i += 1
      hopTimer = setTimeout(step, ms)
    }
    step()
  }

  // ------------------------------------------ 偶尔眨一下眼（2026-10-04）
  //
  // **只在"没有别的脸在场"时播**：busy/offline/quota 那三张脸的眼睛是画死的，半隐那张是另一幅构图，
  // 正在被拎着/挠着/跳着时也不该眨。间隔随机（7-13 秒），否则像节拍器。
  //
  // 这 2 帧**眼睛以外与静止帧逐像素相同**（归一化时由 `panel_frames.py` 只把眼睛带贴回来），所以
  // 必须藏虹膜层 —— 否则会看到一层睁着的瞳孔浮在闭着的眼皮上。
  const BLINK_FRAMES = [1, 2].map((n) => 'ball-blink-' + n)
  const BLINK_MS = [70, 110]
  const BLINK_MIN_MS = 7000
  const BLINK_MAX_MS = 13000
  let blinkTimer = null
  let blinkStepTimer = null

  function showBlinkFrame(name) {
    for (const cls of BLINK_FRAMES) document.body.classList.remove(cls)
    document.body.classList.toggle('ball-blink', !!name)
    if (name) document.body.classList.add(name)
  }

  /** 什么时候**不**眨眼：少动效、页面不可见、有别的脸/别的动作在场。 */
  function canBlink() {
    if (prefersReducedMotion()) return false
    if (typeof document.hidden === 'boolean' && document.hidden) return false
    for (const cls of ['busy', 'offline', 'quota', 'ball-happy', 'ball-peek',
                       'ball-lift', 'ball-tickle', 'ball-hop']) {
      if (document.body.classList.contains(cls)) return false
    }
    return true
  }

  function blinkOnce() {
    if (!canBlink()) return
    showBlinkFrame(BLINK_FRAMES[0])
    blinkStepTimer = setTimeout(() => {
      showBlinkFrame(BLINK_FRAMES[1])
      blinkStepTimer = setTimeout(() => {
        showBlinkFrame(null)
        blinkStepTimer = null
      }, BLINK_MS[1])
    }, BLINK_MS[0])
  }

  function scheduleBlink() {
    if (blinkTimer !== null) clearTimeout(blinkTimer)
    const wait = BLINK_MIN_MS + Math.floor(Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS))
    blinkTimer = setTimeout(() => {
      blinkOnce()
      scheduleBlink()
    }, wait)
  }

if (hasShell) {
  // `shell` 这个类决定球在不在场（见 panel.css）：浏览器降级那条路永远不该看见球

  document.body.classList.add('shell', 'mode-ball')
  // **四张脸先取回来。**（2026-09-29 加的，用户报"点一下会闪一下"）
  //
  // 这些脸是 CSS 背景图，**什么时候用什么时候才去取**；而实测从守护进程取一张要
  // **~15 毫秒**（60Hz 一帧是 16.7ms，正好一帧）。所以按下球的那一刻才开始取，第一帧
  // 就是空的——看起来就是"闪一下"。仓库里那句老注释写过同一个症状
  // （"球在按下的一瞬间会闪成一张空图"），当时的结论是静态白名单一张都不能漏；
  // 现在白名单是对的，但**第一次用到仍然要等那一趟网络**。预取把它挪到页面刚加载时，
  // 那时没人盯着球看。
  //
  // 放在 `hasShell` 里面：浏览器降级那条路根本不显示球，没必要替它取。
  // **动作帧也要在这里预取。** 按下才开始取的话，第一帧就是空的（见下面那段的说明）。
  for (const face of ['mascot.png', 'mascot-happy.png', 'mascot-thinking.png',
                      'mascot-sorry.png', 'mascot-tired.png',
                      'mascot-lift-up-1.png', 'mascot-lift-up-2.png', 'mascot-lift-up-3.png', 'mascot-lift-up-4.png', 'mascot-lift-up-5.png', 'mascot-lift-up-6.png',
                      'mascot-lift-down-1.png', 'mascot-lift-down-2.png', 'mascot-lift-down-3.png', 'mascot-lift-down-4.png', 'mascot-lift-down-5.png', 'mascot-lift-down-6.png',
                      'mascot-tickle-1.png', 'mascot-tickle-2.png', 'mascot-tickle-3.png', 'mascot-tickle-4.png',
                      'mascot-blink-1.png', 'mascot-blink-2.png']) {
    const img = new Image()
    img.src = '/panel/' + face
  }
  ball.hidden = false
  collapse.hidden = false

  // 球：**点一下展开，按住拖动挪位置**。
  //
  // 为什么不用 `-webkit-app-region: drag`：Windows 上拖拽区会**吞掉鼠标事件**，
  // 页面根本收不到 click——现象就是"点这个图标没反应"（实测的故障）。
  // 所以拖拽自己实现：按下时告诉主进程记住窗口与指针位置，移动时按差值挪窗口；
  // 松手时如果**指针几乎没动**，那就是一次点击。
  // 阈值 4 像素：手抖不会把点击变成拖动，而想拖的人自然会移过 4 像素。
  /** 被捏一下的表情。**只有一个入口**（同 `setBallState` 的理由：散着写迟早有一条分支
   *  忘了摘，球就一直是那张笑脸）。
   *
   *  **按住是笑脸，一松手立刻变回来。** 第一版松手后还留 900ms，想的是"一次点击只闪
   *  十几毫秒，不留就看不见"——用户试过之后说那个延迟很别扭：手指松开了表情还挂着，
   *  像是卡在那儿。所以不留了。
   */
  function setBallFace(happy) {
    document.body.classList.toggle('ball-happy', happy)
  }

  const DRAG_THRESHOLD_PX = 4
  // 挠痒痒：只在球身上移动时才扭（停下由 onTickleMove 里的回正定时器负责）
  ball.addEventListener('pointermove', onTickleMove)

  ball.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    setBallFace(true)
    if (canPlayLift()) startLift()
    settleTickle()                       // 按下了就先别扭了，动作帧优先
    const startX = event.screenX
    const startY = event.screenY
    let dragging = false
    startDangle(startX, startY)

    const onMove = (moveEvent) => {
      if (!dragging && Math.hypot(moveEvent.screenX - startX, moveEvent.screenY - startY) > DRAG_THRESHOLD_PX) {
        dragging = true
      }
      if (dragging) {
        void window.weflowPanel.dragMove(moveEvent.screenX, moveEvent.screenY)
        trackDangle(moveEvent)
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      void window.weflowPanel.dragEnd()
      setBallFace(false)
      endLift()
      if (dragging) return                 // 拖过了就不算点击
      toggleMode()
    }
    // 指针被系统抢走（触摸、原生菜单弹出）时不走 onUp，必须自己把脸收回来，否则球一直笑着
    const onCancel = () => {
      setBallFace(false)
      endLift()
    }
    void window.weflowPanel.dragStart(startX, startY)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  })
  // 右键：快速回复。**只在有外壳时接管**——浏览器降级那条路的原生菜单里有"复制"，
  // 那是用户要用的，不该被我们抢掉。
  //
  // 有外壳时用**主进程弹的原生菜单**：它画在窗口外面，所以球形态那 96x96 的窗口
  // **不用先展开**（页内菜单会被窗口裁掉）。上一版就是"先展开再弹"，用户看到的是
  // "点右键把第二大脑窗口弹出来了"——那不是快速功能该有的样子。
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    void (async () => {
      const picked = await window.weflowPanel.openQuickMenu(quickReplies)
      if (!picked || typeof picked !== 'object') return
      // 选中任何一项都要展开：球那个 96x96 里看不到任何回答，而这几项全都要出文字。
      // 但**右键本身不动窗口**（那是用户嫌的那一下）——展开只发生在真的选了东西之后。
      if (document.body.classList.contains('mode-ball')) requestMode('chat')
      if (picked.kind === 'contact' && typeof picked.name === 'string' && picked.name.trim()) {
        const name = picked.name.trim()
        void ask(draftRequest(name), `快速回复：${name}`)
        return
      }
      if (picked.kind === 'action' && typeof picked.prompt === 'string' && picked.prompt.trim()) {
        // 话术**由菜单项带过来**，页面不自己按 id 查表——两份映射会漂移，而漂移的后果是
        // "菜单写着甲、点下去做了乙"，不报错。
        void ask(picked.prompt, String(picked.label || '快捷功能'))
      }
    })()
  })
  // 这里原来挂着两条 `closeQuickMenu()`（点了别处关菜单、Esc 关菜单）——**那是页内菜单时代的
  // 旧址**：菜单现在是**原生**的（`openQuickMenu` 由主进程弹，画在窗口外面），没有"页内菜单"
  // 可关，而 `closeQuickMenu` 这个函数**在文件里根本没有定义**。
  // 后果是：点面板里任何地方、或按 Esc，都会抛一次未捕获的 ReferenceError（不致命，
  // 但测试里 jsdom 会把它报出来，控制台也一直脏）。按"没有页内菜单"这个事实删掉。

  collapse.addEventListener('click', () => { requestMode('ball') })

  // 形态由主进程说了算（球、收起、托盘菜单、快捷键都是这条路），收起分两步：
  //   `fadeMs > 0` → 先把气泡淡掉（窗口这会儿还是大的，淡出真看得见），**不换形态**；
  //   `done` → 主进程已经把窗口缩回球那么大，这时才把气泡摘掉。
  // 顺序不能反：提前换，96x96 的窗口里会露出一条气泡的边；不换，气泡会一直在。
  window.weflowPanel.onMode((payload) => {
    if (payload && payload.mode === 'ball' && !payload.done) {
      if (payload.fadeMs > 0 && document.body.classList.contains('mode-chat')) {
        document.body.classList.add('closing')
        return
      }
      applyMode(payload)
      return
    }
    applyMode(payload)
  })
} else {
  // 浏览器降级：把话说清，别让用户以为悬浮球坏了
  const note = document.createElement('div')
  note.className = 'warn'
  note.textContent = '这是浏览器窗口（没有 Electron）：给不了悬浮球、托盘和全局快捷键。'
    + '想要真·悬浮球，在电脑上跑 npm i -g electron 之后再执行 weflow-cli panel。'
  foot.appendChild(note)
}

renderEmptyState()
if (hasShell) scheduleBlink()
void refreshStatus()
// 每 30 秒刷一次状态：守护进程可能被停掉，界面不该一直显示旧数字
setInterval(refreshStatus, 30000)
// 球形态下不抢焦点（抢了会把用户正在打字的窗口顶掉）
if (!hasShell || !document.body.classList.contains('mode-ball')) input.focus()
