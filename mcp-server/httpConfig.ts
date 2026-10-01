/**
 * HTTP 传输的**判定**——纯函数，不碰 socket、不连 MCP，所以能离线测。
 *
 * 为什么值得单独一个文件：这里每一条规则决定的都是"要不要把本机的私密数据摊到一个网络
 * 端口上"。服务器本体要起 socket、要装 SDK，测起来重；把判定抽出来，规则就能一条一条钉住
 * （`test/mcp-http.test.ts`）。
 *
 * 边界（写死在这里，不靠调用方自觉）：
 * - **默认不开**：不给 `--http` 也不给 `WEFLOW_MCP_HTTP` 就还是 stdio，行为与以前逐字相同。
 * - **必须带令牌**：没给就**拒绝启动**，不给默认值 —— 一个悄悄生成的默认口令比没有更坏，
 *   因为它看起来是"配好了"。
 * - **只绑回环**：远程访问自己走 SSH 隧道或反向代理。把私密聊天记录摊到局域网上，
 *   不该由这个文件顺手打开。
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/** 默认端口。5030 是 chatlog 的，避开它免得两个服务打架。 */
export const DEFAULT_HTTP_PORT = 8790

/**
 * 令牌长度下限。128 位随机（32 个 hex 字符）是常态；24 个字符足够排除"随手敲一个"，
 * 又不至于逼人非得用某个特定长度。
 */
export const MIN_TOKEN_CHARS = 24

/** 允许绑定的地址。**只回环**：`0.0.0.0` 不在此列，而且不是"忘了加"。 */
export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1']

export interface HttpOptions {
  host: string
  port: number
  token: string
}

/** 这一轮是不是要走 HTTP。`--http`、`--http=8790`、`WEFLOW_MCP_HTTP=1` 都算。 */
export function httpModeRequested(env: Record<string, string | undefined>, argv: string[]): boolean {
  if (argv.some((a) => a === '--http' || a.startsWith('--http='))) return true
  const value = String(env.WEFLOW_MCP_HTTP ?? '').trim()
  return value !== '' && value !== '0' && value.toLowerCase() !== 'false'
}

function flagValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : undefined
}

/**
 * 解出 HTTP 模式的参数。**不走 HTTP 就返回 `null`**；要走但配置不合法就**抛错**（fail closed，
 * 绝不"降级成不安全的默认值"继续跑）。
 *
 * 端口允许 `0`：那是让内核挑一个空闲端口，测试要用；正式跑用默认端口。
 */
export function resolveHttpOptions(
  env: Record<string, string | undefined>,
  argv: string[],
): HttpOptions | null {
  if (!httpModeRequested(env, argv)) return null

  const token = String(flagValue(argv, '--token') ?? env.WEFLOW_MCP_TOKEN ?? '').trim()
  if (!token) {
    throw new Error(
      'HTTP 模式必须给令牌：`--token=<随机串>` 或环境变量 WEFLOW_MCP_TOKEN。\n'
      + '没有默认值是有意的 —— 一个自动生成、只在日志里露一面的口令，看起来像"配好了"。\n'
      + '生成一个：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    )
  }
  if (token.length < MIN_TOKEN_CHARS) {
    throw new Error(`令牌太短（${token.length} < ${MIN_TOKEN_CHARS} 个字符）。用随机串，别用可猜的短语。`)
  }

  const host = String(flagValue(argv, '--host') ?? '127.0.0.1').trim()
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new Error(
      `只允许绑回环地址（${LOOPBACK_HOSTS.join(' / ')}），收到 ${host}。\n`
      + '要从别的机器连，用 SSH 隧道（ssh -L 8790:127.0.0.1:8790 <host>）或自己的反向代理 —— '
      + '把聊天记录摊到局域网上不该由这个命令顺手打开。',
    )
  }

  const raw = flagValue(argv, '--http') ?? flagValue(argv, '--port') ?? env.WEFLOW_MCP_HTTP_PORT ?? String(DEFAULT_HTTP_PORT)
  const rawText = String(raw).trim()
  // 先按"纯数字"卡一道：`Number('') === 0`，不卡的话空值会静默变成一个端口。
  if (!/^\d{1,5}$/.test(rawText)) {
    throw new Error(`端口要 0-65535 之间的整数（0 = 让系统挑一个空闲端口），收到 ${JSON.stringify(raw)}`)
  }
  const port = Number(rawText)
  if (port > 65535) {
    throw new Error(`端口要 0-65535 之间的整数，收到 ${JSON.stringify(raw)}`)
  }

  return { host, port, token }
}

/**
 * `Authorization` 头认不认。
 *
 * 比的是**摘要**而不是原文：`timingSafeEqual` 要求等长，直接比长度会漏出"令牌有多长"，
 * 于是"不同长度直接返回 false"就成了一个可测的短路径。两边先过一遍 SHA-256，长度就固定了。
 * 方案名按 RFC 7235 大小写不敏感。
 */
export function isAuthorized(header: string | undefined, token: string): boolean {
  const raw = String(header ?? '')
  const space = raw.indexOf(' ')
  if (space < 0) return false
  if (raw.slice(0, space).toLowerCase() !== 'bearer') return false
  const presented = raw.slice(space + 1).trim()
  if (!presented) return false

  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()
  return timingSafeEqual(digest(presented), digest(token))
}

/** Host 头允许的取值（DNS 重绑定防护用）。带端口，因为 SDK 比的是**原始 Host 头**。 */
export function allowedHostsFor(host: string, port: number): string[] {
  const forms = new Set<string>()
  for (const h of host === 'localhost' ? ['127.0.0.1', 'localhost'] : [host]) {
    forms.add(h === '::1' ? `[::1]:${port}` : `${h}:${port}`)
  }
  return [...forms]
}

/** 允许的 Origin（浏览器来的请求会带；命令行客户端通常不带，不带就放行）。 */
export function allowedOriginsFor(host: string, port: number): string[] {
  return allowedHostsFor(host, port).map((h) => `http://${h}`)
}
