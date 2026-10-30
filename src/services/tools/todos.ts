/** 待办：查询与改状态。 */
import { join } from 'path'
import { runPythonJson } from '../pythonBridge.js'
import { idTag, fail, producedContent } from './runtime.js'
import type { ToolContext } from './types.js'

export async function handleGetTodos(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const status = String(args.status || 'pending')
  // 走 pythonBridge（唯一的脚本调用入口）：失败原因分三类报出来，不解析人类可读文本。
  // `--meta` 是为了分清"没有待办"与"从没提取过"——两者在 `--json` 下都是空数组，
  // 而把后者说成前者，用户会以为自己真的没事要做。MCP 侧一直分得开（见 mcp_bridge.py），
  // 这条工具此前没分。`--meta` 是新增开关，老形状（裸数组）原样保留给别的调用方。
  const result = await runPythonJson<any>('extract_todos.py', ['list', '--status', status, '--json', '--meta'])
  if (!result.ok) return fail('待办查询失败', result)
  // 兼容老形状：万一是没有 --meta 的实现，拿到的是数组，就退回原来的说法。
  const meta = result.data && !Array.isArray(result.data) ? result.data : null
  const todos: any[] = meta ? (Array.isArray(meta.items) ? meta.items : []) : (Array.isArray(result.data) ? result.data : [])
  if (!todos.length) {
    if (meta && meta.extracted === false) {
      return '(还没提取过待办——待办是从聊天记录里提取的，要用 `weflow-cli todos extract --days 7 --yes` 先跑一次；'
        + '在那之前这份清单一直是空的，不代表你没有事要做)'
    }
    return `(没有${status === 'done' ? '已完成' : '待办'}任务)`
  }
  // 分组：`todos remind` 其实就是同一个文件按紧急度重排，所以不另开一个工具，
  // 加个参数就够（多一个近义工具只会让模型在两者之间瞎挑）
  if (String(args.group_by || '') === 'urgency') {
    const order: Record<string, number> = { 高: 0, 中: 1, 低: 2 }
    const sorted = [...todos].sort((a: any, b: any) =>
      (order[a.urgency] ?? 3) - (order[b.urgency] ?? 3))
    const groups: Record<string, any[]> = {}
    for (const t of sorted) (groups[t.urgency || '未标'] = groups[t.urgency || '未标'] || []).push(t)
    return `${status === 'done' ? '已完成' : '待办'} ${todos.length} 项（按紧急度分组）:\n` +
      Object.entries(groups).map(([u, list]) =>
        `【${u}】${list.length} 项\n` + list.slice(0, 10).map((t: any) =>
          `· ${t.task || t.content || t.text || t.title}${t.deadline && t.deadline !== '未提及' ? ` (截止 ${t.deadline})` : ''}${idTag(t)}`).join('\n')
      ).join('\n')
  }
  return `${status === 'done' ? '已完成' : '待办'} ${todos.length} 项:\n` +
    todos.slice(0, 15).map((t: any) =>
      `· [${t.urgency || '中'}] ${t.task || t.content || t.text || t.title}${t.deadline && t.deadline !== '未提及' ? ` (截止 ${t.deadline})` : ''}${idTag(t)}`).join('\n')
}

export async function handleSetTodoStatus(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const status = String(args.status || '')
  if (status !== 'done' && status !== 'pending') return '(参数错误: status 只能是 done（已完成）或 pending（取消完成）)'
  const id = String(args.id || '').trim()
  const task = String(args.task || '').trim()
  if (!id && !task) return '(参数错误: 要给 id 或 task 指到哪一条待办)'
  let target = id
  if (!target) {
    // 按任务文字找：**只认唯一**。命中 0 条或 ≥2 条都拒绝——
    // 猜错条目比拒绝更糟（用户会以为自己的待办被改了，而改的是另一条）
    const listed = await runPythonJson<any>('extract_todos.py', ['list', '--json'])
    if (!listed.ok) return fail('待办读取失败', listed)
    const items: any[] = Array.isArray(listed.data) ? listed.data : (listed.data?.items || [])
    const norm = (s: unknown) => String(s || '').replace(/\s+/g, '')
    const hit = items.filter(t => norm(t.task).includes(norm(task)))
    if (!hit.length) return `(没有任务文字包含「${task}」的待办)`
    if (hit.length > 1) {
      return `(「${task}」匹配到 ${hit.length} 条待办，不能确定是哪一条，请用 id 指定:\n`
        + hit.slice(0, 5).map(t => `· ${t.task}`).join('\n') + ')'
    }
    if (!hit[0].id) return '(这条待办没有 id——本机的待办文件格式比预期旧，请在电脑上用 `todos done` 处理)'
    target = String(hit[0].id)
  }
  const r = await runPythonJson<any>('extract_todos.py',
    [status === 'done' ? 'done' : 'undone', target, '--json'])
  if (!r.ok) return fail(status === 'done' ? '标记完成失败' : '取消完成失败', r)
  // 括号开头 = "没有产出内容"（本仓的约定，见 producedContent）：这条只报告动作做成了
  return status === 'done' ? `(已标记完成: ${target})` : `(已取消完成标记: ${target})`
}
