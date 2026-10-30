/** 助手记忆的读写。 */
import { join } from 'path'
import type { ToolContext } from './types.js'

export async function handleSearchMemory(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const hits = ctx.memory.searchFacts(ctx.userId, String(args.keyword || ''))
  if (!hits.length) return '(长期记忆中无相关内容)'
  return hits.map(f => `· ${f.content}`).join('\n')
}

export async function handleSaveMemory(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const content = String(args.content || '').trim().slice(0, 60)
  if (!content) return '(内容为空, 未保存)'
  const added = ctx.memory.addFact(ctx.userId, content)
  return added ? '(已存入长期记忆)' : '(与已有记忆重复, 未保存)'
}
