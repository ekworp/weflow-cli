// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import { join } from 'path'
import { existsSync, statSync } from 'fs'
import { configService } from '../../services/configService.js'
import { getPythonCommand } from '../../utils/python.js'
import { resolvePackageRoot, pythonProcessEnv, parseCliInteger, requireCliDate, runConfirmedPythonMutation, defaultDailyDate } from '../context.js'

export function registerDaily(program: Command): void {

// ==================== daily ====================
program
  .command('daily')
  .option('--source <name>', '仅处理指定公众号，可重复或用逗号分隔', (value, previous: string[] = []) => [...previous, value], [])
  .description('一键生成公众号日报（抓取 + AI 摘要 + HTML 阅读器 + 行动建议）')
  .option('-d, --date <YYYY-MM-DD>', '日期')
  .option('--yesterday', '跑昨天（等价于 --date 昨天）。公众号发到 24:00 才停，所以当晚跑的那一天永远不全；"跑昨天"与时刻无关，计划任务用这个')
  .option('--api-key <key>', 'DeepSeek API key（或设环境变量 DEEPSEEK_API_KEY）')
  .option('--skip-classify', '跳过后处理')
  .option('--dry-run', '仅预览文章，不调用 AI 或写入日报')
  .option('--yes', '确认执行日报生成；JSON 模式需要此选项')
  .option('--no-ai', '关闭本次日报的所有 AI 处理')
  .option('--no-summary', '只判断不生成：不调 LLM 写摘要/标签/简报（主题与相关度仍由 Jev 判断），无需 DeepSeek key')
  .option('--prefetch-bodies [n]', '抓取之前先并发把当天正文抓进缓存（n=并发数，默认 8）：抓取阶段于是全部命中缓存、不再逐篇 sleep 8-12 秒（450 篇约 75 分钟 → 秒级）。对上游的请求次数不变，只是压进更短的时间窗')
  .option('--json', '输出机器可读的最终结果；运行日志写入 stderr')
  .option('--email', '生成后把日报按主题（AI / 文学 / 学术）发到邮箱（每个主题附一段 AI 综述，逐篇给要点）')
  .option('--mail-to <address>', '邮件收件人；缺省用配置 dailyMailTo，再缺省发给自己')
  .action(async (opts) => {
    const { spawn } = await import('child_process')
    const { existsSync, statSync } = await import('fs')
    const pkgRoot = resolvePackageRoot()
    const pipeline = join(pkgRoot, 'scripts', 'pipeline.py')
    const bizDaily = join(pkgRoot, 'scripts', 'biz_daily.py')
    const dailyMail = join(pkgRoot, 'scripts', 'daily_mail.py')

    const now = new Date()
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const isoDate = (when: Date) => `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`
    if (opts.date && opts.yesterday) {
      const error = '--date 与 --yesterday 不能同时给（前者是明确的一天，后者是"昨天"）'
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', field: 'date', error }))
      else console.log(chalk.red(error))
      process.exit(1)
    }
    const date = opts.date || (opts.yesterday
      ? isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
      : localDate)
    const apiKey = opts.apiKey || process.env.DEEPSEEK_API_KEY || ''
    const noAi = opts.ai === false || configService.get('dailyAiEnabled') === 'false'
    const dailyLog = (...values: any[]) => opts.json ? console.error(...values) : console.log(...values)

    const artifactStatus = (targetDate: string) => {
      const outputDir = join(pkgRoot, 'output', 'biz-daily', targetDate)
      const hasFile = (file: string) => {
        const path = join(outputDir, file)
        try { return existsSync(path) && statSync(path).size > 0 } catch { return false }
      }
      return {
        readme: hasFile('README.md'),
        articleIndex: hasFile('.articles.json'),
        reader: hasFile('index.html'),
      }
    }
    const isComplete = (targetDate: string): boolean => Object.values(artifactStatus(targetDate)).every(Boolean)

    const runPipeline = (targetDate: string): Promise<number> => new Promise((resolve) => {
      const args = [pipeline, '--date', targetDate, '--engine', noAi ? 'local' : 'deepseek', '--interest', 'AI']
      if (noAi) args.push('--no-ai')
      // 与 --no-ai 不同：这一条保留判断（Jev），只关掉 LLM 的文字生成。
      if (opts.noSummary && !noAi) args.push('--no-summary')
      for (const source of opts.source || []) args.push('--source', source)
      if (opts.skipClassify) args.push('--skip-classify')
      // 只在**给了**这个旗标时才解析数字：`--prefetch-bodies`（不带数字）是合法的，
      // 而默认并发数只在 python 侧写一份（这里再写一份迟早漂移）。
      if (opts.prefetchBodies !== undefined) {
        args.push('--prefetch-bodies')
        if (opts.prefetchBodies !== true) {
          args.push(String(parseCliInteger(opts.prefetchBodies, 'prefetch-bodies', 1, 64, !!opts.json)))
        }
      }

      dailyLog(chalk.cyan(`\n📰 正在生成 ${targetDate} 公众号日报${noAi ? '（AI 已关闭）' : ''}...\n`))
      const child = spawn(getPythonCommand(), args, {
        windowsHide: true,
        stdio: opts.json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        env: pythonProcessEnv(apiKey),
      })
      if (opts.json) {
        child.stdout?.pipe(process.stderr)
        child.stderr?.pipe(process.stderr)
      }
      child.on('error', () => resolve(1))
      child.on('exit', (code) => resolve(code || 0))
    })

    if (opts.dryRun) {
      const dryRunArgs = [bizDaily, '--date', date, '--engine', 'local', '--dry-run']
      for (const source of opts.source || []) dryRunArgs.push('--source', source)
      const child = spawn(getPythonCommand(), dryRunArgs, {
        windowsHide: true,
        stdio: opts.json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        env: pythonProcessEnv(),
      })
      if (opts.json) {
        child.stdout?.pipe(process.stderr)
        child.stderr?.pipe(process.stderr)
      }
      child.on('exit', (code) => {
        if (opts.json) console.log(JSON.stringify({ success: code === 0, dryRun: true, date, aiEnabled: false }))
        process.exit(code || 0)
      })
      return
    }

    if (opts.json && !opts.yes) {
      console.log(JSON.stringify({
        success: false,
        code: 'CONFIRMATION_REQUIRED',
        action: 'daily.generate',
        date,
        aiEnabled: !noAi,
      }))
      process.exit(1)
    }

    if (!apiKey && !noAi) {
      if (opts.json) {
        console.log(JSON.stringify({ success: false, code: 'AI_KEY_REQUIRED', error: 'AI 已启用但未配置 API key' }))
        process.exit(1)
      }
      console.log(chalk.red('\n❌ 缺少 DeepSeek API key'))
      console.log(chalk.gray('  用法: weflow-cli daily --api-key <key>'))
      console.log(chalk.gray('  或设环境变量: set DEEPSEEK_API_KEY=<key>\n'))
      process.exit(1)
    }

    if (!opts.date) {
      const previous = new Date(now)
      previous.setDate(previous.getDate() - 1)
      const previousDate = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}-${String(previous.getDate()).padStart(2, '0')}`
      if (!opts.dryRun && !isComplete(previousDate)) {
        dailyLog(chalk.yellow(`\n⚠️ 昨日报不完整，先补生成 ${previousDate}...`))
        const previousCode = await runPipeline(previousDate)
        if (previousCode !== 0 || !isComplete(previousDate)) {
          if (opts.json) {
            console.log(JSON.stringify({ success: false, code: 'PREVIOUS_DAILY_INCOMPLETE', date, previousDate }))
            process.exit(previousCode || 1)
          }
          console.log(chalk.red(`\n✗ 昨日报补生成失败或仍不完整，已停止当天日报生成。`))
          process.exit(previousCode || 1)
        }
        dailyLog(chalk.green(`\n✓ 昨日报已补齐: output/biz-daily/${previousDate}/`))
      }
    }

    const code = await runPipeline(date)
    if (code === 0) {
      const complete = isComplete(date)
      // 邮件只依赖 `.articles.json`（逐篇摘要已经由 biz_daily 写好），所以放在生成之后、
      // 与"是否完整"无关：不完整时也先把已有的发出去，用户不至于什么都收不到。
      let mail: { ok: boolean; code: number } | null = null
      if (opts.email) {
        const mailArgs = [dailyMail, '--date', date]
        if (opts.mailTo) mailArgs.push('--to', String(opts.mailTo))
        dailyLog(chalk.cyan('\n📧 正在按主题整理并发邮件...'))
        mail = await new Promise((resolve) => {
          const child = spawn(getPythonCommand(), mailArgs, {
            windowsHide: true,
            stdio: 'inherit',
            env: pythonProcessEnv(apiKey),
          })
          child.on('error', () => resolve({ ok: false, code: 1 }))
          child.on('exit', (c) => resolve({ ok: (c || 0) === 0, code: c || 0 }))
        })
        if (mail && !mail.ok) dailyLog(chalk.yellow('  ! 邮件没发出去（日报本身已生成，见上面的报错）'))
      }
      if (opts.json) {
        console.log(JSON.stringify({
          success: complete,
          code: complete ? null : 'DAILY_OUTPUT_INCOMPLETE',
          date,
          aiEnabled: !noAi,
          output: `output/biz-daily/${date}`,
          artifacts: artifactStatus(date),
          mail,
        }, null, 2))
        if (!complete) process.exit(1)
        return
      }
      console.log(chalk.green(`\n✓ 日报已生成: output/biz-daily/${date}/`))
      if (mail) console.log(chalk.green(`✓ 邮件已发送${opts.mailTo ? ` → ${opts.mailTo}` : ''}`))
      console.log(chalk.gray(`  HTML 阅读器: weflow-cli daily-server --date ${date}`))
    } else {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'DAILY_PIPELINE_FAILED', date, aiEnabled: !noAi }))
      process.exit(code || 1)
    }
  })

const dailyFavoritesCmd = new Command('favorites')
  .description('同步或调整日报阅读器中的本地收藏')

const runDailyFavorites = async (
  date: string,
  root: string,
  changes: string[],
  action: string,
  opts: { dryRun?: boolean; yes?: boolean; json?: boolean },
) => {
  requireCliDate(date, opts.json)
  const script = join(resolvePackageRoot(), 'scripts', 'sync_fav.py')
  const itemCount = changes.length > 0 ? Math.max(0, changes.length - 1) : 0
  await runConfirmedPythonMutation({
    action,
    script,
    args: ['--date', date, '--root', root, ...changes],
    cliOptions: opts,
    preview: { dateSpecified: true, itemCount, modifiesFavoriteState: true },
    confirmationMessage: `确认更新当日日报收藏${itemCount ? `（${itemCount} 项）` : ''}？`,
  })
}

const dailyFavoriteOptions = (command: Command, opts: Record<string, any>): Record<string, any> => {
  const dailyOpts = command.parent?.parent?.opts() || {}
  return {
    ...opts,
    date: opts.date || dailyOpts.date,
    dryRun: !!(opts.dryRun || dailyOpts.dryRun),
    json: !!(opts.json || dailyOpts.json),
  }
}

dailyFavoritesCmd
  .command('sync')
  .description('按阅读器保存的收藏状态同步本地收藏目录')
  .option('-d, --date <YYYY-MM-DD>', '日报日期')
  .option('--root <dir>', '日报输出根目录', './output/biz-daily')
  .option('--dry-run', '仅预览，不读取状态或修改收藏目录')
  .option('--yes', '确认同步收藏目录')
  .option('--json', '输出机器可读结果，不返回文章或本地路径')
  .action(async (opts, command) => {
    const merged = dailyFavoriteOptions(command, opts)
    await runDailyFavorites(merged.date || defaultDailyDate(), merged.root, [], 'daily.favorites.sync', merged)
  })

dailyFavoritesCmd
  .command('add <article>')
  .description('添加日报文章到本地收藏')
  .option('--article <path>', '额外添加一篇文章，可重复使用', (value: string, previous: string[]) => [...previous, value], [] as string[])
  .option('-d, --date <YYYY-MM-DD>', '日报日期')
  .option('--root <dir>', '日报输出根目录', './output/biz-daily')
  .option('--dry-run', '仅预览，不修改收藏')
  .option('--yes', '确认添加收藏')
  .option('--json', '输出机器可读结果，不返回文章或本地路径')
  .action(async (article, opts, command) => {
    const merged = dailyFavoriteOptions(command, opts)
    const articles = [article, ...(merged.article as string[])]
    await runDailyFavorites(merged.date || defaultDailyDate(), merged.root, ['--add', ...articles], 'daily.favorites.add', merged)
  })

dailyFavoritesCmd
  .command('remove <article>')
  .description('从本地收藏中移除日报文章')
  .option('--article <path>', '额外移除一篇文章，可重复使用', (value: string, previous: string[]) => [...previous, value], [] as string[])
  .option('-d, --date <YYYY-MM-DD>', '日报日期')
  .option('--root <dir>', '日报输出根目录', './output/biz-daily')
  .option('--dry-run', '仅预览，不修改收藏')
  .option('--yes', '确认移除收藏')
  .option('--json', '输出机器可读结果，不返回文章或本地路径')
  .action(async (article, opts, command) => {
    const merged = dailyFavoriteOptions(command, opts)
    const articles = [article, ...(merged.article as string[])]
    await runDailyFavorites(merged.date || defaultDailyDate(), merged.root, ['--remove', ...articles], 'daily.favorites.remove', merged)
  })

program.commands.find(c => c.name() === 'daily')?.addCommand(dailyFavoritesCmd)
}
