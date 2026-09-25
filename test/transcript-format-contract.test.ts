/**
 * 转录那一行的**跨语言契约**：同一批消息，TS 侧与 Python 侧必须渲染出**逐字相同**的行。
 *
 * 为什么值得一条专门的测试：这一行的形状有两份实现，分别服务两条入口——
 * `assistantTools.ts` 的 `transcriptLine`（面板/微信那条路，遮罩后走 `--stdin`）与
 * `reply_debt.format_line`（`draft_reply.py --talker`，命令行那条路自己读库）。同一段对话
 * 走不同入口进来，喂给判断与起草的文本必须是一样的。
 *
 * 它们**已经漂过三处**（实测，不是推测）：时刻 `9/23 12:20` vs `09-23 12:20`、
 * 对方那句写死「对方」vs 用人名、截断 160 vs 120。其中任何一处都不会报错——
 * 最坏的是「我」那个标记：脚本靠 `'] 我：'` 挑语气样本、`lastFromMe` 判最后一条，
 * 改错一个字全都静默失效。所以这里不比"看起来对"，比的是**两边逐字相等**。
 *
 * 一处**没进这条测试**的差别：非文本消息的显示形态由读取层写在 `parsedContent` 里
 * （实测本机一条会话：文本 26/26、图片 13/13、系统消息 1/1 都带这个字段），而 Python 自己
 * 读库那条路在它为空时另有一份 `TYPE_LABELS` 兜底。所以只有"读取层没给出形态"时两边才会不同，
 * 而那种输入在真实路径上**没有观察到**——这里的用例都带上 `parsedContent`，走的正是真实形态。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { configService } from '../src/services/configService.js'
import { getPythonCommand } from '../src/utils/python.js'
import { transcriptLine, TRANSCRIPT_MESSAGES, TRANSCRIPT_MSG_CHARS } from '../src/services/assistantTools.js'

const DRAFT_SOURCE = readFileSync(join(process.cwd(), 'scripts', 'draft_reply.py'), 'utf8')
const DEBT_SOURCE = readFileSync(join(process.cwd(), 'scripts', 'reply_debt.py'), 'utf8')

/**
 * 同一批消息喂给两边。覆盖：只有 wxid 的、我发的、带人名的非文本、超长、群聊里的第三个人。
 *
 * `senderUsername` 一律带上是**故意的**：它是消息表里的 wxid 原列，谁把它当标签用，
 * 这一行就会把账号标识喂给云端模型。这里的断言要求它**一个都不许出现在行里**。
 */
const FIXTURES: any[] = [
  { createTime: 1_758_600_000, isSend: false, senderUsername: 'wxid_w', localType: 1,
    parsedContent: '那个文件你什么时候发我' },
  { createTime: 1_758_600_600, isSend: true, senderUsername: '我', localType: 1,
    parsedContent: '今天下午' },
  // 非文本：标签由读取层写好（真实路径就是这样）
  { createTime: 1_758_601_200, isSend: false, senderDisplay: '老王', senderUsername: 'wxid_w',
    localType: 3, parsedContent: '[文件] Base.csv' },
  // 超长：两边的**截断长度**必须一致，否则同一句话在两个入口里长短不一
  { createTime: 1_758_601_800, isSend: false, senderDisplay: '老王', senderUsername: 'wxid_w',
    localType: 1, parsedContent: '长'.repeat(300) },
  // 群聊里的第三个人：标签是发言人的名字，不是「对方」
  { createTime: 1_758_602_400, isSend: false, senderDisplay: '小李', senderUsername: 'wxid_z',
    localType: 1, parsedContent: '我也在等' },
]

const PYTHON = `
import sys, json
sys.path.insert(0, sys.argv[1])
from reply_debt import format_line
payload = json.loads(sys.stdin.read())
print(json.dumps([format_line(m, payload['maxChars']) for m in payload['messages']], ensure_ascii=False))
`

