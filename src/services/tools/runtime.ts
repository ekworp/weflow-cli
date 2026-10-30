/** 工具运行时：连库、解析会话名、参数校验、失败回话与展示用标签。 */
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { chatService } from '../chatService.js'
import { privacyGate } from '../assistantPrivacy.js'
import { bizDailyDir } from './paths.js'
import type { Contact } from '../../types.js'
import type { ToolContext } from './types.js'

export async function ensureDb(): Promise<void> {
  await chatService.connect()
}

/** 最近一份**有内容**的日报是哪天，以及那是几天前。算不出来就回空串——不猜。 */
export function lastDailyNote(): string {
  try {
    const days = readdirSync(bizDailyDir())
      .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort().reverse().slice(0, 30)
    for (const day of days) {
      const file = join(bizDailyDir(), day, '.articles.json')
      if (!existsSync(file)) continue
      const payload = JSON.parse(readFileSync(file, 'utf8'))
      if ((payload?.articles ?? []).length) {
        const ago = Math.round((Date.now() - new Date(`${day}T00:00:00`).getTime()) / 86_400_000)
        return `；最近一次有内容的日报是 ${day}（${ago} 天前）`
      }
    }
  } catch { /* 扫不出来就什么都不说，而不是猜一个日期 */ }
  return ''
}

export interface TalkerCandidate {
  username: string
  displayName?: string | null
}

export class ToolInputError extends Error {}

/**
 * 把待办 id 露给模型。**不露出来它就指不到具体哪一条**——`set_todo_status` 只能靠 id
 * 或唯一的任务文字定位，而任务文字常常是长句、几条之间又很像。
 * 给完整 id（CLI 那边支持 id 前缀，但前缀要唯一才安全，这里不赌）。
 */
export function idTag(t: any): string {
  return t?.id ? ` [id: ${t.id}]` : ''
}

export function boundedToolInteger(value: unknown, fallback: number, maximum: number, field = 'limit'): number {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ToolInputError(`${field} 必须是 1-${maximum} 的整数`)
  }
  return parsed
}

export function resolveUniqueTalker(name: string, sessions: TalkerCandidate[]): string {
  const query = name.trim()
  if (!query) throw new ToolInputError('contact 不能为空')

  const unique = (matches: TalkerCandidate[]) => [...new Set(matches.map(item => item.username))]
  const usernameMatches = unique(sessions.filter(item => item.username === query))
  if (usernameMatches.length === 1) return usernameMatches[0]

  const exactNameMatches = unique(sessions.filter(item => item.displayName === query))
  if (exactNameMatches.length === 1) return exactNameMatches[0]
  if (exactNameMatches.length > 1) {
    throw new ToolInputError(`会话名称“${query}”对应多个会话，请改用会话 ID`)
  }

  const partialMatches = unique(sessions.filter(item => item.displayName?.includes(query)))
  if (partialMatches.length === 1) return partialMatches[0]
  if (partialMatches.length > 1) {
    throw new ToolInputError(`会话名称“${query}”匹配多个会话，请提供更完整名称或会话 ID`)
  }
  return query
}

/**
 * 通讯录里按 **备注 / 显示名 / 昵称 / 别名 / username** 找唯一的一个；找不到或有歧义回 null。
 *
 * 与 `resolveUniqueTalker` 同一套纪律：**只认唯一**，不猜。
 */
export async function lookupContactUsername(name: string): Promise<string | null> {
  const query = name.trim()
  if (!query) return null
  // 窗口给宽一点：关键字命中的是**包含**它的所有名字，一个字的查询能匹配到几十个人，
  // 而精确那一个可能排在 20 名之后。实测（378 个真实联系人，都不在最近会话里）：
  // 20 名时漏 6 个、60 名时漏 5 个，**认错都是 0 个**。剩下那 5 个都是单字名——它匹配到
  // 几十个人，精确的那个仍在窗口之外。这个残余是安全的：回 null，助手说"没找到"，
  // 而不会读到别人的聊天。
  const contacts = await chatService.listContacts(query, 60)
  const fields = (contact: Contact) => [contact.remark, contact.displayName, contact.nickname, contact.alias]
    .filter(Boolean) as string[]
  const exact = contacts.filter(c => c.username === query || fields(c).some(f => f === query))
  const pool = exact.length ? exact : contacts.filter(c => fields(c).some(f => f.includes(query)))
  const usernames = [...new Set(pool.map(c => c.username))]
  return usernames.length === 1 ? usernames[0] : null
}

/**
 * 显示名 → username 解析。
 *
 * 会话列表**只取最近 300 个**，而通讯录是完整的：名字不在那 300 个里时（对话很多的人，或
 * 很久没聊过的人），旧行为是把查询词原样当 talker 返回——于是下游读到空、助手说"没找到
 * 消息"，而那个人其实在通讯录里。所以**匹配不上时再查一次通讯录**。
 *
 * 兜底只做"名字 → username"，不去验证这个会话有没有消息：没有消息时下游会如实说
 * "没找到消息"，那是对的答案，不该在这里变成"查无此人"。
 */
