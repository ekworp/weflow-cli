/** 知识库检索、概念页、公开文章。 */
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { runPythonJson } from '../pythonBridge.js'
import { privacyGate } from '../assistantPrivacy.js'
import { isAllowedWeChatArticleUrl } from '../../utils/mcpSecurity.js'
import { wikiIndexPath, vaultDirs, vaultLineId, vaultLineLabel, toolLine, lineLabelOf, pageBody } from './paths.js'
import { conceptSubgraph, conceptNeighbors } from './concepts.js'
import { fetchArticleHtml, readTextLimited, articleTextFromHtml } from './html.js'
import { boundedToolInteger, fail, confirmPreview } from './runtime.js'
import type { ToolContext } from './types.js'

export async function handleSearchKnowledge(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const kw = String(args.keyword || '')
  if (!kw) return '(缺少 keyword 参数)'
  const line = toolLine(args.line)
  if (!line) return `(line 只能是 wiki / chat / all，收到「${String(args.line)}」)`
  const all = vaultDirs().filter(dir => existsSync(dir))
  if (!all.length) return '(知识库尚未生成, 先运行 weflow-cli wiki compile)'
  // **默认只搜文章线**（两条线分开是用户要求的）；`line: 'all'` 才两条一起搜。
  // 范围一定要写在输出里：不说的话，"这一条线里没有"会被读成"整个知识库里没有"。
  const liveDirs = line === 'all' ? all : all.filter(dir => vaultLineId(dir) === line)
  if (!liveDirs.length) {
    return `(${lineLabelOf(line)}还没有概念页——知识库里现在只有${all.map(vaultLineLabel).join('、')}；`
      + `要看那些用 line: 'all')`
  }
  const entries: Array<{ dir: string; file: string; where: string }> = []
  let total = 0
  for (const dir of liveDirs) {
    // 标注来源，好让模型（和读日志的人）知道这条来自哪个知识库
    const where = vaultLineId(dir) === 'chat' ? '聊天' : '文章'
    for (const file of readdirSync(dir).filter(f => f.endsWith('.md'))) {
      entries.push({ dir, file, where })
      total += 1
    }
  }
  const hits = entries.filter(e => e.file.replace('.md', '').toLowerCase().includes(kw.toLowerCase()))
  if (!hits.length) {
    // **只搜正文，不搜「来源」段。** 页面的来源段可能列 300+ 条文章标题（2026-09-27 那批
    // 改动之后就是这样），拿整个文件做包含判断，会把「某篇来源的**标题**里含这个词」报成
    // 「**正文**提及」—— 实测 `Grok-4` 命中 4 张页、其中 3 张的正文里根本没有它。
    // `assistant-eval` 的 `knowledge-fallback-not-body` 钉住这件事。
    //
    // 顺带把**那一句**给出去：只给页名的话模型会自己补内容（实测它补出过「Grok-4 是作为
    // 被测试的模型之一出现的」，那是它从别处知道的，不是这一页里写的）。
    const contentHits = entries.map(e => {
      const text = pageBody(readFileSync(join(e.dir, e.file), 'utf8'))
      const at = text.toLowerCase().indexOf(kw.toLowerCase())
      if (at === -1) return null
      // （局部变量别叫 `line`：外层那个 `line` 是"搜哪条知识库"，同名会把它遮住）
      const snippetLine = text.slice(Math.max(0, at - 80), at + 160)
        .split('\n').find(l => l.includes(kw)) || ''
      return { ...e, snippet: snippetLine.trim().slice(0, 180) }
    }).filter((e): e is { dir: string; file: string; where: string; snippet: string } => e !== null)
      .slice(0, 5)
    if (!contentHits.length) {
      // **说清是哪个范围里没收录**：只写"知识库未收录"会被读成整个知识库都没有
      return `(${lineLabelOf(line)}没收录「${kw}」, 这一趟看了 ${total} 个概念页`
        + (line === 'all' ? ')' : '；`line: \'all\'` 可以连另一条线一起搜)')
    }
    return `正文提及「${kw}」的概念页（${lineLabelOf(line)}）:` + '\n'
      + contentHits.map(e => `· ${e.file.replace('.md', '')}（${e.where}）: ${e.snippet}`).join('\n')
  }
  const hit = hits[0]
  const name = hit.file.replace('.md', '')
  const page = readFileSync(join(hit.dir, hit.file), 'utf8')
  // 两条线各有一张同名页是**设计**（两个命名空间分开）。只给第一条会让模型以为另一条
  // 没有这个概念 —— 而它可能正是用户问的那一条（"我们聊过的"vs"公众号里读到的"）。
  const alsoIn = hits.filter(h => h.where !== hit.where).map(h => h.where)
  const alsoNote = alsoIn.length ? `（另一个同名页在${alsoIn.join('、')}知识库：line: 'all' 两条都看）` : ''
  // **顺带把邻居给出去**（见 `conceptNeighbors`）：一次调用拿到"这个概念 + 连着它的一小块子图"。
  // 不点明"可以再用本工具查其中任意一个"的话，模型会把它当装饰性文字读过去。
  const depth = boundedToolInteger(args.depth, 1, 3, 'depth')
  // **从命中的那一条线开始**（`hit.dir`）：同名概念两条线各一张，不指定起点的话
  // 永远走文章线那张 —— 而上面刚刚才告诉模型"另一条线也有这个概念"
  const { levels, truncated, missing } = conceptSubgraph(name, depth, 30, vaultDirs(), hit.dir)
  const out = [`「${name}」概念页（${hit.where}知识库）${alsoNote}:`, page.slice(0, 2000)]
  if (levels.length) {
    out.push('', depth > 1
      ? `—— 它周围的概念（${depth} 跳；「←」标出是从哪个概念连过来的）——`
      : '—— 它连到的概念（可以再用本工具查其中任意一个，或者加 depth 参数一次多看几跳）——')
    levels.forEach((level, index) => {
      if (levels.length > 1) out.push(`第 ${index + 1} 跳：`)
      for (const nb of level) {
        out.push(depth > 1 ? `· ${nb.name} ← ${nb.via} — ${nb.brief}` : `· ${nb.name} — ${nb.brief}`)
      }
    })
    // 封顶了要**说出来**：默默少给的话，模型会以为这就是全部
    if (truncated) out.push(`（图太大，只给了前 ${levels.flat().length} 个概念；
想看某个分支可以单独查它）`)
  }
  if (missing) out.push(`（另有 ${missing} 个相关概念尚未建页，查不到）`)
  return out.join('\n')
}

