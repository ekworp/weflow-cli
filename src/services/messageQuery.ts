import type { Message } from '../types.js'

export interface MessageTimeRange {
  from?: number
  to?: number
}

/**
 * 这三种形状的输入会被 `resolveTalker` **原样返回**（见 `src/utils/talkerUtils.ts`），
 * 于是拼错的 ID 会一路走到「取不到消息」，和「这条会话在窗口内确实没有消息」长得一模一样。
 * 只看形状，不碰 IO —— 判定所需的名单由调用方传进来。
 */
export function looksLikeTalkerId(input: string): boolean {
  const value = String(input || '')
  return value.startsWith('wxid_') || value.includes('@chatroom') || value.includes('@openim')
}

/**
 * 空结果时补的一句话：**只在"看起来是 ID、但会话与联系人都没有它"时**才给。
 * 返回空串表示没什么可补的 —— 名字形状的输入本来就由 `resolveTalker` 报错，认识的 ID
 * 取不到消息是正常结果。
 *
 * 这里**不改退出码、也不改 `success`**：既有契约里「没有消息」不是错误（脚本与 MCP 依赖它，
 * 见 `docs/HEALTH-CHECK.md` 的那一行），所以只把歧义说出来，不动语义。
 */
export function emptyMessagesNote(
  input: string,
  known: { sessionUsernames: Iterable<string>; contactUsernames: Iterable<string> },
): string {
  if (!looksLikeTalkerId(input)) return ''
  for (const id of known.sessionUsernames) if (id === input) return ''
  for (const id of known.contactUsernames) if (id === input) return ''
  return `这个 ID 既不在会话里、也不在联系人里：${input}` +
    ' —— 先确认有没有拼错（weflow-cli sessions / weflow-cli contacts）'
}

export async function collectMessagesInRange(
  fetchPage: (limit: number, offset: number) => Promise<Message[]>,
  limit: number,
  range: MessageTimeRange,
  pageSize = 500,
): Promise<Message[]> {
  const result: Message[] = []
  let offset = 0

  while (true) {
    const page = await fetchPage(pageSize, offset)
    if (page.length === 0) break

    let oldestTimestamp = Number.POSITIVE_INFINITY
    for (const message of page) {
      const timestamp = Number(message.createTime)
      if (!Number.isFinite(timestamp)) continue
      oldestTimestamp = Math.min(oldestTimestamp, timestamp)
      if (range.from !== undefined && timestamp < range.from) continue
      if (range.to !== undefined && timestamp > range.to) continue
      result.push(message)
      if (limit > 0 && result.length >= limit) return result
    }

    offset += page.length
    if (page.length < pageSize) break
    if (range.from !== undefined && oldestTimestamp < range.from) break
  }

  return result
}

/** Why the paging loop stopped. The first two are expected; the last two are not. */
export type StopReason =
  /** Reached the requested `from` bound. */
  | 'range'
  /** A page came back empty - there is nothing older. */
  | 'exhausted'
  /** Collected the caller's limit. */
  | 'limit'
  /** A page shorter than pageSize ended the loop before `from` was reached. */
  | 'short-page'

export interface DetailedMessageCollection {
  messages: Message[]
  pages: number
  stoppedBy: StopReason
  mayHaveMore: boolean
  /**
   * A short page ended the loop while the requested `from` was still ahead
   * of us.
   *
   * `collectMessagesInRange` breaks on a short page, which is right when the
   * page is short because the conversation ended - but a live database can
   * also return a short page while rows are being written, because offset
   * paging shifts underneath. The two are indistinguishable from the result
   * alone, so this records the difference instead of assuming the benign one.
   */
  truncatedEarly: boolean
}

/**
 * `collectMessagesInRange` plus the reason it stopped.
 *
 * Kept separate rather than folded into the original: that one is covered by
 * existing tests and used by every export path, and changing what it returns
 * would change those callers.
 */
export async function collectMessagesInRangeDetailed(
  fetchPage: (limit: number, offset: number) => Promise<Message[]>,
  limit: number,
  range: MessageTimeRange,
  pageSize = 500,
): Promise<DetailedMessageCollection> {
  const messages: Message[] = []
  let offset = 0
  let pages = 0
  let stoppedBy: StopReason = 'exhausted'
  let reachedFrom = range.from === undefined

  while (true) {
    const page = await fetchPage(pageSize, offset)
    pages += 1
    if (page.length === 0) {
      stoppedBy = 'exhausted'
      reachedFrom = true
      break
    }

    let oldestTimestamp = Number.POSITIVE_INFINITY
    for (const message of page) {
      const timestamp = Number(message.createTime)
      if (!Number.isFinite(timestamp)) continue
      oldestTimestamp = Math.min(oldestTimestamp, timestamp)
      if (range.from !== undefined && timestamp < range.from) continue
      if (range.to !== undefined && timestamp > range.to) continue
      messages.push(message)
      if (limit > 0 && messages.length >= limit) {
        return { messages, pages, stoppedBy: 'limit', mayHaveMore: true, truncatedEarly: false }
      }
    }

    offset += page.length
    if (range.from !== undefined && oldestTimestamp < range.from) {
      stoppedBy = 'range'
      reachedFrom = true
      break
    }
    if (page.length < pageSize) {
      // A short *first* page is unambiguous: nothing has shifted yet, so the
      // conversation simply has fewer than pageSize messages. A short later
      // page is the ambiguous one offset paging can produce on a live
      // database, so it keeps its own name.
      stoppedBy = pages === 1 ? 'exhausted' : 'short-page'
      break
    }
  }

  return {
    messages,
    pages,
    stoppedBy,
    // A limit hit is handled above; anything else that is not 'range' may
    // still have older matching rows we never looked at.
    mayHaveMore: stoppedBy !== 'range' && stoppedBy !== 'exhausted',
    truncatedEarly: stoppedBy === 'short-page' && !reachedFrom,
  }
}
