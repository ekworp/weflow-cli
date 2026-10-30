/** 欠回复判断与草稿生成（会调用云端模型）。 */
import { join } from 'path'
import { chatService } from '../chatService.js'
import { runPythonJson } from '../pythonBridge.js'
import { privacyGate } from '../assistantPrivacy.js'
import { TRANSCRIPT_MESSAGES, transcriptLine } from './transcript.js'
import { boundedToolInteger, resolveTalker, fail, producedContent, INTENT_LABELS, ACTION_LABELS, zhLabel, riskLabel, confirmPreview } from './runtime.js'
import { TOOL_DEFS } from './registry.js'
import type { ToolContext } from './types.js'

export async function handleWhoOwesReply(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  // 谁在等我回话：逐会话问一次判断模型（较慢）。**不给正文**——真要看他写了什么，
  // 用 get_messages 单独查，那条路有完整的隐私处理。
  const days = boundedToolInteger(args.days, 14, 60, 'days')
  // 外部机器（MCP）默认只给预览：这个工具**每个会话一次判断调用**，每一次都带着那段聊天正文，
  // 是这条路上最贵也最"出境"的一个。预览走脚本自己的 --dry-run（只读本地、零出境）。
  if (ctx.requiresConfirm && args.confirm !== true) {
    const preview = await runPythonJson<any>('reply_debt.py',
      ['--days', String(days), '--dry-run', '--json'], { timeoutMs: 60_000 })
    if (!preview.ok || !preview.data?.success) {
      return `(预览失败：${String(preview.data?.error || preview.error || '未知').slice(0, 120)})`
    }
    const p = preview.data
    return confirmPreview(`会把最近 ${days} 天里 ${p.conversations} 个有动静的会话、`
      + `约 ${p.stateChars} 字符聊天正文，**逐个**发给判断模型（api.typesafe.ai），每会话一次请求。`)
  }
  const result = await runPythonJson<any>('reply_debt.py', ['--days', String(days), '--json'],
    { timeoutMs: 180_000 })
  if (!result.ok) return fail('欠账查询失败', result)

  const debts = Array.isArray(result.data?.debts) ? result.data.debts : []
  if (!debts.length) return `(最近 ${days} 天没有明显在等你回话的会话)`
  const lines = [`在等你回话的 ${debts.length} 个会话（最近 ${days} 天）：`]
  for (const row of debts.slice(0, 8)) {
    const prob = Number(row.waiting ?? 0)
    const urgency = row.urgencyScore === null || row.urgencyScore === undefined ? '' : ` · 紧急度 ${row.urgencyScore}`
    lines.push(`· ${row.name}（等了 ${row.days} 天 · 概率 ${prob.toFixed(2)}${urgency}${row.kind ? ' · ' + row.kind : ''}）`)
  }
  lines.push('（想看某人具体说了什么，用 get_messages 单独查；这里只报谁在等。）')
  return lines.join('\n')
}

