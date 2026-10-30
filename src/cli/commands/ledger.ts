// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import { createPythonProcessEnv } from '../../utils/pythonProcessEnv.js'
import { runPythonScript, parseCliInteger } from '../context.js'

export function registerLedger(program: Command): void {

// ==================== ledger（资金流水：红包/转账，读 general.db） ====================
// 2026-10-26 NT 普查产物（docs/NT_DATABASES.md）。如实边界写在脚本头：红包表无
// 时间/金额列（在消息正文里，按 messageServerId 溯源是后续工作）；状态枚举语义
// 未逐值验证，原样输出不翻译。本地只读、不联网。
program
  .command('ledger')
  .description('资金流水：红包与转账（读 general.db；本地只读）')
  .option('--talker <contact>', '只看某个会话（id 或备注/昵称子串）')
  .option('--days <n>', '只看最近 N 天（按转账时间；红包无时间列不受此限）')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const args = ['--json']
    if (opts.days !== undefined) {
      const days = parseCliInteger(opts.days, 'days', 1, 36_500, opts.json)
      args.push('--days', String(days))
    }
    const stdout = await runPythonScript('scripts/wechat_ledger.py', args, {
      json: opts.json, code: 'LEDGER_FAILED', prefix: '✗ ',
      timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
      // D-020：会话标识走环境变量，不进 argv
      env: createPythonProcessEnv(opts.talker ? { WEFLOW_TALKER: String(opts.talker) } : {}),
    })
    const payload = JSON.parse(stdout.slice(stdout.indexOf('{')))
    if (opts.json) { console.log(JSON.stringify(payload)); if (!payload.success) process.exit(1); return }
    if (!payload.success) { console.error(chalk.red(`✗ ${payload.error}`)); process.exit(1) }
    console.log(chalk.cyan(`
资金流水：红包 ${payload.redEnvelopes} 笔、转账 ${payload.transfers} 笔`))
    console.log(chalk.gray('  （红包无时间/金额列——在消息正文里，按 messageServerId 看先后；状态枚举原样，语义未验证）'))
    for (const r of payload.rows.slice(0, 40)) {
      const when = r.time ? new Date(r.time * 1000).toLocaleString('zh-CN', { hour12: false }) : '（无时间列）'
      const extra = r.kind === '红包'
        ? `status=${r.hbStatus}/${r.receiveStatus}`
        : `对方=${r.counterpartyDisplay || r.counterparty || '?'}${r.invalidTime ? ` invalid=${r.invalidTime}` : ''}`
      console.log(`  [${when}] ${r.kind} · ${r.sessionDisplay} · ${r.direction} · ${extra}`)
    }
    if (payload.rows.length > 40) console.log(chalk.gray(`  …共 ${payload.rows.length} 行（--json 看全表）`))
    console.log('')
  })
}
