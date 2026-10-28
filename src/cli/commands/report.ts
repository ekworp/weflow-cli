// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { join } from 'path'
import { configService } from '../../services/configService.js'
import { getPythonCommand } from '../../utils/python.js'
import { safeSubprocessError } from '../../utils/pythonProcessEnv.js'
import { resolvePackageRoot, pythonProcessEnv } from '../context.js'

export function registerReport(program: Command): void {

// ==================== report ====================
program
  .command('report')
  .description('生成聊天月报（AI 分析任务和回复）')
  .option('--month <YYYY-MM>', '指定月份')
  .option('--talker <昵称>', '指定联系人（可多次使用）', (value: string, previous: string[]) => [...previous, value], [] as string[])
  .option('--from-whitelist', '使用白名单中的联系人')
  .option('--api-key <key>', 'DeepSeek API key')
  .option('--no-ai', '仅统计，不调用 AI')
  .option('-o, --output <dir>', '输出目录', './output')
  .option('--dry-run', '仅预览，不读取聊天、调用 AI 或写入报告')
  .option('--yes', '确认生成报告')
  .option('--json', '输出机器可读结果，不返回联系人或本地路径')
  .action(async (opts) => {
    if (opts.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(opts.month)) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_DATE', field: 'month' }))
      else console.log(chalk.red('month 必须是有效的 YYYY-MM 月份'))
      process.exit(1)
    }
    const talkers = opts.talker as string[]
    const noAi = opts.ai === false
    const preview = {
      success: true,
      dryRun: true,
      action: 'report.generate',
      monthSpecified: !!opts.month,
      talkerCount: talkers.length,
      fromWhitelist: !!opts.fromWhitelist,
      aiEnabled: !noAi,
    }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify(preview))
      else console.log(chalk.cyan(`月报预览：${talkers.length || (opts.fromWhitelist ? '白名单' : '默认')} 个指定对象，AI ${noAi ? '关闭' : '开启'}`))
      return
    }
    if (!opts.yes) {
      if (opts.json) {
        console.log(JSON.stringify({ ...preview, success: false, dryRun: false, code: 'CONFIRMATION_REQUIRED' }))
        process.exit(1)
      }
      const { confirmed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmed',
        message: `确认生成聊天月报？${noAi ? '仅执行本地统计。' : '所选聊天内容将发送到已配置的 AI 服务。'}`,
        default: false,
      }])
      if (!confirmed) {
        console.log(chalk.gray('已取消'))
        return
      }
    }
    if (!configService.isConfigured()) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'NOT_INITIALIZED' }))
      else console.log(chalk.red('\n❌ 还没配置\n  运行: weflow-cli init\n'))
      process.exit(1)
    }

    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const pkgRoot = resolvePackageRoot()
    const script = join(pkgRoot, 'scripts', 'chat_report.py')

    const args: string[] = [script]
    if (opts.month) args.push('--month', opts.month)
    if (opts.fromWhitelist) args.push('--from-whitelist')
    if (noAi) args.push('--no-ai')
    if (opts.output) args.push('--output', opts.output)

    try {
      if (!opts.json) console.log(chalk.cyan('正在生成月报...\n'))
      const { stdout } = await execFileAsync(getPythonCommand(), args, {
        timeout: 600_000,
        maxBuffer: 50 * 1024 * 1024,
        env: {
          ...pythonProcessEnv(opts.apiKey),
          ...(talkers.length > 0 ? { WEFLOW_REPORT_TALKERS: JSON.stringify(talkers) } : {}),
        },
      })
      if (opts.json) console.log(JSON.stringify({ success: true, action: 'report.generate' }))
      else console.log(stdout)
    } catch (e: any) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'REPORT_FAILED', error: safeSubprocessError(e, '生成失败') }))
      else console.error(chalk.red(`\n✗ ${safeSubprocessError(e, '生成失败')}`))
      process.exit(1)
    }
  })
}