test('两边喂给模型的对话是同一段：条数与每条字数', () => {
  // **这两条不能靠下面那条比出来**：下面按"两边同一个数"去比，所以两边一起改成 120 也算相等。
  // 而 120 是 `reply_debt` 自己的口径（欠账雷达 state 的大小），起草那条路必须用 160——
  // 混了它，同一句话在面板里和命令行里就会长短不一。
  const inPython = Number(/^DRAFT_MSG_CHARS = (\d+)/m.exec(DRAFT_SOURCE)?.[1])
  assert.ok(Number.isInteger(inPython), '没读到 scripts/draft_reply.py 的 DRAFT_MSG_CHARS')
  assert.equal(TRANSCRIPT_MSG_CHARS, inPython,
    'TS 的 TRANSCRIPT_MSG_CHARS 必须等于 Python 起草那条路的 DRAFT_MSG_CHARS')
  // 静态断言：起草那条路**真的用了**这个常量，而不是退回 `format_line` 的默认值（120）。
  // 真验它要跑一次 `--talker`（读真库），所以在测试里只能这样盯——把参数去掉这条就红。
  assert.match(DRAFT_SOURCE, /format_line\(m, DRAFT_MSG_CHARS\)/,
    '起草读库那条路要用 DRAFT_MSG_CHARS 渲染，否则它悄悄按 120 截')

  // 条数也得同值：一个是"多长的一段对话"，一个是"每条多长"。两边今天都是 30，
  // 但在这之前谁都没盯着——一边改成 20 的话，同一段对话在两条入口里就是不同的输入。
  const pythonSize = Number(/^TRANSCRIPT_SIZE = (\d+)/m.exec(DEBT_SOURCE)?.[1])
  assert.ok(Number.isInteger(pythonSize), '没读到 scripts/reply_debt.py 的 TRANSCRIPT_SIZE')
  assert.equal(TRANSCRIPT_MESSAGES, pythonSize,
    'TS 的 TRANSCRIPT_MESSAGES 必须等于 Python 的 TRANSCRIPT_SIZE')
})

test('同一批消息：TS 与 Python 渲染出的转录逐字相同', () => {
  // 正文要过 `privacyGate`，而 strict 会改写正文（那是另一条边界，不是这里的形状）。
  // 所以钉成 balanced——两条路在这个模式下都只改链接形状，不改这句话本身。
  const realGet = configService.get.bind(configService)
  ;(configService as any).get = (key: string) => (key === 'assistantPrivacy' ? 'balanced' : realGet(key))
  let python: string[]
  let ours: string[]
  try {
    ours = FIXTURES.map(transcriptLine)
    // 交给 Python 的截断长度取**它自己那个常量**，不是 TS 的：这样"两边改成不同的数"
    // 才会显形（拿 TS 的值喂过去，两边就永远一样，测了个寂寞）。
    const pythonChars = Number(/^DRAFT_MSG_CHARS = (\d+)/m.exec(DRAFT_SOURCE)![1])
    const result = spawnSync(getPythonCommand(), ['-c', PYTHON, join(process.cwd(), 'scripts')], {
      input: JSON.stringify({ maxChars: pythonChars, messages: FIXTURES }),
      encoding: 'utf8',
      // 这个变量 `pythonBridge` 会给每个子进程设（见 `createPythonProcessEnv`）；
      // 手写探针漏了它就会拿到 GBK 字节、看到并不存在的乱码
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    assert.equal(result.status, 0, result.stderr || '')
    python = JSON.parse(result.stdout)
  } finally {
    ;(configService as any).get = realGet
  }

  assert.equal(python.length, ours.length)
  for (let i = 0; i < ours.length; i += 1) {
    assert.equal(python[i], ours[i],
      `第 ${i + 1} 条两边渲染不一样——这一行的形状有两份实现，改一处就要改另一处：`
      + `\n  TS    : ${ours[i]}\n  Python: ${python[i]}`)
  }
  // 两边一起错也能过上面那条，所以再把几条最要紧的性质单独钉一遍
  assert.match(ours[0], /^\[\d{2}-\d{2} \d{2}:\d{2}\] 对方：那个文件你什么时候发我$/,
    '没有解析出来的名字时写「对方」，时刻是 09-23 12:20 这种零填充形状')
  assert.match(ours[1], /\] 我：今天下午$/, '「我」这个标记是脚本挑语气样本用的，形状不许变')
  assert.match(ours[2], /\] 老王：\[文件\] Base\.csv$/, '有名字就用名字')
  assert.match(ours[4], /\] 小李：我也在等$/, '群聊里对方是**发言人的人名**，不是写死「对方」')
  assert.equal((ours[3].match(/长/g) || []).length, TRANSCRIPT_MSG_CHARS,
    `超长那条按 ${TRANSCRIPT_MSG_CHARS} 字截断（Python 侧必须传同一个数）`)
  assert.match(ours[3], /…$/, '截断了要留记号，否则半句话看起来像说完了')
  for (const line of ours) {
    assert.doesNotMatch(line, /wxid/, '**这一行里不许出现 wxid**：它是账号标识，而这段文本要出境')
  }
})
