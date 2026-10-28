// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { join } from 'path'
import { writeFileSync } from 'fs'
import { homedir } from 'os'
import { whitelistService } from '../../services/whitelistService.js'
import { parseCliInteger } from '../context.js'

export function registerAudit(program: Command): void {

// ==================== audit (发送审计日志) ====================
const auditCmd = program
  .command('audit')
  .description('发送审计日志查询 (记录所有 send 尝试)')

auditCmd
  .command('list')
  .description('查看最近发送记录 (默认最近 20 条)')
  .option('-n, --limit <number>', '最大条数', '20')
  .option('--all', '显示全部 (含失败)')
  .option('--failed', '只看失败')
  .option('--target <wxid>', '按目标 wxid 过滤')
  .option('--json', '输出 JSON 格式，不返回审计文件路径')
  .action((opts) => {
    const filter = (e: any) => {
      if (opts.target && e.targetWxid !== opts.target) return false
      if (opts.failed && e.success) return false
      if (!opts.all && !opts.failed && !e.success) {
        // 默认不显示被拦截的 (黑名单/速率/长度), 仅显示实际发送失败
        if (e.error && (e.error.includes('blacklist') || e.error.includes('rate') || e.error.includes('too long'))) return false
      }
      return true
    }
    const limit = parseCliInteger(opts.limit, 'limit', 1, 10000, opts.json)
    const entries = whitelistService.readAudit(limit, filter)
    const logPath = join(homedir(), '.weflow-cli', 'audit-send.log')
    if (opts.json) {
      console.log(JSON.stringify({ success: true, entries }, null, 2))
      return
    }
    if (entries.length === 0) {
      console.log(chalk.gray('无审计记录'))
      console.log(chalk.gray(`日志文件: ${logPath}`))
      return
    }

    console.log(chalk.cyan(`发送审计 (最近 ${entries.length} 条):\n`))
    for (const e of entries) {
      const time = new Date(e.timestamp).toLocaleString('zh-CN')
      const status = e.success ? chalk.green('✓') : chalk.red('✗')
      const name = e.targetName || e.targetWxid
      const err = e.error ? chalk.gray(` [${e.error}]`) : ''
      console.log(`${status} ${chalk.gray(`[${time}]`)} ${chalk.blue(name)} (${e.targetWxid}) <${e.kind}> ${chalk.gray(e.preview || '')}${err}`)
    }
    console.log(chalk.gray(`\n日志文件: ${logPath}`))
  })

auditCmd
  .command('stats')
  .description('审计统计 (成功/失败次数, 热门目标)')
  .option('--json', '输出 JSON 格式')
  .action((opts) => {
    const entries = whitelistService.readAudit()
    if (entries.length === 0) {
      if (opts.json) { console.log(JSON.stringify({ success: true, total: 0, succeeded: 0, failed: 0, topTargets: [] })); return }
      console.log(chalk.gray('无审计记录'))
      return
    }
    const success = entries.filter(e => e.success).length
    const failed = entries.length - success
    const byTarget = new Map<string, number>()
    for (const e of entries) {
      const key = e.targetName || e.targetWxid
      byTarget.set(key, (byTarget.get(key) || 0) + 1)
    }
    const top = [...byTarget.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)

    if (opts.json) {
      console.log(JSON.stringify({
        success: true,
        total: entries.length,
        succeeded: success,
        failed,
        topTargets: top.map(([target, count]) => ({ target, count })),
        sizeBytes: whitelistService.auditSize(),
      }, null, 2))
      return
    }

    console.log(chalk.cyan('发送审计统计:\n'))
    console.log(`  总记录: ${entries.length}`)
    console.log(`  ${chalk.green('成功')}: ${success}  ${chalk.red('失败')}: ${failed}`)
    const sizeKB = (whitelistService.auditSize() / 1024).toFixed(1)
    console.log(chalk.gray(`  日志大小: ${sizeKB} KB\n`))
    console.log(chalk.cyan('热门目标 (Top 10):'))
    for (const [name, n] of top) {
      console.log(`  ${String(n).padStart(4)}  ${name}`)
    }
  })

auditCmd
  .command('clear')
  .description('清空审计日志')
  .option('--dry-run', '仅预览，不清空审计日志')
  .option('--yes', '确认清空审计日志')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    if (opts.dryRun) {
      const preview = { success: true, dryRun: true, action: 'audit.clear', entryCount: whitelistService.readAudit().length }
      if (opts.json) console.log(JSON.stringify(preview))
      else console.log(chalk.cyan(`审计日志清空预览：将移除 ${preview.entryCount} 条记录。`))
      return
    }
    if (!opts.yes) {
      if (opts.json) {
        console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认清空审计日志' }))
        process.exit(1)
      }
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: '确定要清空所有审计记录吗？',
        default: false,
      }])
      if (!confirm) return
    }
    try {
      const { mkdirSync, writeFileSync } = await import('fs')
      const stateDir = join(homedir(), '.weflow-cli')
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(join(stateDir, 'audit-send.log'), '', 'utf8')
      if (opts.json) console.log(JSON.stringify({ success: true, action: 'audit.clear' }))
      else console.log(chalk.green('✓ 审计日志已清空'))
    } catch (e: any) {
      if (opts.json) {
        console.log(JSON.stringify({ success: false, code: 'AUDIT_CLEAR_FAILED', error: '无法清空审计日志' }))
        process.exit(1)
      } else {
        console.log(chalk.red(`✗ 清空失败: ${e.message}`))
      }
    }
  })
}
