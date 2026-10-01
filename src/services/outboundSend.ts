/**
 * 出站发送的**那一份策略**：黑名单 → 白名单 → 限速，以及"每次尝试都写审计"。
 *
 * 为什么抽成一份：这条链是一条**安全策略**，而 2026-10-01 起有了第二条发送路
 * （`draft --pick N --send`，见 D-063）。两份写同一件事迟早分叉，而这里分叉的后果具体是
 * "有一条路绕过了白名单" —— 悄悄多出一个能发给任何人的入口。
 *
 * **它不面向模型。** 助手与 MCP 的工具表里没有任何发送工具（`docs/EXTENDING.md`：
 * *sending is structurally unreachable from a model-driven path*）。这个模块只被**人在命令行上
 * 显式驱动**的命令调用，而且第二条路还要求先点名"发第几条"。
 *
 * 一条实测出来的硬约束写在错误信息里：发送需要**对方的 context_token**，也就是对方得先给你
 * 发过消息。没有它，"主动发给任何人"这条路本来就不通。
 */
import { configService } from './configService.js'
import { whitelistService } from './whitelistService.js'
import { WechatMessageService } from './wechatMessageService.js'

export type OutboundKind = 'text' | 'image' | 'file'

export interface OutboundAttempt {
  wxid: string
  displayName: string
  kind: OutboundKind
  /** 审计与预览里那一行（文本截断后的样子，或 `[image] 文件名 (字节)`） */
  preview: string
  /** 纯文本内容（kind 为 text 时用；媒体走 mediaPath） */
  text?: string
  mediaPath?: string
}

export interface OutboundPolicy {
  windowMs: number
  max: number
}

export type OutboundRefusalCode =
  | 'INVALID_RATE_LIMIT'
  | 'TARGET_BLOCKED'
  | 'TARGET_NOT_ALLOWED'
  | 'RATE_LIMITED'

export interface OutboundRefusal {
  code: OutboundRefusalCode
  error: string
  /** 限速时带上窗口与计数，好让调用方原样报出来 */
  rateLimit?: { count: number; max: number; windowMs: number }
}

function auditRefusal(attempt: OutboundAttempt, error: string): void {
  whitelistService.auditSend({
    timestamp: Date.now(), action: 'send', targetWxid: attempt.wxid,
    targetName: attempt.displayName, kind: attempt.kind, success: false,
    preview: attempt.preview, error,
  })
}

/** 速率参数合法性。`send` 与 `draft --send` 用的是同一条规则。 */
export function parseOutboundPolicy(windowMs: number, max: number): OutboundPolicy | OutboundRefusal {
  if (!Number.isInteger(windowMs) || windowMs < 1000 || windowMs > 3_600_000
      || !Number.isInteger(max) || max < 1 || max > 100) {
    return { code: 'INVALID_RATE_LIMIT', error: 'rate-window 必须为 1000-3600000，rate-max 必须为 1-100' }
  }
  return { windowMs, max }
}

export interface OutboundRate { count: number; max: number; windowMs: number }
export type OutboundDecision =
  | { ok: true; rate: OutboundRate }
  | { ok: false; refusal: OutboundRefusal }

/**
 * 发送前的三道闸。拒绝时**先写审计**再返回原因（"每次尝试都留痕"是策略的一部分，不只是成功的那些）。
 *
 * 放行时把**当时的速率计数**一起带回去 —— 调用方要拿它写进预览（原来那一条命令里
 * 是先 `checkRateLimit` 再复用同一个对象）。少一次重复查询，也免得两处看到的数不一样。
 */
export function authorizeOutbound(attempt: OutboundAttempt, policy: OutboundPolicy): OutboundDecision {
  if (whitelistService.isBlocked(attempt.wxid)) {
    auditRefusal(attempt, 'blocked by blacklist')
    return { ok: false, refusal: { code: 'TARGET_BLOCKED', error: '目标在黑名单中' } }
  }
  if (!whitelistService.isAllowed(attempt.wxid)) {
    // **白名单是这一层真正的边界**：不在名单上的人，任何一条命令行都发不出去。
    // 这一条**不写审计** —— 与黑名单那条不一样，原实现就是如此，保持一致。
    return { ok: false, refusal: { code: 'TARGET_NOT_ALLOWED', error: '目标不在白名单中' } }
  }
  const rate = whitelistService.checkRateLimit(policy.windowMs, policy.max)
  if (!rate.allowed) {
    auditRefusal(attempt, `rate limited (${rate.count}/${rate.max})`)
    return { ok: false, refusal: { code: 'RATE_LIMITED', error: '触发发送速率限制', rateLimit: rate } }
  }
  return { ok: true, rate }
}

/** 真的发出去，并按结果写审计。返回 `{success, error}`（不抛）。 */
export async function performOutbound(attempt: OutboundAttempt): Promise<{ success: boolean; error?: string }> {
  const token = configService.get('wechatOcToken')
  const service = new WechatMessageService({ token })
  let success = false
  let error: string | undefined
  try {
    if (attempt.kind === 'image' && attempt.mediaPath) {
      success = await service.sendImage(attempt.wxid, attempt.mediaPath)
    } else if (attempt.kind === 'file' && attempt.mediaPath) {
      success = await service.sendFile(attempt.wxid, attempt.mediaPath)
    } else {
      success = await service.sendText(attempt.wxid, attempt.text ?? '')
    }
  } catch {
    error = '消息通道调用失败'
  }
  if (!success && !error) {
    // 最像的原因就是缺 context_token —— 说清楚，别让人以为是"发失败"这种含糊的锅
    const hasToken = !!(configService.getContextTokens()[attempt.wxid])
    error = hasToken
      ? '发送失败 (接口返回错误, 可能 token 过期)'
      : '缺少 context_token — 需先收到对方一条消息 (或运行 weflow-cli listen 等待对方消息)'
  }
  whitelistService.auditSend({
    timestamp: Date.now(), action: 'send', targetWxid: attempt.wxid,
    targetName: attempt.displayName, kind: attempt.kind, success,
    preview: attempt.preview, error: success ? undefined : error,
  })
  return { success, error }
}
