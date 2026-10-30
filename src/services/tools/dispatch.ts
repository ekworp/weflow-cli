/**
 * 工具分发：工具名 → 实现。
 *
 * 从 `assistantTools.ts` 里那个 1100 行的 switch 拆出来的（D-139）。行为一字未改：
 * 未知工具仍然回一句 `(未知工具: x)`，`ToolInputError` 仍然折成 `(参数错误: …)`，
 * 其余异常仍然只说一句"执行失败"而不把内部细节漏进上下文。
 *
 * 这张表也是"声明了就必须实现"的机器可读答案：`test/tool-registry.test.ts` 直接比键，
 * 不再扫源码文本。
 */
import type { ToolContext } from './types.js'
import { ToolInputError } from './runtime.js'
import { handleListSessions, handleGetMessages, handleSearchChats, handleListContacts } from './sessions.js'
import { handleLookAtImage } from './media.js'
import { handleSearchFavorites, handleReadFavorite } from './favorites.js'
import { handleGetDailyReport, handleGetReview, handleGetReadingStats, handleGetStats } from './daily.js'
import { handleGetSns, handleGetWeread } from './sns.js'
import { handleGetTodos, handleSetTodoStatus } from './todos.js'
import { handleSearchKnowledge, handleSearchSemantic, handleSearchPublic, handleGetConcepts, handleLintWiki, handleFetchArticle, handleFormatArticle } from './knowledge.js'
import { handleWhoOwesReply, handleDraftReply } from './draft.js'
import { handleSearchMemory, handleSaveMemory } from './memory.js'
import { handleListSkills, handleReadSkill, handleCheckSkills } from './skills.js'
import { handleExportChat, handleListThemes } from './misc.js'

export type ToolHandler = (args: Record<string, any>, ctx: ToolContext) => Promise<string>

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  list_sessions: handleListSessions,
  get_messages: handleGetMessages,
  search_chats: handleSearchChats,
  list_contacts: handleListContacts,
  look_at_image: handleLookAtImage,
  search_favorites: handleSearchFavorites,
  read_favorite: handleReadFavorite,
  get_daily_report: handleGetDailyReport,
  get_review: handleGetReview,
  get_reading_stats: handleGetReadingStats,
  get_stats: handleGetStats,
  get_sns: handleGetSns,
  get_weread: handleGetWeread,
  get_todos: handleGetTodos,
  set_todo_status: handleSetTodoStatus,
  search_knowledge: handleSearchKnowledge,
  search_semantic: handleSearchSemantic,
  search_public: handleSearchPublic,
  get_concepts: handleGetConcepts,
  lint_wiki: handleLintWiki,
  fetch_article: handleFetchArticle,
  format_article: handleFormatArticle,
  who_owes_reply: handleWhoOwesReply,
  draft_reply: handleDraftReply,
  search_memory: handleSearchMemory,
  save_memory: handleSaveMemory,
  list_skills: handleListSkills,
  read_skill: handleReadSkill,
  check_skills: handleCheckSkills,
  export_chat: handleExportChat,
  list_themes: handleListThemes,
}

export async function executeTool(name: string, args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const handler = TOOL_HANDLERS[name]
  if (!handler) return `(未知工具: ${name})`
  try {
    return await handler(args, ctx)
  } catch (error) {
    if (error instanceof ToolInputError) return `(参数错误: ${error.message})`
    return '(工具执行失败，请检查本地配置或运行状态)'
  }
}
