/** 日报、回顾、阅读统计。 */
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { chatService } from '../chatService.js'
import { runPythonJson } from '../pythonBridge.js'
import { safeDate } from '../../utils/mcpSecurity.js'
import { bizDailyDir, reviewsDir, wikiIndexPath, vaultDirs, vaultLineLabel } from './paths.js'
import { ensureDb, lastDailyNote, boundedToolInteger, fail } from './runtime.js'
import type { ToolContext } from './types.js'

export async function handleGetDailyReport(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const dates = existsSync(bizDailyDir())
    ? readdirSync(bizDailyDir()).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()
    : []
  if (!dates.length) return '(还没有日报数据, 先运行 biz_daily 生成)'
  const readArticles = (date: string): any[] | null => {
    const file = join(bizDailyDir(), date, '.articles.json')
    if (!existsSync(file)) return null
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(raw) ? raw : (raw.articles || Object.values(raw))
    } catch { return null }
  }
  const fmt = (a: any) => {
    const summary = (a.summary || '').replace(/\s+/g, ' ').slice(0, 80)
    const where = a.date ? `${a.date} ` : ''
    return `· ${where}[${a.topic}] ${a.title} (${a.source})${summary ? `\n  ${summary}` : ''}`
  }
  const limit = boundedToolInteger(args.limit, 15, 30)

  // 不给 date 但给了关键词 → 跨日期搜（MCP 那边原本叫 search_articles，两个工具搜的
  // 是同一批文章、只是范围不同，模型无从判断该用哪个，所以合并成一个）。
  const wantDate = args.date ? safeDate(args.date) : null
  if (args.date && !wantDate) return `(日期格式不对: ${args.date}，要 YYYY-MM-DD)`
  if (!wantDate && (args.keyword || args.topic)) {
    const days = boundedToolInteger(args.days, 7, 60)
    const window = dates.slice(0, days)
    const hits: any[] = []
    let scanned = 0
    for (const d of window) {
      const arts = readArticles(d)
      if (!arts) continue
      scanned += arts.length
      for (const a of arts) {
        if (args.topic && a.topic !== args.topic) continue
        if (args.keyword) {
          const kw = String(args.keyword).toLowerCase()
          const hay = `${a.title || ''} ${a.summary || ''} ${a.source || ''}`.toLowerCase()
          if (!hay.includes(kw)) continue
        }
        hits.push({ ...a, date: d })
      }
    }
    if (!hits.length) {
      return `(最近 ${window.length} 天的日报里（共 ${scanned} 篇）没有匹配`
        + `${args.keyword ? `「${args.keyword}」` : `主题 ${args.topic}`} 的文章)`
    }
    return `最近 ${window.length} 天里匹配 ${hits.length} 篇（共扫 ${scanned} 篇）:\n`
      + hits.slice(0, limit).map(fmt).join('\n')
  }

  const date = wantDate || dates[0]
  const all = readArticles(date)
  if (!all) return `(${date} 没有日报。可用日期: ${dates.slice(0, 5).join(', ')})`
  // `full`：给的是当天那份人读的日报正文（README.md），不是条目清单。
  // 不加这个参数，模型想"把那天的日报念一段"就只能拿到标题列表。
  if (args.full) {
    const readme = join(bizDailyDir(), date, 'README.md')
    if (!existsSync(readme)) return `(${date} 没有日报正文文件，只有条目)`
    const maxChars = boundedToolInteger(args.max_chars, 3000, 6000)
    return `${date} 日报正文（${all.length} 篇）:\n${readFileSync(readme, 'utf8').slice(0, maxChars)}`
  }
  let list = all
  if (args.topic) list = list.filter(a => a.topic === args.topic)
  if (args.keyword) {
    const kw = String(args.keyword).toLowerCase()
    list = list.filter(a =>
      (a.title || '').toLowerCase().includes(kw) || (a.summary || '').toLowerCase().includes(kw))
  }
  if (!list.length) return `(${date} 日报共 ${all.length} 篇, 过滤后无匹配)`
  const byTopic: Record<string, number> = {}
  for (const a of all) byTopic[a.topic] = (byTopic[a.topic] || 0) + 1
  const topicStat = Object.entries(byTopic).map(([t, n]) => `${t}${n}篇`).join(' ')
  return `${date} 日报共 ${all.length} 篇 (${topicStat}), 匹配 ${list.length} 篇:\n` +
    list.slice(0, limit).map(fmt).join('\n')
}

