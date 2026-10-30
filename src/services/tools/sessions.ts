/** 会话与联系人：列表、消息读取、聊天搜索、通讯录。 */
import { join } from 'path'
import { chatService } from '../chatService.js'
import { runPythonJson } from '../pythonBridge.js'
import { privacyGate } from '../assistantPrivacy.js'
import { clipWithMarker } from '../../utils/text.js'
import { resolveSince, resolveUntil } from '../../utils/dateRange.js'
import { MSG_BODY_CHARS, fmtTime, speakerLabel } from './transcript.js'
import { ensureDb, boundedToolInteger, resolveTalker, fail, confirmPreview } from './runtime.js'
import type { ToolContext } from './types.js'

export async function handleListSessions(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  await ensureDb()
  const limit = boundedToolInteger(args.limit, 15, 30)
  const sessions = await chatService.listSessions(undefined, limit)
  if (!sessions.length) return '(未查到会话, 数据库可能未连接)'
  return sessions.map(s =>
    `· ${s.displayName || s.username}: ${(s.summary || '').replace(/\n/g, ' ').slice(0, 30)}`).join('\n')
}

export async function handleGetMessages(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const contact = String(args.contact || '')
  if (!contact) return '(缺少 contact 参数)'
  const limit = boundedToolInteger(args.limit, 20, 50)
  // 时间窗：不给就是"最近 N 条"（老行为一个字没改）。给了就用范围读——
  // **这正是"上周三他说了什么"以前够不着的原因**：只按条数取，越久远的日子越取不到，
  // 模型要么说查不到，要么把最近的消息当成那天的。
  let from: number | undefined
  let to: number | undefined
  try {
    from = resolveSince(args.since)
    to = resolveUntil(args.until)
  } catch {
    return '(时间看不懂：since/until 可以写 2026-09-16 或 3d / 2w / 12h；收到的是'
      + ` since=${JSON.stringify(args.since)} until=${JSON.stringify(args.until)})`
  }
  const windowed = from !== undefined || to !== undefined
  const windowLabel = windowed
    ? `${from ? new Date(from * 1000).toLocaleDateString('zh-CN') : '最早'}`
      + ` 至 ${to ? new Date(to * 1000).toLocaleDateString('zh-CN') : '现在'}`
    : ''
  const talker = await resolveTalker(contact)
  const msgs = windowed
    ? await chatService.getMessagesInRange(talker, limit, from, to)
    : await chatService.getMessages(talker, limit)
  if (!msgs.length) {
    return windowed
      ? `(${windowLabel} 这段时间里没有「${contact}」的消息)`
      : `(没找到「${contact}」的消息)`
  }
  // 图片消息带一个句柄：`[图片 #1234]` 里的 1234 就是 `look_at_image` 的 `image` 参数。
  // strict 模式下图片不允许出境，那时不带句柄——不摆出一个工具必定会拒绝的东西。
  const canLook = privacyGate.mode() !== 'strict'
  const rendered = msgs.map(m => {
    // 非文本消息优先用 `parsedContent`：它是读取器给的**显示形态**（`[图片]`、
    // `[文件] Base.csv`、`某人 撤回了一条消息`…），而 `content` 对这类消息可能是
    // 原始 XML（含 md5 与 cdn 链接）——那是给机器看的，不该塞进模型上下文。
    const raw = m.localType === 1
      ? (m.content || m.parsedContent || '')
      : (m.parsedContent || m.content || '')
    // 每条 160 字。此前是 80，引用消息（`[引用] 回复 ｜ 引：原文`）在 80 字里
    // 引文只剩七八个字，等于白带；长文本消息也被从中间切掉。上限仍是有界的：
    // limit 最多 50 条 × 约 180 字 ≈ 9k 字符。截断留省略号——切了却看起来像
    // 说完了，模型会把半句当整句。
    const flat = raw.replace(/\n/g, ' ')
    const body = canLook && m.localType === 3
      ? `[图片 #${m.localId}]`
      : privacyGate.maskMessageBody(clipWithMarker(flat, MSG_BODY_CHARS),
                                    { isText: m.localType === 1 })
    // 这一行原来用 `senderUsername`（**wxid 原列**），等于把账号标识交给云端模型。
    // 曾经以为"改成「对方」就分不清群聊里谁说的，是个真损失"——实测之后不成立：
    // `senderDisplay` 本来就有名字（见 `speakerLabel`），换成它两边都占，
    // 名字对模型还比 wxid 有用。自己发的仍是「用户」（这是对人说"你发了什么"，
    // 与转录里的「我」是两种口吻，各自有测试钉着）。
    return `[${fmtTime(m.createTime)}] ${m.isSend ? '用户' : speakerLabel(m)}: ${body}`
  }).join('\n')
  // 有时间窗时先说清窗口：模型据此判断"这些是不是那天的"，也免得它把窗口内的最后
  // 一条当成"最新的"。
  return windowed ? `（${windowLabel}，共 ${msgs.length} 条）\n${rendered}` : rendered
}

