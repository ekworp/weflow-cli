/** 朋友圈与微信读书。 */
import { join } from 'path'
import { chatService } from '../chatService.js'
import { configService } from '../configService.js'
import { fmtTime } from './transcript.js'
import { ensureDb, boundedToolInteger } from './runtime.js'
import type { ToolContext } from './types.js'

export async function handleGetSns(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  await ensureDb()
  if (String(args.mode || 'timeline') === 'users') {
    // 谁常发朋友圈：本地把最近的时间线按发帖人聚合。**不新增出境**——数据本来就在这一条工具里。
    const r = await chatService.getSnsTimeline({ limit: 200 })
    if (!r.success || !r.timeline?.length) {
      return r.error ? `(朋友圈查询失败: ${r.error})` : '(朋友圈暂无缓存数据)'
    }
    const byAuthor = new Map<string, number>()
    for (const post of r.timeline) {
      const who = String(post.nickname || post.username || '未知')
      byAuthor.set(who, (byAuthor.get(who) ?? 0) + 1)
    }
    const ranked = [...byAuthor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    const nl = String.fromCharCode(10)
    return `最近 ${r.timeline.length} 条朋友圈里，发得最多的：`
      + ranked.map(([who, n]) => `${nl}· ${who}：${n} 条`).join('')
  }
  if (String(args.mode || 'timeline') === 'stats') {
    const r = await chatService.getSnsExportStats()
    if (!r.success) return `(朋友圈统计失败: ${r.error})`
    const d = r.data!
    return `朋友圈统计: 总动态 ${d.totalPosts} 条, 发布过动态的好友 ${d.totalFriends} 人${d.myPosts != null ? `, 用户自己发过 ${d.myPosts} 条` : ''}`
  }
  const limit = boundedToolInteger(args.limit, 10, 20)
  const r = await chatService.getSnsTimeline({ limit })
  if (!r.success || !r.timeline?.length) return r.error ? `(朋友圈查询失败: ${r.error})` : '(朋友圈暂无缓存数据)'
  return `最新 ${r.timeline.length} 条朋友圈:\n` + r.timeline.slice(0, limit).map((p: any) => {
    const content = (p.content || '').replace(/\s+/g, ' ').slice(0, 100)
    return `· [${fmtTime(p.create_time)}] ${p.nickname || p.username}: ${content}${p.media_count ? ` [${p.media_count}图]` : ''}`
  }).join('\n')
}

export async function handleGetWeread(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const { wereadService } = await import('../wereadService.js')
  const mode = String(args.mode || 'shelf')
  const apiKey = (await import('../configService.js')).configService.get('wereadApiKey')
  if (!apiKey) return '(微信读书未配置: config set wereadApiKey <key>)'
  try {
    if (mode === 'notebooks') {
      const r = await wereadService.notebooks(20)
      if (!r.ok || !r.data?.books?.length) return `(暂无读书笔记: ${r.error || ''})`
      // `/user/notebooks` 把书名与作者**嵌在 `book` 里**，条目顶层没有这两个字段 ——
      // 实测（2026-09-28）：直接读 `b.title` 会得到 `undefined`，而输出照样成立，
      // 只是每本书都没名字。顶层那两个是兜底，网关换版本时用得上。
      const titleOf = (b: any) => b?.book?.title || b?.title || '(未给书名)'
      const authorOf = (b: any) => b?.book?.author || b?.author || ''
      return `有笔记的书 ${r.data.books.length} 本:\n` +
        r.data.books.slice(0, 15).map((b: any) =>
          `· ${titleOf(b)} (${authorOf(b)}) — ${b.noteCount || 0} 条笔记`).join('\n')
    }
    if (mode === 'profile') {
      const r = await wereadService.profile()
      if (!r.ok || !r.data) return `(读不到阅读画像: ${r.error || ''})`
      const p = r.data
      return `阅读画像: ${p.name || '(未给昵称)'}\n`
        + `累计阅读 ${Math.round((p.totalReadTime || 0) / 60)} 分钟、${p.totalReadDays || 0} 天\n`
        + `书架 ${p.totalBooks || 0} 本，读完 ${p.totalFinished || 0} 本`
    }
    if (mode === 'stats') {
      const r = await wereadService.readData('monthly')
      if (!r.ok || !r.data) return `(读不到阅读统计: ${r.error || ''})`
      const d = r.data
      const top = (d.readLongest || []).slice(0, 5).map((x: any) =>
        `· ${x?.book?.title || x?.albumInfo?.title || '(未知)'} ${Math.round((x?.readTime || 0) / 60)} 分钟`)
      return `近期阅读 ${Math.round((d.totalReadTime || 0) / 60)} 分钟、读了 ${d.readDays || 0} 天`
        + `，日均 ${Math.round((d.dayAverageReadTime || 0) / 60)} 分钟`
        + (top.length ? `\n读得最久的:\n${top.join('\n')}` : '')
    }
    if (mode === 'book') {
      const bookId = String(args.book_id || '').trim()
      if (!bookId) return '(book 模式需要 book_id —— 先用 search 模式按书名找到它)'
      const info = await wereadService.bookInfo(bookId)
      if (!info.ok || !info.data) return `(读不到这本书: ${info.error || ''})`
      const b: any = info.data
      const prog = await wereadService.getProgress(bookId)
      const pct = prog.ok && prog.data
        ? `\n我的进度: ${prog.data.progress}%${prog.data.chapterTitle ? `（${prog.data.chapterTitle}）` : ''}`
        : ''
      return `《${b.title}》${b.author || ''}\n评分 ${b.rating ?? '未知'}（${b.ratingCount || 0} 人）`
        + `| ${b.category || '未分类'} | ${b.wordCount || '未知'}字${pct}`
    }
    if (mode === 'review') {
      const bookId = String(args.book_id || '').trim()
      if (!bookId) return '(review 模式需要 book_id —— 先用 search 模式按书名找到它)'
      const r = await wereadService.reviews(bookId, 5)
      if (!r.ok || !r.data?.reviews?.length) return `(这本书还没有热门书评: ${r.error || ''})`
      return `热门书评 ${r.data.reviews.length} 条:\n`
        + r.data.reviews.map((v: any) =>
          `· ${String(v.content || '').replace(/\s+/g, ' ').slice(0, 120)}`
          + `（${v.user?.name || '匿名'}，${v.rating ? `评 ${v.rating} 分` : '未评分'}，${v.likeCount || 0} 赞）`).join('\n')
    }
    if (mode === 'discover') {
      const bookId = String(args.book_id || '').trim()
      const r = bookId ? await wereadService.similar(bookId, 6) : await wereadService.recommend(8)
      if (!r.ok || !r.data?.books?.length) return `(读不到推荐: ${r.error || ''})`
      return (bookId ? '与这本书相似的' : '为你推荐的') + `书 ${r.data.books.length} 本:\n`
        + r.data.books.map((b: any) =>
          `· 《${b.title}》${b.author || ''}${b.rating ? ` 评分 ${b.rating}` : ''}`
          + (b.intro ? `\n  ${String(b.intro).replace(/\s+/g, ' ').slice(0, 80)}` : '')).join('\n')
    }
    if (mode === 'search') {
      const kw = String(args.keyword || '')
      if (!kw) return '(search 模式需要 keyword)'
      const r = await wereadService.search(kw, 8)
      if (!r.ok || !r.data?.books?.length) return `(没搜到「${kw}」: ${r.error || ''})`
      return `搜索「${kw}」结果:\n` +
        r.data.books.map((b: any) => `· ${b.title} (${b.author})`).join('\n')
    }
    const r = await wereadService.shelf()
    if (!r.ok || !r.data?.books?.length) return `(书架为空或读取失败: ${r.error || ''})`
    const books = r.data.books
    const reading = books.filter((b: any) => b.progress && b.progress > 0 && b.progress < 100)
    return `书架共 ${books.length} 本, 在读 ${reading.length} 本:\n` +
      (reading.length ? reading.slice(0, 10).map((b: any) =>
        `· ${b.title} (${b.author}) — 已读 ${b.progress || 0}%`).join('\n') : books.slice(0, 10).map((b: any) => `· ${b.title}`).join('\n'))
  } catch {
    return '(微信读书接口失败，请检查网络和本地配置)'
  }
}
