/** 收藏：搜索与读取。 */
import { join } from 'path'
import { chatService } from '../chatService.js'
import { isSafeUrl, fetchArticleHtml, articleTextFromHtml } from './html.js'
import { ensureDb, boundedToolInteger } from './runtime.js'
import type { ToolContext } from './types.js'

export async function handleSearchFavorites(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  await ensureDb()
  // 不给关键词就是"最近收藏了什么"——这一问在聊天里很自然，没理由逼调用方编一个词
  const keyword = String(args.keyword || '')
  const limit = boundedToolInteger(args.limit, keyword ? 8 : 15, keyword ? 15 : 30)
  const r = keyword ? await chatService.getFavorites({ keyword, limit })
    : await chatService.getFavorites({ limit })
  if (!r.success || !r.favorites?.length) {
    if (r.error) return `(查询失败: ${r.error})`
    return keyword ? `(收藏中未搜到「${keyword}」)` : '(收藏是空的，或收藏库还没连上)'
  }
  return `共${r.total}条, 前${r.favorites.length}条:\n` +
    r.favorites.map(f => {
      const desc = (f.desc || '').replace(/\s+/g, ' ').slice(0, 60)
      return `· ${f.title || '(无标题)'} (${f.source_name || '未知来源'})${desc ? ` — ${desc}` : ''}`
    }).join('\n')
}

export async function handleReadFavorite(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  await ensureDb()
  const keyword = String(args.keyword || '')
  if (!keyword) return '(缺少 keyword 参数)'
  const maxChars = boundedToolInteger(args.max_chars, 3000, 6000, 'max_chars')
  const r = await chatService.getFavorites({ keyword, limit: 5 })
  if (!r.success || !r.favorites?.length) {
    return `(收藏中未找到「${keyword}」)`
  }
  const art = r.favorites.find(f => f.link) || r.favorites[0]
  if (!art.link) {
    const txt = (art.desc || art.content || '').trim()
    return txt ? `「${art.title || '无标题'}」内容:\n${txt.slice(0, maxChars)}` : `(「${art.title}」没有可读的链接和内容)`
  }
  if (!isSafeUrl(art.link)) return `(链接不安全, 拒绝抓取: ${art.link.slice(0, 60)})`
  // 微信内置浏览器 UA + Referer 绕 WAF（与 biz_daily.py 同策略）；
  // 这段与 fetch_article 是同一份实现——两处各写一份必然会漂
  const { status, html } = await fetchArticleHtml(art.link)
  if (!html) return `(抓取失败 HTTP ${status})`
  let text = articleTextFromHtml(html, maxChars)
  if (html.includes('已被发布者删除')) return `(「${art.title}」已被发布者删除)`
  if (!text.trim() || (text.match(/[\u4e00-\u9fff]/g) || []).length < 20) {
    return `(「${art.title}」正文提取失败, 可能是纯图片文章或已被删除)`
  }
  return `「${art.title || '无标题'}」(${art.source_name || '未知来源'}) 正文:\n${text}`
}