export async function handleSearchSemantic(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  // 语义/同义检索（向量相似度 + 决策模型重排）。字面词搜不到时用这条。
  // **出境说明**：查询词要发阿里云百炼做嵌入，候选片段要发判断模型重排——
  // 两者都在仓库既有的云端路径上（不是新类别），但这里如实写出来。
  const query = String(args.query || '').trim()
  if (!query) return '(缺少 query 参数)'
  const line = toolLine(args.line)
  if (!line) return `(line 只能是 wiki / chat / all，收到「${String(args.line)}」)`
  const topK = boundedToolInteger(args.top_k, 8, 20, 'top_k')
  // 外部机器默认只给预览（`semantic_search.py` 没有 --dry-run，按入参说清）
  if (ctx.requiresConfirm && args.confirm !== true) {
    return confirmPreview(`会把查询词「${query.slice(0, 40)}」发给阿里云百炼做嵌入，`
      + `再把前 ${topK} 条命中的本地片段（可能含聊天或文章原文）发给判断模型 Jev 重排。`
      + (args.with_text === true
        ? '你还要了正文：正文会一并进入模型上下文（每条约 1500 字）。' : ''))
  }
  // **查询词走环境变量、不进 argv**：仓库写进测试的隐私纪律（进程列表里看不到正文）
  const withText = args.with_text === true
  const result = await runPythonJson<any>('semantic_search.py',
    ['search', '--top-k', String(topK), '--line', line,
      ...(withText ? ['--with-text', '1500'] : [])],
    { env: { WEFLOW_SEARCH_QUERY: query }, timeoutMs: 90_000 })
  if (!result.ok) return fail('语义检索失败（索引可能还没建：weflow-cli search-index）', result)
  if (result.data && typeof result.data.error === 'string') {
    return `(语义检索没跑成：${String(result.data.error).slice(0, 120)})`
  }
  if (!result.data || !Array.isArray(result.data.results)) {
    // **形状不对要响，不能降级成"没有结果"**：脚本那边 `search` 的输出是一个带
    // `line` / `results` 的对象，而"读不到"和"搜不到"在界面上长得一模一样
    // （`(语义检索没有结果)`）—— 那正是这个仓库一直在防的那种静默。
    return `(语义检索返回了看不懂的形状：${JSON.stringify(result.data).slice(0, 120)})`
  }
  const rows = result.data.results
  const note = String(result.data.note || '')
  const scope = String(result.data.lineLabel || lineLabelOf(line))
  if (!rows.length) {
    return `(语义检索在${scope}里没有结果「${query}」${note ? '：' + note : ''}`
      + `${line === 'all' ? ')' : '；`line: \'all\'` 两条线一起搜)'}`
  }
  const nl = String.fromCharCode(10)
  const header = `语义检索「${query}」（范围：${scope}）前 ${rows.length} 条`
    + (withText ? '，每条带正文' : '') + '：'
  return header + nl + rows.map((row: any) => {
    const title = String(row.title || row.source || '(无标题)').slice(0, 40)
    const score = typeof row.score === 'number' ? `（${row.score.toFixed(2)}）` : ''
    if (withText) {
      // **正文路径**：脚本用 --with-text 取的是**本地那份正文**，不是用来匹配的摘录。
      // 它同样要进模型上下文，所以照旧过遮罩；取不到正文就退回片段，别给空的。
      const body = privacyGate.maskMessageBody(
        String(row.fullText || row.text || '').replace(/\n{3,}/g, '\n\n').trim())
      return `· ${title}${score}${body ? nl + body : ''}`
    }
    const text = privacyGate.maskMessageBody(
      String(row.text || row.content || '').replace(/\s+/g, ' ').slice(0, 80))
    return `· ${title}${score}${text ? nl + '    ' + text : ''}`
  }).join(nl)
}

export async function handleSearchPublic(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const keyword = String(args.keyword || '').trim()
  if (!keyword) return '(参数错误: 缺少 keyword)'
  const limit = boundedToolInteger(args.limit, 8, 20)
  let html = ''
  try {
    const resp = await fetch(
      `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(keyword)}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Referer': 'https://weixin.sogou.com/',
          'Accept': 'text/html',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: AbortSignal.timeout(20_000),
      },
    )
    html = await readTextLimited(resp, 2 * 1024 * 1024)
  } catch {
    return '(搜索失败——检查网络，或者稍后再试（第三方搜索页会限流）)'
  }
  const grab = (re: RegExp, clean: (s: string) => string): string[] => {
    const out: string[] = []
    for (const m of html.matchAll(re)) {
      const v = clean(m[1])
      if (v) out.push(v)
    }
    return out
  }
  const titles = grab(/<h3[^>]*>\s*<a[^>]*>(.*?)<\/a>\s*<\/h3>/gs,
    s => s.replace(/<em[^>]*>/g, '').replace(/<\/em>/g, '').replace(/<!--[^>]*-->/g, '').trim())
  const accounts = grab(/<span[^>]*class="[^"]*all-time-y2[^"]*"[^>]*>(.*?)<\/span>/gs,
    s => s.replace(/<[^>]+>/g, '').trim())
  const descs = grab(/<p[^>]*class="[^"]*txt-info[^"]*"[^>]*>(.*?)<\/p>/gs,
    s => s.replace(/<[^>]+>/g, '').replace(/&hellip;/g, '…').replace(/&rarr;/g, '→').replace(/&mdash;/g, '—').trim())
    .filter(d => d.length > 10)
  const count = Math.max(titles.length, accounts.length, descs.length)
  if (!count) {
    return `(没搜到与「${keyword}」相关的公开文章。换个说法、或加上公众号名试试；`
      + '找到链接后可以用 fetch_article 抓全文)'
  }
  const rows: string[] = []
  for (let i = 0; i < Math.min(count, limit); i++) {
    rows.push(`${i + 1}. ${titles[i] || '(未知标题)'}\n   公众号: ${accounts[i] || '(未知)'}`
      + (descs[i] ? `\n   ${descs[i]}` : ''))
  }
  return `公开文章里搜「${keyword}」，命中 ${Math.min(count, limit)} 条:\n`
    + rows.join('\n')
    + '\n（这是第三方搜索页的标题与摘要，不是全文；要正文用 fetch_article 抓）'
}

