// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import { join } from 'path'
import { disabledIds, readSkillBody, scanSkills, skillRoots, skillState } from '../../services/assistantSkills.js'

export function registerSkill(program: Command): void {

// ==================== skill (本机技能包) ====================
// 技能就是磁盘上的 `SKILL.md`，所以这里**没有安装/卸载**：读、看、体检三件事。
// 体检（`check`）是最有用的一个 —— 它把"读不出来""不合规范""跨目录撞名"这些
// 平时完全静默的问题一次报出来（少一个技能不会报错，只会少一个技能）。
const skillCmd = program
  .command('skill')
  .description('本机技能包（SKILL.md）：列出、查看、体检')

skillCmd
  .command('list')
  .description('列出扫描到的技能')
  .option('--query <q>', '按关键词过滤（匹配 id、名称、说明、触发词）')
  .option('--json', 'JSON 输出')
  .action((opts) => {
    const scan = scanSkills()
    const disabled = disabledIds()
    const q = String(opts.query || '').trim().toLowerCase()
    const rows = scan.skills.filter(s => !q
      || [s.id, s.name, s.description, ...s.triggers].some(x => String(x).toLowerCase().includes(q)))
      .map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        version: s.version,
        state: skillState(s, disabled),
        notes: s.notes,
        // **不给路径**：这是机器输出，路径只有在用户明确要 `show` 时才出现
      }))
    if (opts.json) {
      console.log(JSON.stringify({
        success: true,
        roots: skillRoots(),
        missingRoots: scan.missingRoots,
        total: rows.length,
        skills: rows,
      }))
      return
    }
    if (!rows.length) {
      console.log(chalk.gray(scan.skills.length ? `没有匹配「${opts.query}」的技能` : '没有扫描到技能'))
      console.log(chalk.gray(`技能目录：${skillRoots().join('、')}`))
      for (const dir of scan.missingRoots) console.log(chalk.gray(`  （不存在：${dir}）`))
      return
    }
    for (const r of rows) {
      const tag = r.state === 'disabled' ? chalk.gray('[已禁用] ') : ''
      console.log(`${tag}${chalk.cyan(r.id)}${r.version ? chalk.gray(' v' + r.version) : ''}  ${r.name}`)
      if (r.description) console.log(chalk.gray(`    ${r.description.slice(0, 100)}`))
      for (const n of r.notes) console.log(chalk.yellow(`    ⚠ ${n}`))
    }
    console.log(chalk.gray(`\n共 ${rows.length} 个。正文：weflow-cli skill show <id>`))
  })

skillCmd
  .command('show')
  .argument('<id>', '技能 id')
  .description('打印一个技能的 SKILL.md 正文')
  .option('--json', 'JSON 输出')
  .action((id, opts) => {
    const body = readSkillBody(id)
    if (!body.ok) {
      if (opts.json) {
        console.log(JSON.stringify({ success: false, code: 'SKILL_NOT_READABLE', error: body.text }))
        process.exit(1)
      }
      console.log(chalk.red(body.text))
      return
    }
    if (opts.json) {
      const scan = scanSkills()
      const info = scan.skills.find(s => s.id === id)
      console.log(JSON.stringify({
        success: true,
        id,
        name: info?.name ?? id,
        version: info?.version ?? '',
        truncated: !!body.truncated,
        body: body.text,
      }))
      return
    }
    console.log(body.text)
  })

skillCmd
  .command('check')
  .description('体检：不可读的 SKILL.md、跨目录同名、非规范 id、被禁用的技能')
  .option('--json', 'JSON 输出')
  .action((opts) => {
    const scan = scanSkills()
    const disabled = disabledIds()
    const disabledRows = scan.skills.filter(s => skillState(s, disabled) === 'disabled').map(s => s.id)
    const warned = scan.skills.filter(s => s.notes.length).map(s => ({ id: s.id, notes: s.notes }))
    const payload = {
      success: true,
      roots: skillRoots(),
      missingRoots: scan.missingRoots,
      total: scan.skills.length,
      unreadable: scan.unreadable,
      conflicts: scan.conflicts,
      warned,
      disabled: disabledRows,
    }
    if (opts.json) {
      console.log(JSON.stringify(payload))
      // 不可读 = 真出事了（有文件却读不出来），体检失败；警告与冲突只提示，不算失败
      if (scan.unreadable.length) process.exit(1)
      return
    }
    console.log(`技能目录：${skillRoots().join('、')}`)
    for (const dir of scan.missingRoots) console.log(chalk.gray(`  不存在：${dir}`))
    console.log(`扫描到 ${scan.skills.length} 个技能`)
    if (scan.unreadable.length) {
      console.log(chalk.red(`\n不可读 ${scan.unreadable.length} 个：`))
      for (const u of scan.unreadable) console.log(chalk.red(`  ✗ ${u.file}\n    ${u.reason}`))
    }
    if (scan.conflicts.length) {
      console.log(chalk.yellow(`\n跨目录同名 ${scan.conflicts.length} 个（靠前的目录胜出，不会覆盖）：`))
      for (const c of scan.conflicts) console.log(chalk.yellow(`  ! ${c.id}\n    用：${c.winner}\n    忽略：${c.loser}`))
    }
    if (warned.length) {
      console.log(chalk.yellow(`\n有提醒的 ${warned.length} 个：`))
      for (const w of warned) for (const n of w.notes) console.log(chalk.yellow(`  · ${w.id}：${n}`))
    }
    if (disabledRows.length) console.log(chalk.gray(`\n已禁用：${disabledRows.join('、')}`))
    if (!scan.unreadable.length && !scan.conflicts.length) console.log(chalk.green('\n没有不可读或撞名的技能'))
  })
}