export async function resolveTalker(name: string): Promise<string> {
  const sessions = await chatService.listSessions(undefined, 300)
  const talker = resolveUniqueTalker(name, sessions)     // 歧义会抛，让它抛
  if (sessions.some(session => session.username === talker)) return talker
  const fromBook = await lookupContactUsername(name)
  return fromBook ?? talker
}

/** 脚本类工具的失败回话：桥接层已经分好类（超时/退出码/没有 JSON/脚本自己报错），
 *  这里把它和 stderr 尾巴合起来**过一遍脱敏**再交给模型——stderr 里可能有密钥形状的东西，
 *  而工具结果是要出境的。
 */
export function fail(what: string, result: { error?: string; stderr?: string }): string {
  const detail = [result.error, result.stderr].filter(Boolean).join(' · ')
  const { safe } = privacyGate.redact(detail)
  return `(${what}${safe ? ": " + safe : ""})`
}

/**
 * **括号起头 = 工具没能给出内容**。这是本仓库既有的写法：`fail()` 与各分支的
 * "查不到 / 缺参数 / 拒绝抓取"一律写成 `(…)`，而正常内容不带括号。
 *
 * 这张白名单是**唯一的例外**：成功的句子也可以是括号起头（不然它就不叫例外了）。
 * 有一条测试盯着它——白名单里每一条都必须在工具源码（`src/services/tools/`）里真的出现过，
 * 改措辞忘了同步就会红。反过来（有新的成功消息带括号、但没进白名单）测试抓不到，
 * 这是这个信号的真实边界：**它靠约定，不是一个机器可读的成败字段**。
 *
 * 想要真字段，得把 outcome 从 ~40 个 return 处一路带出来（`ToolContext.outcome`）。
 * 那件事记在 D-043 的"已知边界"里，没有做——这里用它是因为轨迹只想知道"这一步有没有
 * 产出东西"，而这个判断错了的代价是报告里多一个/少一个「无内容」标记。
 */
export const PAREN_SUCCESS_PREFIXES = ['(已附上图片']

/** 工具这次**有没有给出内容**。括号起头（除白名单外）都算没有。 */
export function producedContent(text: string): boolean {
  const head = (text ?? '').trimStart()
  if (!head.startsWith('(')) return true
  return PAREN_SUCCESS_PREFIXES.some(prefix => head.startsWith(prefix))
}

/**
 * 判断模型给的键翻成人话。
 *
 * 为什么要这一层：那些键是**英文判据的键名**（`casual_chat` / `give_commitment`），
 * 原样交给助手，它就会照着念给用户听。映射不上就退回原键——如实展示，不硬编一个。
 */
export const INTENT_LABELS: Record<string, string> = {
  confirm_you_care: '想要你一个态度（在试探你还在不在意）',
  vent_anger: '在发火，想被听见而不是被解决',
  request_action: '有事要你办（发东西、付钱、约时间这类）',
  seek_explanation: '想要个解释',
  casual_chat: '在闲聊，没有事要你办',
  close_topic: '在收尾，不想再展开',
}
export const ACTION_LABELS: Record<string, string> = {
  check_history: '先翻一下更早的聊天记录再说',
  apologize: '具体地认错',
  give_commitment: '给一个做得到的时间或交付',
  explain: '说明经过，不辩解',
  acknowledge: '表示收到了，先不承诺什么',
  say_less: '少说',
  make_plan: '一起定个时间',
}
export const NEED_LABELS: Record<string, string> = {
  apology: '一个道歉', action: '实际的动作', explanation: '解释', care: '被在意',
  nothing: '什么都不用',
}

export function zhLabel(map: Record<string, string>, key: unknown): string {
  const text = String(key ?? '')
  return map[text] || text || '说不准'
}

export function riskLabel(score: unknown): string {
  const value = Number(score ?? 0)
  if (value >= 8) return '很危险'
  if (value >= 6) return '偏危险'
  if (value >= 3) return '留神'
  return '安全'
}

/**
 * 外部机器（MCP）调用到"会把用户数据送出去"的工具时，**统一只给预览**的那段文案。
 *
 * 四个出境工具（draft_reply / who_owes_reply / search_chats / search_semantic）共用这一份形状，
 * 各自把"要发什么、发给谁"填进 `what`。预览阶段一律不出境：能用脚本自己的 `--dry-run`
 * 报出具体数字的就报数字（draft_reply、who_owes_reply），报不出的就按入参说清
 * （search_chats 的 --dry-run 打的是纯文本、不认 --json；semantic_search 根本没有 --dry-run）。
 */
export function confirmPreview(what: string): string {
  return [
    '还没执行——这只是一次**预览**（没有把任何内容发出去）。',
    what,
    '用户明确同意之后再带 `confirm: true` 调一次，才会真的执行。',
  ].join(String.fromCharCode(10))
}
