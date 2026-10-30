/** 技能包的列出、读取与体检。 */
import { join } from 'path'
import { frameLocalData } from '../assistantMemory.js'
import { disabledIds, readSkillBody, scanSkills, skillRoots, skillState } from '../assistantSkills.js'
import type { ToolContext } from './types.js'

export async function handleListSkills(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const scan = scanSkills()
  const q = String(args.query || '').trim().toLowerCase()
  const hit = (s: { id: string; name: string; description: string; triggers: string[] }) =>
    !q || [s.id, s.name, s.description, ...s.triggers].some(x => String(x).toLowerCase().includes(q))
  const rows = scan.skills.filter(hit)
  if (!rows.length) {
    // 一个技能都没有时**说清是"没装"还是"目录配错了"**：后者会把用户引到错的地方找
    if (!scan.skills.length) {
      return `本机没有扫描到技能。技能根目录：${skillRoots().join('、')}`
        + (scan.missingRoots.length ? `（其中这些目录不存在：${scan.missingRoots.join('、')}）` : '')
    }
    return `没有匹配「${args.query}」的技能（本机共有 ${scan.skills.length} 个）`
  }
  const disabled = disabledIds()
  const lines = rows.map(s => {
    const state = skillState(s, disabled)
    const tag = state === 'disabled' ? '[已禁用] ' : ''
    const ver = s.version ? ` v${s.version}` : ''
    return `· ${tag}${s.id}${ver}：${s.name} —— ${s.description || '（无描述）'}`
  })
  lines.push(`（共 ${rows.length} 个，正文用 read_skill 读）`)
  return lines.join('\n')
}

export async function handleReadSkill(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const id = String(args.id || '').trim()
  if (!id) return '(参数错误: 缺少技能 id)'
  const body = readSkillBody(id)
  if (!body.ok) return body.text
  // 技能正文是**磁盘上的内容**，可能含 `</weflow-local-data>` —— 必须包起来再进上下文
  return frameLocalData(`skill.${id}`, body.text)
}

export async function handleCheckSkills(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const scan = scanSkills()
  const disabled = disabledIds()
  const lines: string[] = [`技能目录: ${skillRoots().join('、')}`, `扫描到 ${scan.skills.length} 个技能`]
  for (const dir of scan.missingRoots) lines.push(`· 目录不存在: ${dir}`)
  if (scan.unreadable.length) {
    lines.push(`读不出来的 ${scan.unreadable.length} 个（frontmatter 缺失或不闭合）:`)
    for (const u of scan.unreadable) lines.push(`· ${u.file} —— ${u.reason}`)
  }
  if (scan.conflicts.length) {
    lines.push(`跨目录同名的 ${scan.conflicts.length} 个（靠前的目录胜出）: ${scan.conflicts.map(c => c.id).join('、')}`)
  }
  const warned = scan.skills.filter(s => s.notes.length)
  if (warned.length) {
    lines.push(`有提醒的 ${warned.length} 个:`)
    for (const w of warned) for (const n of w.notes) lines.push(`· ${w.id}: ${n}`)
  }
  const off = scan.skills.filter(s => skillState(s, disabled) === 'disabled').map(s => s.id)
  if (off.length) lines.push(`已禁用: ${off.join('、')}`)
  if (!scan.unreadable.length && !scan.conflicts.length && !warned.length) {
    lines.push('没有读不出来或撞名的技能。')
  }
  return lines.join('\n')
}
