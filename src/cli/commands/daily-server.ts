// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import { join } from 'path'
import { getPythonCommand } from '../../utils/python.js'
import { resolvePackageRoot, pythonProcessEnv, parseCliInteger, requireCliDate, openLocalUrl, startDetachedDailyReader, defaultDailyDate } from '../context.js'

export function registerDailyServer(program: Command): void {

// ==================== daily-server ====================
program
  .command('daily-server')
  .description('启动本地日报阅读器（浏览器浏览 + 收藏 + 笔记）')
  .option('-d, --date <YYYY-MM-DD>', '日期')
  .option('-p, --port <n>', '端口', '8765')
  .option('--open', '自动打开浏览器')
  .option('--status', '仅检查阅读器状态，不启动服务')
  .option('--dry-run', '仅预览，不启动服务或打开浏览器')
  .option('--yes', '确认启动本地阅读器')
  .option('--json', '输出机器可读状态；启动仍需 --yes')
  .action(async (opts) => {
    const { spawn } = await import('child_process')
    const pkgRoot = resolvePackageRoot()
    const favServer = join(pkgRoot, 'scripts', 'fav_server.py')
    const port = parseCliInteger(opts.port, 'port', 1, 65535, opts.json)
    if (opts.date) requireCliDate(opts.date, opts.json)

    if (opts.status) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2000) })
        const status = await response.json() as { ok?: boolean; service?: string; date?: string }
        const data = { success: response.ok && status.ok === true, running: response.ok, port, date: status.date || null }
        if (opts.json) console.log(JSON.stringify(data, null, 2))
        else console.log(data.running ? chalk.green(`阅读器正在运行 (${data.date || '日期未知'})`) : chalk.gray('阅读器未运行'))
      } catch {
        const data = { success: true, running: false, port, date: null }
        if (opts.json) console.log(JSON.stringify(data, null, 2))
        else console.log(chalk.gray('阅读器未运行'))
      }
      return
    }

    const date = opts.date || defaultDailyDate()
    const preview = {
      success: true,
      dryRun: true,
      action: 'daily-reader.start',
      date,
      port,
      loopbackOnly: true,
      opensBrowser: Boolean(opts.open),
    }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify(preview))
      else console.log(chalk.cyan(`阅读器启动预览：${date}，本机端口 ${port}${opts.open ? '，并打开浏览器' : ''}。`))
      return
    }
    if (opts.json && !opts.yes) {
      console.log(JSON.stringify({ ...preview, success: false, dryRun: false, code: 'CONFIRMATION_REQUIRED' }))
      process.exit(1)
    }
    if (opts.json) {
      const result = await startDetachedDailyReader(favServer, date, port)
      if (result.success && opts.open) await openLocalUrl(`http://localhost:${port}`)
      console.log(JSON.stringify({
        ...result,
        action: 'daily-reader.start',
        date,
        port,
        openedBrowser: result.success && Boolean(opts.open),
      }))
      if (!result.success) process.exit(1)
      return
    }
    console.log(chalk.cyan(`⭐ 启动日报阅读器\n`))
    console.log(chalk.gray(`  日期: ${date}`))
    console.log(chalk.gray(`  地址: http://localhost:${port}`))
    console.log()

    if (opts.open) {
      await openLocalUrl(`http://localhost:${port}`)
    }

    const child = spawn(getPythonCommand(), [favServer, '--date', date, '--port', String(port)], {
      windowsHide: true,
      stdio: 'inherit',
      env: pythonProcessEnv(),
    })
    process.on('SIGINT', () => child.kill())
  })
}
