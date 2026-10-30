/** 网页抓取与正文抽取：SSRF 白名单、WAF 挑战页、HTML 去标签。 */
import { join } from 'path'

/** SSRF 防护: 仅 http(s), 拒绝内网/环回地址
 *
 * 导出是为了能测它：这是**抓取前的安全边界**，而它守着的是"别让助手被一条收藏里的链接
 * 带去访问内网"。纯函数，没有副作用。
 */
export function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const h = u.hostname.toLowerCase()
    if (!h) return false

    // IPv6 字面量（URL 里带方括号）。Node 会把 [0:0:0:0:0:0:0:1] 归一成 [::1]，
    // 但不碰 [fd00::1] 这类——所以下面按前缀逐个挡。
    if (h.startsWith('[')) {
      const inner = h.slice(1, -1)
      if (inner === '::' || inner === '::1') return false
      if (inner.startsWith('::ffff:')) return false      // IPv4 映射（可能是 127.0.0.1）
      if (/^f[cd]/.test(inner)) return false             // fc00::/7 唯一本地
      if (/^fe[89ab]/.test(inner)) return false          // fe80::/10 链路本地
      return true
    }

    if (h === 'localhost') return false
    // 纯数字或 0x 形式的整型主机名：内核会把它当 IPv4 用，而域名不可能是这种形状。
    // （实测 Node 对 2130706433 / 0x7f000001 会归一成 127.0.0.1，这道是双保险。）
    if (/^(0x[0-9a-f]+|[0-9]+)$/.test(h)) return false
    // 私网前缀**只在真的是点分四段时**才判：否则 `10.example.com` 这种公网域名会被
    // `^10\.` 误杀，工具会回一句「链接不安全，拒绝抓取」，而链接其实是好的。
    if (/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(h)) {
      if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return false
      if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return false
    }
    // 这是一份已知形态的黑名单，不是"这地址一定可公网路由"的证明：
    // NAT64（64:ff9b::/96）等映射形式不在覆盖范围内。
    return true
  } catch { return false }
}

/** 标签剥离 → 纯文本 */
export function stripTags(seg: string): string {
  return seg.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map(s => s.trim()).filter(Boolean).join('\n')
}

/** WAF 挑战页兜底: 正文藏在 cgiDataNew.content_noencode (JS 转义字符串) */
export function extractFromChallengePage(html: string): string | null {
  const start = html.indexOf("content_noencode: '")
  if (start < 0) return null
  let i = start + "content_noencode: '".length
  let out = ''
  while (i < html.length && out.length < 1_000_000) {
    const ch = html[i]
    if (ch === "'") break
    if (ch === '\\' && i + 1 < html.length) {
      const n = html[i + 1]
      if (n === 'x' && i + 3 < html.length) {
        out += String.fromCharCode(parseInt(html.slice(i + 2, i + 4), 16))
        i += 4
        continue
      }
      if (n === 'n') { out += '\n'; i += 2; continue }
      if (n === 'r') { out += '\r'; i += 2; continue }
      if (n === 't') { out += '\t'; i += 2; continue }
      if (n === '\\' || n === "'" || n === '"') { out += n; i += 2; continue }
    }
    out += ch
    i++
  }
  return out.length > 100 ? out : null
}

/** 从 HTML 提取正文文本 (微信公众号 js_content 优先, 配平 div 边界; 兜底 body) */
export function extractText(html: string): string {
  let seg = html
  const jc = html.indexOf('id="js_content"')
  if (jc >= 0) {
    // 配平 <div/</div> 找 js_content 完整区块; depth 从 1 起算 (自身开标签位于 jc 之前)
    let depth = 1, end = -1
    const tag = /<\/?div\b/g
    tag.lastIndex = jc
    let m: RegExpExecArray | null
    while ((m = tag.exec(html))) {
      if (m[0] === '</div') { depth--; if (depth === 0) { end = m.index; break } }
      else depth++
    }
    seg = end > jc ? html.slice(jc, end) : html.slice(jc, jc + 100_000)
  } else {
    const body = html.indexOf('<body')
    if (body >= 0) seg = html.slice(body)
  }
  return stripTags(seg)
}

/** 确保数据库已连接 (connect 幂等, 已连接时直接返回) */
/**
 * 抓页面 HTML：微信内置浏览器 UA + Referer 绕 WAF，最多试两次。`read_favorite` 与 `fetch_article` 共用。
 *
 * `maxRedirects > 0` 时**自己跟跳转并逐跳复检白名单**：默认的 `redirect: 'follow'` 只看入口，
 * 一次 302 就能把白名单绕过去（拿到一个被允许的入口，跳到内网地址）。`fetch_article`
 * 收的是用户/模型给的任意 URL，所以要这道闸；`read_favorite` 收的是用户**自己收藏**的链接，
 * 保持原行为不动（那里用 denylist，且收藏里本来就有各种站）。
 */
export async function fetchArticleHtml(
  url: string,
  opts: { maxRedirects?: number; allowHop?: (u: string) => boolean } = {},
): Promise<{ status: number; html: string }> {
  const maxRedirects = opts.maxRedirects ?? 0
  let current = url
  let lastStatus = 0
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (maxRedirects > 0 && opts.allowHop && !opts.allowHop(current)) {
      return { status: lastStatus, html: '' }   // 某一跳出了白名单：宁可空手而归
    }
    let html = ''
    let status = 0
    let followed = false
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(current, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.38(0x18002633) NetType/WIFI Language/zh_CN',
            'Referer': 'https://mp.weixin.qq.com/',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'zh-CN,zh;q=0.9',
          },
          ...(maxRedirects > 0 ? { redirect: 'manual' as const } : {}),
          signal: AbortSignal.timeout(20_000),
        })
        status = res.status
        if (maxRedirects > 0 && status >= 300 && status < 400) {
          const location = res.headers.get('location')
          if (!location) return { status, html: '' }
          current = new URL(location, current).toString()
          followed = true
          break     // 换一跳，重来
        }
        html = (await res.text()).slice(0, 500_000)
        // 正文验证: 必须含 js_content (否则是验证页, 重试)
        if (res.ok && html.includes('js_content')) break
      } catch { /* 超时/网络错误 → 重试 */ }
    }
    if (html) return { status, html }
    lastStatus = status
    // 没跟跳转就走完了两次尝试：就是抓不到，别再拿同一个地址重试下去
    if (!followed) return { status, html: '' }
  }
  return { status: lastStatus, html: '' }
}

/** 读响应体但设上限：第三方搜索页可能很大，不让它把内存吃掉（超了就截断，不报错） */
export async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  const buf = await response.arrayBuffer()
  return Buffer.from(buf).subarray(0, maxBytes).toString('utf8')
}

/**
 * 从抓到的 HTML 里取正文：优先正常页面的 `js_content`，取不到再走 WAF 挑战页的 `content_noencode`。
 * 返回的文本已按 `maxChars` 截断。
 */
export function articleTextFromHtml(html: string, maxChars: number): string {
  let text = html.includes('js_content') ? extractText(html) : ''
  if (!text || (text.match(/[一-鿿]/g) || []).length < 50) {
    const decoded = extractFromChallengePage(html)
    if (decoded) text = stripTags(decoded)
  }
  return text.slice(0, maxChars)
}