export async function handleSearchChats(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  // 跨会话检索：本机 message_fts 索引 + 判断模型挑查询词（**只发候选词与问题，不发聊天内容**）
  const question = String(args.question || '').trim()
  if (!question) return '(缺少 question 参数)'
  const perCard = boundedToolInteger(args.per_card, 3, 10, 'per_card')
  // 外部机器默认只给预览，**按入参说清**。这里要说清的恰好是最要紧的那件事：
  // 这条路上出去的是"你的问题 + 从聊天里提取的候选词"，**不含消息正文**（排序在本地做）。
  if (ctx.requiresConfirm && args.confirm !== true) {
    return confirmPreview(`会把你的问题「${question.slice(0, 40)}」与从聊天里提取的候选词`
      + `（最多 ${perCard} 个会话各若干词，**不含消息正文**）发给判断模型 Jev，`
      + '让它挑出你真正在找的词；排序在本地做。')
  }
  const result = await runPythonJson<any>('route_cards.py',
    ['ask', question, '--yes', '--json', '--per-card', String(perCard)], { timeoutMs: 90_000 })
  if (!result.ok) return fail('会话检索失败', result)

  const ranked = Array.isArray(result.data?.ranked) ? result.data.ranked : []
  if (!ranked.length) {
    return `(没有会话字面命中「${question}」——检索只匹配字面词，换几个词再试)`
  }
  const lines = [`命中 ${ranked.length} 个会话（查询词：${(result.data.terms || []).join('、')}）：`]
  for (const card of ranked.slice(0, 6)) {
    lines.push(`· #${card.id} [${card.kind}] ${card.label}（该会话 ${card.messages} 条消息，最后活动 ${card.lastDaysAgo} 天前）`)
    const rows = result.data?.messages?.[String(card.id)] || []
    for (const row of rows.slice(0, perCard)) {
      // 第三方聊天正文与 get_messages **同一条纪律**：出境前按隐私档位处理
      const body = privacyGate.maskMessageBody(String(row?.text || '').replace(/\s+/g, ' ').slice(0, 60))
      lines.push(`    ${body}`)
    }
  }
  return lines.join('\n')
}

export async function handleListContacts(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  await ensureDb()
  const keyword = String(args.keyword || '').trim()
  const limit = boundedToolInteger(args.limit, 50, 200)
  const contacts = await chatService.listContacts(keyword || undefined, limit)
  if (!contacts.length) {
    return keyword
      ? `(通讯录里没有匹配「${keyword}」的名字)`
      : '(通讯录是空的或读不到——可以用 check 看本机数据源的状态)'
  }
  // **只给名字**：`username` 是 wxid，`avatarUrl` 里也可能带本机标识，
  // 本仓的纪律是本机标识不进模型上下文（同 speakerLabel 那边的处理）
  const names: string[] = []
  for (const c of contacts) {
    const n = String(c.remark || c.displayName || c.nickname || '').trim()
    if (n && !names.includes(n)) names.push(n)
  }
  if (!names.length) return '(通讯录读到了, 但都没有可显示的名字)'
  return `通讯录里 ${names.length} 个名字:\n` + names.slice(0, limit).map(n => `· ${n}`).join('\n')
}
