/**
 * MCP 的 **HTTP 传输**（Streamable HTTP）。stdio 那条路一个字没动，这是**另一条**路。
 *
 * 为什么要它：stdio 只能被"能起进程"的客户端用（Claude Code、IDE 插件）。HTTP 那条路在
 * 生态里已是常态——chatlog 就是拿 Streamable HTTP / SSE 把同一批查询能力摊出来的，于是浏览器型
 * 客户端、常驻服务、多个客户端同时连都能用。工具集**完全一样**（同一张 `TOOL_DEFS` 派生表），
 * 变的只是搬运动作的方式。
 *
 * 三道边界（判定在 `httpConfig.ts`，纯函数、有测试）：
 * 1. **默认不开**：不给 `--http` 就是 stdio，行为与以前逐字相同。
 * 2. **必须带令牌**，且**只绑回环**（远程走 SSH 隧道，见 docs/MCP.md）。
 * 3. **打开 DNS 重绑定防护**：SDK 的默认是 `false`，而本机 HTTP 服务最现实的攻击面就是
 *    "你正在浏览的某个网页往 127.0.0.1 发请求"。打开后 Host 头必须对得上，带 Origin 的
 *    浏览器请求也必须在白名单里。
 *
 * 采用**无状态**模式（每个请求一套 server+transport）：这一层只有只读查询，没有要跨请求维持的
 * 会话，无状态就没有"会话之间串了"这类问题。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import {
  allowedHostsFor,
  allowedOriginsFor,
  isAuthorized,
  type HttpOptions,
} from './httpConfig.js'

export const MCP_HTTP_PATH = '/mcp'

export interface RunningHttpServer {
  /** 实际绑定的地址（端口传 0 时是内核挑的，所以以这里为准） */
  url: string
  port: number
  close: () => Promise<void>
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * 起 HTTP 传输。`buildServer` 每次调用都必须返回一个**新的** Server（无状态模式每个请求一套）。
 */
export async function startHttpServer(
  opts: HttpOptions,
  buildServer: () => McpServer,
  log: (line: string) => void = () => {},
): Promise<RunningHttpServer> {
  let allowedHosts: string[] = []
  let allowedOrigins: string[] = []

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? '/'
    if (url !== MCP_HTTP_PATH && !url.startsWith(MCP_HTTP_PATH + '?')) {
      json(res, 404, { error: 'not found', hint: `MCP 端点在 ${MCP_HTTP_PATH}` })
      return
    }
    // 令牌先判、再谈别的：没令牌的请求连"MCP 认不认识这个方法"都不该知道。
    if (!isAuthorized(req.headers.authorization, opts.token)) {
      json(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: '未授权：缺少或不对的 Bearer 令牌' }, id: null })
      return
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,          // 无状态
      enableJsonResponse: true,               // 不强制 SSE：普通客户端拿 JSON 就好
      enableDnsRebindingProtection: true,     // SDK 默认 false，必须显式开
      allowedHosts,
      allowedOrigins,
    })
    const server = buildServer()
    res.on('close', () => { void transport.close(); void server.close().catch(() => {}) })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (error: any) {
      log(`[mcp-http] 请求处理失败: ${error?.message ?? error}`)
      if (!res.headersSent) {
        json(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: '内部错误' }, id: null })
      }
    }
  }

  const httpServer: Server = createServer((req, res) => { void handler(req, res) })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(opts.port, opts.host, () => {
      httpServer.removeListener('error', reject)
      resolve()
    })
  })

  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : opts.port
  // **绑定之后**才算白名单：端口传 0 时真实端口此刻才知道，而白名单必须用真实端口。
  allowedHosts = allowedHostsFor(opts.host, port)
  allowedOrigins = allowedOriginsFor(opts.host, port)

  const shownHost = opts.host === '::1' ? '[::1]' : opts.host
  return {
    url: `http://${shownHost}:${port}${MCP_HTTP_PATH}`,
    port,
    close: () => new Promise<void>((resolve) => { httpServer.close(() => resolve()) }),
  }
}
