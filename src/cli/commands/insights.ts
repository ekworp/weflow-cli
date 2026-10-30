// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { join } from 'path'
import { getPythonCommand } from '../../utils/python.js'
import { DateRangeError, parseLocalDateOrIso } from '../../utils/dateRange.js'
import { resolvePackageRoot, pythonProcessEnv, parseCliInteger, requireCliDate, runConfirmedPythonMutation, runPythonScript, openLocalUrl, startDetachedDailyReader } from '../context.js'

export function registerInsights(program: Command): void {

  // chat-stats
  program
    .command('chat-stats')
    .description('微信个人信息消费报告（支付 + 转账）')
    .option('--period <week|month>', '报告周期', 'week')
    .option('--month <YYYY-MM>', '指定月份（覆盖 --period）')
    .option('-o, --output <path>', '输出路径')
    .option('--dry-run', '仅预览，不读取聊天或写入报告')
    .option('--yes', '确认生成消费报告')
    .option('--json', '输出机器可读结果，不返回统计正文或本地路径')
    .action(async (opts) => {
      if (!['week', 'month'].includes(opts.period)) {
        if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', field: 'period' }))
        else console.log(chalk.red('period 必须是 week 或 month'))
        process.exit(1)
      }
      if (opts.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(opts.month)) {
        if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_DATE', field: 'month' }))
        else console.log(chalk.red('month 必须是有效的 YYYY-MM 月份'))
        process.exit(1)
      }
      const pkgRoot = resolvePackageRoot()
      const script = join(pkgRoot, 'scripts', 'chat_stats.py')
      const args: string[] = ['--period', opts.period]
      if (opts.month) { args.push('--month', opts.month) }
      if (opts.output) { args.push('--output', opts.output) }
      await runConfirmedPythonMutation({
        action: 'chat-stats.generate',
        script,
        args,
        cliOptions: opts,
        preview: { period: opts.month ? 'specified-month' : opts.period, readsLocalChat: true, includesPaymentStats: true },
        confirmationMessage: '确认读取本地聊天、支付与转账数据并生成消费报告？',
        timeout: 600_000,
      })
    })

  // generate-review
  program
    .command('review')
    .description('生成 AI 学习日报')
    .option('--date <YYYY-MM-DD>', '日期')
    .option('--api-key <key>', 'DeepSeek API key')
    .option('--engine <name>', 'AI 引擎: deepseek / claude / ollama', 'deepseek')
    .option('--source <dir>', '文章目录', './output/biz-daily')
    .option('--output <dir>', '输出目录', './output/reviews')
    .option('--dry-run', '仅预览，不读取文章、调用 AI 或写入日报')
    .option('--yes', '确认生成学习日报')
    .option('--json', '输出机器可读结果，不返回本地路径')
    .action(async (opts) => {
      if (!['deepseek', 'claude', 'ollama'].includes(opts.engine)) {
        if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', field: 'engine' }))
        else console.log(chalk.red('engine 必须是 deepseek、claude 或 ollama'))
        process.exit(1)
      }
      if (opts.date) {
        try {
          parseLocalDateOrIso(opts.date)
          if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new DateRangeError('INVALID_DATE', '日期无效')
        } catch {
          if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_DATE', field: 'date' }))
          else console.log(chalk.red('date 必须是有效的 YYYY-MM-DD 日期'))
          process.exit(1)
        }
      }
      const preview = {
        success: true,
        dryRun: true,
        action: 'review.generate',
        dateSpecified: !!opts.date,
        engine: opts.engine,
        readsLocalArticles: true,
        usesAi: true,
      }
      if (opts.dryRun) {
        if (opts.json) console.log(JSON.stringify(preview))
        else console.log(chalk.cyan(`学习日报预览：使用 ${opts.engine} 分析本地文章并写入报告`))
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
          message: '确认生成 AI 学习日报？文章摘要将发送到已配置的 AI 服务。',
          default: false,
        }])
        if (!confirmed) {
          console.log(chalk.gray('已取消'))
          return
        }
      }
      const args: string[] = ['--engine', opts.engine, '--source', opts.source, '--output', opts.output]
      if (opts.date) args.push('--date', opts.date)
      const stdout = await runPythonScript('scripts/generate_review.py', args, {
        json: opts.json,
        code: 'REVIEW_FAILED',
        timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
        apiKey: opts.apiKey,
      })
      if (opts.json) console.log(JSON.stringify({ success: true, action: 'review.generate' }))
      else console.log(stdout)
    })

  // fav-server
  program
    .command('fav-server')
    .description('启动收藏服务器 — daily-server 的兼容入口')
    .option('--date <YYYY-MM-DD>', '日期（默认今天）')
    .option('--port <number>', '端口', '8765')
    .option('--open', '自动打开浏览器')
    .option('--dry-run', '仅预览，不启动服务或打开浏览器')
    .option('--yes', '确认启动本地服务')
    .option('--json', '输出机器可读状态；启动仍需 --yes')
    .action(async (opts) => {
      const { spawn } = await import('child_process')
    const pkgRoot = resolvePackageRoot()
      const script = join(pkgRoot, 'scripts', 'fav_server.py')

      if (!opts.date) {
        const now = new Date()
        const yyyy = now.getFullYear()
        const mm = String(now.getMonth() + 1).padStart(2, '0')
        const dd = String(now.getDate()).padStart(2, '0')
        opts.date = `${yyyy}-${mm}-${dd}`
      }
      requireCliDate(opts.date, opts.json)

      const port = parseCliInteger(opts.port, 'port', 1, 65535, opts.json)
      const args = [script, '--date', opts.date, '--port', String(port)]
      const preview = {
        success: true,
        dryRun: true,
        action: 'daily-reader.start',
        compatibilityAlias: 'fav-server',
        date: opts.date,
        port,
        loopbackOnly: true,
        opensBrowser: Boolean(opts.open),
      }
      if (opts.dryRun) {
        if (opts.json) console.log(JSON.stringify(preview))
        else console.log(chalk.cyan(`收藏服务启动预览：${opts.date}，本机端口 ${port}${opts.open ? '，并打开浏览器' : ''}。`))
        return
      }
      if (opts.json && !opts.yes) {
        console.log(JSON.stringify({ ...preview, success: false, dryRun: false, code: 'CONFIRMATION_REQUIRED' }))
        process.exit(1)
      }
      if (opts.json) {
        const result = await startDetachedDailyReader(script, opts.date, port)
        if (result.success && opts.open) await openLocalUrl(`http://localhost:${port}`)
        console.log(JSON.stringify({
          ...result,
          action: 'daily-reader.start',
          date: opts.date,
          port,
          openedBrowser: result.success && Boolean(opts.open),
        }))
        if (!result.success) process.exit(1)
        return
      }
      console.log(chalk.cyan(`⭐ 启动收藏服务器 (${opts.date})\n`))
      console.log(chalk.gray(`  按住 Ctrl 并点击: http://localhost:${port}`))

      if (opts.open) {
        await openLocalUrl(`http://localhost:${port}`)
      }

      const child = spawn(getPythonCommand(), args, {
        windowsHide: true,
        stdio: 'inherit',
        env: pythonProcessEnv(),
      })
      await new Promise<void>((resolve) => child.on('exit', (code) => {
        if (code !== 0 && code !== null) process.exit(code)
        resolve()
      }))
    })
}