export async function handleGetReview(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const dir = reviewsDir()
  if (!existsSync(dir)) {
    // 说清"这个目录本来就还没生成"，而不是让模型以为"今天没有回顾"
    return '(还没有学习回顾——它不是日报自动产的，要单独跑 `weflow-cli review`)'
  }
  const files = readdirSync(dir).filter(f => /^Daily-\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse()
  if (!files.length) return '(学习回顾目录是空的)'
  const want = args.date ? safeDate(args.date) : null
  if (args.date && !want) return `(日期格式不对: ${args.date}，要 YYYY-MM-DD)`
  const pick = want ? files.find(f => f.includes(want)) : files[0]
  if (!pick) {
    return `(${want} 没有学习回顾。最近几份: ${files.slice(0, 3).map(f => f.slice(6, 16)).join(', ')})`
  }
  const maxChars = boundedToolInteger(args.max_chars, 3000, 6000)
  const body = readFileSync(join(dir, pick), 'utf8')
  const date = pick.slice(6, 16)
  return `${date} 学习回顾:\n${body.slice(0, maxChars)}`
}

export async function handleGetReadingStats(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const days = boundedToolInteger(args.days, 7, 90, 'days')
  const r = await runPythonJson<any>('daily_stats.py',
    ['--days', String(days), '--json'], { timeoutMs: 60_000 })
  if (!r.ok) return fail('读取公众号统计失败', r)
  const rows: any[] = r.data?.sources ?? []
  if (!rows.length) return `(最近 ${days} 天没有公众号推送记录)`
  const period = r.data?.period ?? {}
  const byPushed = [...rows].sort((a, b) => (b.pushed ?? 0) - (a.pushed ?? 0)).slice(0, 5)
  const lines = [`最近 ${days} 天（${period.start} 至 ${period.end}）：${rows.length} 个公众号有推送`]
  lines.push('发得最多：' + byPushed.map(x => `${x.name}(${x.pushed})`).join('、'))
  const processed = rows.filter(x => (x.processed ?? 0) > 0)
    .sort((a, b) => (b.processed ?? 0) - (a.processed ?? 0)).slice(0, 5)
  if (processed.length) {
    lines.push('日报处理得最多：' + processed.map(x => `${x.name}(${x.processed})`).join('、'))
  } else {
    // **直说日报没在跑**：这时"处理数 0"不是"这些号没内容"，而是日报压根没运行。
    // 把它混成"没读到东西"，用户会去查号，而该查的是日报任务。
    lines.push(`这 ${days} 天日报没有任何处理记录` + lastDailyNote())
  }
  return lines.join('\n')
}

export async function handleGetStats(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  await ensureDb()
  const sessions = await chatService.listSessions(undefined, 1000)
  const fav = await chatService.getFavorites({ limit: 1 })
  const lines = [`会话数: ${sessions.length}`, `收藏总数: ${fav.success ? fav.total : '未知'}`]
  // 知识库那一半：MCP 的手写 get_stats 一直有、助手这边缺。同一个工具名在两个界面
  // 报的东西不一样，是最容易让人误判成数据丢了的那种不一致。
  const dates = existsSync(bizDailyDir())
    ? readdirSync(bizDailyDir()).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
    : []
  let articleCount = 0
  const topics: Record<string, number> = {}
  for (const d of dates) {
    const file = join(bizDailyDir(), d, '.articles.json')
    if (!existsSync(file)) continue
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const arts: any[] = Array.isArray(raw) ? raw : (raw.articles || [])
      articleCount += arts.length
      for (const a of arts) topics[a.topic || '未知'] = (topics[a.topic || '未知'] || 0) + 1
    } catch { /* 某一天的文件坏了不该让整个统计失败 */ }
  }
  if (dates.length) {
    lines.push(`日报文章: ${articleCount} 篇，覆盖 ${dates.length} 天（${dates[0]} ~ ${dates[dates.length - 1]}）`)
    const top = Object.entries(topics).sort((a, b) => b[1] - a[1]).slice(0, 6)
    if (top.length) lines.push(`主题分布: ${top.map(([t, n]) => `${t}${n}`).join('、')}`)
  } else {
    lines.push('日报文章: 还没有日报数据')
  }
  const conceptCounts: string[] = []
  for (const dir of vaultDirs()) {
    const idx = wikiIndexPath(dir)
    if (!existsSync(idx)) continue
    const m = readFileSync(idx, 'utf8').match(/共\s*(\d+)\s*个概念/)
    if (m) conceptCounts.push(`${vaultLineLabel(dir)} ${m[1]}`)
  }
  if (conceptCounts.length) lines.push(`概念页: ${conceptCounts.join('、')}`)
  return lines.join('\n')
}