export async function handleGetConcepts(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const limit = boundedToolInteger(args.limit, 40, 120)
  const out: string[] = []
  for (const dir of vaultDirs()) {
    const line = dir.split(/[\\/]/).includes('Chat') ? '聊天线' : '文章线'
    const index = wikiIndexPath(dir)
    if (!existsSync(index)) { out.push(`【${line}】还没有总览索引（还没编译过这一线的知识库）`); continue }
    const text = readFileSync(index, 'utf8')
    const rows = text.split(/\r?\n/).filter(l => l.trim()).slice(0, limit)
    out.push(`【${line}】${rows.length} 行:\n${rows.join('\n')}`)
  }
  return out.join('\n\n')
}

export async function handleLintWiki(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  // 两个知识库都要查（本仓的分线纪律：只查一个，另一半的断链永远看不见）
  const parts: string[] = []
  let totalBad = 0
  // **真正体检过几条线。"跳过"不算"没问题"**：CI 上（检出里没有 `output/wechat-vault`）
  // 两条线都只打「目录不存在，跳过」，而下面那一支原来照样会加一句"两个知识库都没有断链…"
  // —— 没看过却说干净。用户没编译过知识库时也会撞上同一句话。
  let checked = 0
  for (const dir of vaultDirs()) {
    // **线名优先由 Python 那边给**（`report.lineLabel`，源头是 `_utils.LINE_LABELS`）：
    // 两条线各自一个根之后聊天线很可能不再叫 `Chat`，按路径猜会把聊天线报成
    // **文章线**，还不报错。`guess` 只在目录不存在（来不及问 Python）与自定义
    // `--dir` 认不出线时兜底。
    const guess = vaultLineLabel(dir)
    if (!existsSync(dir)) { parts.push(`【${guess}】目录不存在，跳过`); continue }
    // 超时给 60 秒：本机最大的一条线（3,623 页）实测 **3.4 秒**（脚本里的 O(n²) 修掉之后，
    // 见 wiki_lint.py 那条注释），17 倍余量够用。默认的 30 秒曾经也超——那是因为脚本本身慢，
    // 不是超时给得小。
    const r = await runPythonJson<any>('wiki_lint.py', ['--dir', dir, '--json'], { timeoutMs: 60_000 })
    if (!r.ok || !r.data) {
      // 失败要说出来：静默跳过会让"体检通过"变成一句假话
      parts.push(`【${guess}】体检失败: ${r.error || '读不到结果'}`)
      totalBad += 1
      continue
    }
    const d = r.data
    const line = d.lineLabel || guess
    const broken = (d.broken || []).length
    const orphans = (d.orphans || []).length
    const empty = (d.empty || []).length
    const dup = Object.keys(d.duplicateTitles || {}).length
    // 跨线同名**不计入问题数**：两条线各留一张同名页是设计（两个命名空间分开），
    // 把它算成"要修的"会让人去修一个设计如此的东西。
    const cross = (d.crossLineSameName || []).length
    checked += 1
    totalBad += broken + orphans + empty + dup
    parts.push(`【${line}】${d.pages || 0} 张页：断链 ${broken}、孤儿 ${orphans}、空页 ${empty}、同名 ${dup} 组`
      + (cross ? `（另有 ${cross} 个概念两条线都有，设计如此）` : ''))
  }
  return (checked && !totalBad ? '两个知识库都没有断链/孤儿/空页/同名。\n' : '') + parts.join('\n')
}

