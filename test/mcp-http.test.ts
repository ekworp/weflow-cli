/**
 * MCP 的 **HTTP 传输**。这一支盯的是"要不要把本机私密数据摊到一个网络端口上"这件事，
 * 所以判据几乎全是**拒绝**：默认不开、没令牌不开、令牌太短不开、非要绑回环不可、
 * 不带令牌的请求连端点长什么样都不该知道。
 *
 * 分两层：
 * 1. `httpConfig.ts` 是**纯函数**，规则一条条钉住（快、稳、不看环境）；
 * 2. 真起一个 HTTP 服务（端口传 0，让内核挑），用真请求打它 —— 判据是"401 还是 200"，
 *    以及"带令牌时返回的确实是那张 `wechat.*` 工具表"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const { resolveHttpOptions, isAuthorized, httpModeRequested, allowedHostsFor } =
  await import('../mcp-server/httpConfig.js')
const { startHttpServer, MCP_HTTP_PATH } = await import('../mcp-server/http.js')
const { buildServer } = await import('../mcp-server/index.js')

const TOKEN = 'a'.repeat(24) + 'b3f9'   // 长度过线、内容随意

// ---------------------------------------------------------------- 纯判定

test('默认是 stdio：什么都不给就不开 HTTP', () => {
  assert.equal(resolveHttpOptions({}, []), null)
  assert.equal(httpModeRequested({}, []), false)
  // 明确关掉也算关
  assert.equal(httpModeRequested({ WEFLOW_MCP_HTTP: '0' }, []), false)
  assert.equal(httpModeRequested({ WEFLOW_MCP_HTTP: 'false' }, []), false)
})

test('要开 HTTP 得给令牌，而且不给默认值', () => {
  // **没有**"自动生成一个"这条路：一个只在日志里露一面的口令，看起来像配好了
  assert.throws(() => resolveHttpOptions({}, ['--http']), /必须给令牌/)
  assert.throws(() => resolveHttpOptions({ WEFLOW_MCP_HTTP: '1' }, []), /必须给令牌/)
  assert.throws(() => resolveHttpOptions({}, ['--http', '--token=']), /必须给令牌/)
})

test('令牌太短不算数', () => {
  assert.throws(() => resolveHttpOptions({}, ['--http', '--token=short']), /令牌太短/)
})

test('只绑回环，别的地址一律拒（并告诉你怎么远程）', () => {
  for (const host of ['0.0.0.0', '192.168.1.5', '::', '10.0.0.1']) {
    assert.throws(() => resolveHttpOptions({}, ['--http', `--host=${host}`, `--token=${TOKEN}`]),
      /只允许绑回环/)
  }
  assert.equal(resolveHttpOptions({}, ['--http', '--host=127.0.0.1', `--token=${TOKEN}`])?.host, '127.0.0.1')
  assert.equal(resolveHttpOptions({}, ['--http', `--token=${TOKEN}`])?.host, '127.0.0.1', '默认回环')
})

test('端口解析：默认值、显式值、0（让内核挑），以及一堆不合法的', () => {
  assert.equal(resolveHttpOptions({}, ['--http', `--token=${TOKEN}`])?.port, 8790)
  assert.equal(resolveHttpOptions({}, ['--http=9100', `--token=${TOKEN}`])?.port, 9100)
  assert.equal(resolveHttpOptions({}, ['--http', '--port=9101', `--token=${TOKEN}`])?.port, 9101)
  assert.equal(resolveHttpOptions({}, ['--http=0', `--token=${TOKEN}`])?.port, 0, '0 = 内核挑')
  for (const bad of ['', 'abc', '70000', '-1', '12.5']) {
    assert.throws(() => resolveHttpOptions({}, ['--http', `--port=${bad}`, `--token=${TOKEN}`]), /端口/)
  }
  // 空值尤其要拒：`Number('') === 0`，不拦就会静默变成一个端口
  assert.throws(() => resolveHttpOptions({ WEFLOW_MCP_HTTP_PORT: '', WEFLOW_MCP_HTTP: '1' }, [`--token=${TOKEN}`]), /端口/)
})

test('令牌只认 Authorization: Bearer（方案名大小写不敏感）', () => {
  assert.equal(isAuthorized(`Bearer ${TOKEN}`, TOKEN), true)
  assert.equal(isAuthorized(`bearer ${TOKEN}`, TOKEN), true)
  assert.equal(isAuthorized(`BEARER ${TOKEN}`, TOKEN), true)
  assert.equal(isAuthorized(`Bearer  ${TOKEN} `, TOKEN), true, '多余空白容忍')

  assert.equal(isAuthorized(undefined, TOKEN), false)
  assert.equal(isAuthorized('', TOKEN), false)
  assert.equal(isAuthorized(TOKEN, TOKEN), false, '没有方案名不算')
  assert.equal(isAuthorized(`Basic ${TOKEN}`, TOKEN), false)
  assert.equal(isAuthorized(`Bearer ${TOKEN}x`, TOKEN), false)
  // 长度不同也走同一条路（比的是摘要），所以这里不能靠"长度不对就早退"来判断
  assert.equal(isAuthorized('Bearer a', TOKEN), false)
  assert.equal(isAuthorized(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN), false)
})

test('Host 白名单带上真实端口（DNS 重绑定防护比的是原始 Host 头）', () => {
  assert.deepEqual(allowedHostsFor('127.0.0.1', 8790), ['127.0.0.1:8790'])
  assert.deepEqual(allowedHostsFor('localhost', 8790).sort(), ['127.0.0.1:8790', 'localhost:8790'])
  assert.deepEqual(allowedHostsFor('::1', 8790), ['[::1]:8790'])
})

// ---------------------------------------------------------------- 真起一个服务

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const opts = resolveHttpOptions({}, ['--http=0', `--token=${TOKEN}`])!
  const running = await startHttpServer(opts, buildServer)
  try {
    await fn(`http://127.0.0.1:${running.port}`)
  } finally {
    await running.close()
  }
}

const rpc = (method: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
})

test('不带令牌：401，而且不透露端点认不认这个方法', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + MCP_HTTP_PATH, { ...rpc('tools/list'), headers: { ...rpc('tools/list').headers } })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.match(body.error.message, /未授权/)
    assert.equal(body.result, undefined)
  })
})

test('令牌不对：401（错的、方案名错的、只差一个字符的）', async () => {
  await withServer(async (base) => {
    for (const auth of ['Bearer wrong-token-wrong-token-wrong', `Basic ${TOKEN}`, `Bearer ${TOKEN.slice(0, -1)}`]) {
      const res = await fetch(base + MCP_HTTP_PATH, {
        ...rpc('tools/list'),
        headers: { ...rpc('tools/list').headers, authorization: auth },
      })
      assert.equal(res.status, 401, `这个不该放行: ${auth.slice(0, 12)}`)
    }
  })
})

test('带对令牌：能拿到工具表，且就是那张 wechat.* 表', async () => {
  await withServer(async (base) => {
    const first = await fetch(base + MCP_HTTP_PATH, {
      ...rpc('initialize'),
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      }),
      headers: { ...rpc('initialize').headers, authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(first.status, 200)

    const res = await fetch(base + MCP_HTTP_PATH, {
      ...rpc('tools/list'),
      headers: { ...rpc('tools/list').headers, authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    const names = (body.result?.tools ?? []).map((t: any) => t.name)
    assert.ok(names.length > 0, '工具表不该是空的')
    assert.ok(names.every((n: string) => n.startsWith('wechat.')), `工具名都该是 wechat.*：${names.slice(0, 3)}`)
    assert.ok(names.includes('wechat.search_articles'))
  })
})

test('别的路径：404（只有 MCP 端点存在）', async () => {
  await withServer(async (base) => {
    for (const path of ['/', '/mcp/../etc', '/healthz']) {
      const res = await fetch(base + path, { headers: { authorization: `Bearer ${TOKEN}` } })
      assert.equal(res.status, 404, path)
    }
  })
})

test('DNS 重绑定防护：Host 头对不上的请求被拒（SDK 默认是关的）', async () => {
  // **这里必须用 node:http，不能用 fetch**：`Host` 在 fetch 规范里是禁止头，undici 会拿 URL 里的
  // 值覆盖它 —— 用 fetch 写这条测试，请求里其实带着正确的 Host，看着"通过了"却什么都没测到
  // （第一版就是这么写的，实测返回 200）。
  const { request } = await import('node:http')
  await withServer(async (base) => {
    const port = Number(new URL(base).port)
    const send = (hostHeader: string) => new Promise<number>((resolve) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path: MCP_HTTP_PATH,
        method: 'POST',
        headers: {
          host: hostHeader,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${TOKEN}`,
        },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
    })
    assert.ok((await send(`127.0.0.1:${port}`)) < 400, '对照：真 Host 应当放行')
    const evil = await send('evil.example.com')
    assert.ok(evil >= 400, `Host 头不是白名单里的，不该当正常请求处理（拿到 ${evil}）`)
  })
})

test('只绑回环：服务报出来的地址是 127.0.0.1', async () => {
  const opts = resolveHttpOptions({}, ['--http=0', `--token=${TOKEN}`])!
  const running = await startHttpServer(opts, buildServer)
  try {
    assert.match(running.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  } finally {
    await running.close()
  }
})