export async function handleDraftReply(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  // 起草：判断（Jev）→ 起草（DeepSeek）→ 排序（Jev）。**只产出文本，绝不发送**——
  // 仓库里"发送"本来就不可达（TOOL_DEFS 没有任何 send 类工具），这里也不新增。
  const contact = String(args.contact || '')
  if (!contact) return '(缺少 contact 参数)'
  const count = boundedToolInteger(args.count, 3, 5, 'count')
  // strict 下**直接拒绝**，而不是把遮成"内容 N 字"的正文拿去起草——那会得到一段
  // 基于空白的、看起来正常的回复，比拒绝更糟（同 `look_at_image` 的处置）。
  //
  // 这里**不看 `isLocalInference()`**，与 `look_at_image` 刻意不同：那张图确实送到
  // 本机模型，所以"本机推理"在那里是成立的旁路；而起草出境的是**脚本自己的**两条远程
  // 调用（`jev_client` 走 HTTP、`_utils.call_deepseek` 写死 DeepSeek），跟 `aiEngine`
  // 配成什么毫无关系。照抄那个旁路＝用"我配了本地模型"当理由，把正文发到远端去。
  // 这条是实测出来的：aiEngine=ollama + strict 下，原实现真的把对话交给了脚本。
  if (privacyGate.mode() === 'strict') {
    return '(当前隐私模式是 strict：聊天正文不出境，而起草必须把正文发给远端模型'
      + '（判断一步、生成一步），这一步用本机推理也绕不开。'
      + '在电脑上 `weflow-cli config set assistantPrivacy balanced`，或用本机命令 '
      + '`weflow-cli draft <会话>`。)'
  }
  const talker = await resolveTalker(contact)
  const msgs = await chatService.getMessages(talker, TRANSCRIPT_MESSAGES)
  if (!msgs.length) return `(没找到「${contact}」的消息)`

  // **外部机器（MCP）默认只给预览，不做出境。** 与 CLI 的 `--dry-run` / `--yes` 同一套纪律：
  // 预览只读本地库、报清要发多少字符给哪两个模型，零出境。
  // 面板/微信那条路（`requiresConfirm` 不置位）不受影响——它那边的边界是白名单 + 用户
  // 在一个只有自己看得见的会话里显式开口问。
  if (ctx.requiresConfirm && args.confirm !== true) {
    const preview = await runPythonJson<any>('draft_reply.py',
      ['--talker', talker, '--dry-run', '--json', '--count', String(count)],
      { timeoutMs: 60_000 })
    if (!preview.ok || !preview.data?.success) {
      return `(起草预览失败：${String(preview.data?.error || preview.error || '未知').slice(0, 120)})`
    }
    const d = preview.data
    return confirmPreview('会把「' + d.name + '」最近的 ' + d.messages + ' 条消息、共 '
      + d.stateChars + ' 字符，发给 ' + (d.models?.judge || '判断模型') + ' 与 '
      + (d.models?.draft || '生成模型') + '（' + (d.calls || '3 次调用') + '），产出 '
      + d.count + ' 条候选。'
      // 前提说明也在出境的那一段里（它会进两段提示词），所以预览要把它算进去
      + (d.lastFromMe ? '另外会附一句「最后一条是我自己发的」的前提说明。' : ''))
  }

  // 逐条遮罩**再**交给脚本：Python 侧没有任何脱敏实现（全仓只有两处无关的位掩码），
  // 而脱敏这一层在 TS。**不在 Python 里再写一份**——同一件事两处实现早晚有一处会漏。
  //
  // 说明白：上面的门**现在**已经把 strict 全挡了，所以这里的 `maskMessageBody`
  // 在当下打不到（balanced/open 不改正文）。留着它是因为它守的是另一条不变式：
  // "交给脚本的正文一定先过一道遮罩"，谁将来松开了上面那道门，这道还在。
  const transcript = msgs.slice().reverse().map(m => transcriptLine(m))
  const result = await runPythonJson<any>('draft_reply.py',
    ['--stdin', '--yes', '--json', '--count', String(count)],
    // `lastFromMe`：`transcript` 是 `msgs` **反过来**渲染的，所以最后一条 = `msgs[0]`。
    // 用结构化字段 `isSend`，不去解析那行文本（群聊里别人的标签是人名，不是「对方」）。
    // 这段是说给脚本听的**前提**：最后一条是我发的时，"回答对方最后一句"这件事根本不存在。
    { stdin: JSON.stringify({ name: contact, lines: transcript, lastFromMe: !!msgs[0]?.isSend }),
      timeoutMs: 240_000 })
  if (!result.ok) return fail('起草失败', result)

  const data = result.data ?? {}
  if (!data.success) return `(起草没跑通: ${String(data.error || '未知').slice(0, 120)})`
  const picked = Array.isArray(data.drafts) ? data.drafts : []
  // 脚本给的前提说明（仅当最后一条是我发的）。**用户也要看见**：否则候选看起来像在回
  // 一句根本不存在的话。三条出口（降级/被闸门拦下/正常）都要带上它。
  const premise = typeof data.premise === 'string' ? data.premise.trim() : ''
  // **降级那次（Jev 没调通）必须说清两件事**：这次没有判断，以及那道闸门没生效。
  // 闸门（涉钱/高风险不给草稿）正是靠判断结果才存在的——不标出来，降级看起来就跟
  // "判断过了"一模一样。**不以 `(` 开头**：那个前缀在本仓库表示"工具没产出内容"。
  if (data.judged === false) {
    if (!picked.length) return `(起草没给出候选：${String(data.judgeNote || '判断与生成都没跑通').slice(0, 120)})`
    const lines = [...(premise ? [premise, ''] : []),
                   `这次**没有判断**——${String(data.judgeNote || '判断那一步没调通')}。`,
                   `所以"涉钱/风险高就不给草稿"那道闸门**没生效**，下面 ${picked.length} 条是生成模型`
                   + `按上下文给的，你自己看一眼：`, '']
    picked.forEach((draft: any, index: number) => { lines.push(`${index + 1}. ${draft.text}`) })
    lines.push('')
    lines.push('（这些只是文本，没有发送任何东西——回不回、怎么回由你决定。）')
    return lines.join('\n')
  }
  const judgment = data.judgment ?? {}
  const why = `对方${zhLabel(INTENT_LABELS, judgment.intent)}`
    + `；建议${zhLabel(ACTION_LABELS, judgment.action)}`
    + `；风险 ${Number(judgment.risk ?? 0).toFixed(1)}/9 ${riskLabel(judgment.risk)}`
  // 被闸门拦下：**不是失败**，是这条最该给的回答。所以不以 `(` 起头
  // （那个前缀在本仓库里表示"工具没产出内容"，见 `producedContent`）。
  if (data.gate === 'refused') {
    return [...(premise ? [premise, ''] : []),
            '不起草。', String(data.reason || ''), '',
            '建议先：', ...(data.advice ?? []).map((line: string) => `· ${line}`),
            '', `（判断：${why}。这些只是文本，没有发送任何东西。）`].join('\n')
  }
  const drafts: any[] = Array.isArray(data.drafts) ? data.drafts : []
  if (!drafts.length) return '(起草没给出候选)'
  const lines = [...(premise ? [premise, ''] : []),
                 `建议这样回（${drafts.length} 条，第一条是判断最合适的）：`, '']
  drafts.forEach((draft, index) => { lines.push(`${index + 1}. ${draft.text}`) })
  lines.push('')
  lines.push(`（判断：${why}。这些只是文本，没有发送任何东西——回不回、怎么回由你决定。）`)
  return lines.join('\n')
}