export async function handleFetchArticle(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const url = String(args.url || '').trim()
  // **严格白名单，不是 denylist**：只认 https 的 mp.weixin.qq.com。
  // 这条比 read_favorite 那条严，因为那里的链接是用户自己收藏的，这里的 URL 是别人给的。
  if (!isAllowedWeChatArticleUrl(url)) {
    return `(只接受 https 的 mp.weixin.qq.com 文章链接，拒绝抓取: ${url.slice(0, 60)})`
  }
  const maxChars = boundedToolInteger(args.max_chars, 3000, 6000)
  // 逐跳复检：一次 302 就能把入口白名单绕过去
  const { status, html } = await fetchArticleHtml(url,
    { maxRedirects: 3, allowHop: isAllowedWeChatArticleUrl })
  if (!html) return `(抓取失败 HTTP ${status} —— 链接可能不是公众号文章，或者跳转到了别处)`
  if (html.includes('已被发布者删除')) return '(这篇文章已被发布者删除)'
  const body = articleTextFromHtml(html, maxChars)
  if (!body.trim() || (body.match(/[一-鿿]/g) || []).length < 20) {
    return '(抓到了页面但取不出正文——可能是验证页，或者这篇文章要登录/已失效)'
  }
  const title = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i)?.[1]
    || html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() || ''
  const author = html.match(/var\s+nickname\s*=\s*"([^"]+)"/i)?.[1]
    || html.match(/<meta[^>]*property="og:article:author"[^>]*content="([^"]+)"/i)?.[1] || ''
  // 配图只报数量与前几个链接：正文是纯文本，但图往往就是这篇文章的要点
  const imgs = [...html.matchAll(/data-src="(https?:\/\/[^"]+)"/g)].map(m => m[1]).slice(0, 5)
  const head = [title && `标题: ${title}`, author && `公众号: ${author}`].filter(Boolean).join(' | ')
  const tail = imgs.length ? `\n\n配图 ${imgs.length} 张(前几张):\n${imgs.map(u => `· ${u}`).join('\n')}` : ''
  return (head ? `${head}\n---\n` : '') + body + tail
}

export async function handleFormatArticle(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const content = String(args.content || '')
  if (!content.trim()) return '(参数错误: content 不能为空)'
  const { formatWeChatArticle } = await import('../wechat-formatter.js')
  const theme = String(args.theme || 'default')
  const html = formatWeChatArticle(content, { theme: theme as any })
  const preview = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').slice(0, 200)
  return `主题: ${theme}\n总长度: ${html.length} 字符\n正文预览: ${preview}…\n---\n${html}`
}
