// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import { join } from 'path'
import { getPythonCommand } from '../../utils/python.js'
import { createPythonProcessEnv, safeSubprocessError } from '../../utils/pythonProcessEnv.js'
import { resolvePackageRoot, pythonProcessEnv, parseCliInteger } from '../context.js'

export function registerPersonal(program: Command): void {

program
  .command('daily-stats')
  .description('统计公众号推送频率与日报处理频率')
  .option('--days <number>', '统计最近多少天', '30')
  .option('--limit <number>', '最多显示多少个公众号', '30')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const script = join(resolvePackageRoot(), 'scripts', 'daily_stats.py')
    const days = parseCliInteger(opts.days, 'days', 1, 3650, opts.json)
    const limit = parseCliInteger(opts.limit, 'limit', 1, 1000, opts.json)

    try {
      const args = [script, '--days', String(days), '--limit', String(limit)]
      if (opts.json) args.push('--json')
      const { stdout } = await execFileAsync(getPythonCommand(), args, {
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
        env: pythonProcessEnv(),
      })
      console.log(stdout)
    } catch (e: any) {
      if (opts.json) {
        console.log(JSON.stringify({
          success: false,
          code: 'DAILY_STATS_FAILED',
          error: '公众号统计不可用，请运行 check --json 检查配置和依赖',
        }))
        process.exit(1)
      }
      console.error(chalk.red(`\n${safeSubprocessError(e, '统计失败')}`))
      process.exit(1)
    }
  })

// ==================== bonds ====================
program
  .command('bonds')
  .description('关系温度：谁在冷却、谁在变热、谁只有微信这一条线（只读本地库，不联网、不调模型）')
  .option('--days <number>', '看最近多少天', '365')
  .option('--limit <number>', '最多扫几个会话', '400')
  .option('--top <number>', '每组列几条', '12')
  .option('--skip <name>', '排除某个名字或 id（可重复）', (value: string, acc: string[]) => {
    acc.push(value)
    return acc
  }, [] as string[])
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const script = join(resolvePackageRoot(), 'scripts', 'bonds.py')
    const days = parseCliInteger(opts.days, 'days', 1, 3650, opts.json)
    const limit = parseCliInteger(opts.limit, 'limit', 1, 5000, opts.json)
    const top = parseCliInteger(opts.top, 'top', 1, 200, opts.json)

    try {
      const args = [script, '--days', String(days), '--limit', String(limit), '--top', String(top)]
      for (const name of (opts.skip as string[]) || []) args.push('--skip', name)
      if (opts.json) args.push('--json')
      const { stdout } = await execFileAsync(getPythonCommand(), args, {
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
        env: pythonProcessEnv(),
      })
      console.log(stdout)
    } catch (e: any) {
      if (opts.json) {
        console.log(JSON.stringify({
          success: false,
          code: 'BONDS_FAILED',
          error: '关系温度不可用，请运行 check --json 检查配置和依赖',
        }))
        process.exit(1)
      }
      console.error(chalk.red(`\n${safeSubprocessError(e, '统计失败')}`))
      process.exit(1)
    }
  })

// ==================== today（那年今日）====================
program
  .command('today')
  .description('那年今日：几年前的今天你在聊什么（只读本地库，不联网）')
  .option('--years <list>', '往前看几年，逗号分隔', '1,3,5')
  .option('--talker <name>', '只看某个会话（wxid 或昵称）')
  .option('--limit <number>', '每天最多列几条', '6')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const script = join(resolvePackageRoot(), 'scripts', 'on_this_day.py')
    const limit = parseCliInteger(opts.limit, 'limit', 1, 200, opts.json)

    try {
      const args = [script, '--years', String(opts.years || '1,3,5'), '--limit', String(limit)]
      if (opts.json) args.push('--json')
      // D-020：会话标识不进子进程 argv（进程列表里看得见），走 WEFLOW_TALKER。
      const { stdout } = await execFileAsync(getPythonCommand(), args, {
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
        env: createPythonProcessEnv(opts.talker ? { WEFLOW_TALKER: String(opts.talker) } : {}),
      })
      console.log(stdout)
    } catch (e: any) {
      if (opts.json) {
        console.log(JSON.stringify({
          success: false,
          code: 'TODAY_FAILED',
          error: '那年今日不可用，请运行 check --json 检查配置和依赖',
        }))
        process.exit(1)
      }
      console.error(chalk.red(`\n${safeSubprocessError(e, '回溯失败')}`))
      process.exit(1)
    }
  })

// ==================== network（人脉图谱）====================
program
  .command('network')
  .description('人脉图谱：共同群、谁能做引荐人（只读 contact.db，不碰聊天内容）')
  .option('--groups', '列群概览（成员数）')
  .option('--with <name>', '我和他共同在哪些群')
  .option('--intro <name>', '谁适合把我介绍给他')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const script = join(resolvePackageRoot(), 'scripts', 'network.py')

    try {
      const args = [script]
      if (opts.groups) args.push('--groups')
      if (opts.with) args.push('--with', String(opts.with))
      if (opts.intro) args.push('--intro', String(opts.intro))
      if (opts.json) args.push('--json')
      if (args.length === 1) {
        console.error(chalk.yellow('\n用法：network --groups | --with <名字> | --intro <名字>'))
        process.exit(1)
      }
      const { stdout } = await execFileAsync(getPythonCommand(), args, {
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
        env: pythonProcessEnv(),
      })
      console.log(stdout)
    } catch (e: any) {
      if (opts.json) {
        console.log(JSON.stringify({
          success: false,
          code: 'NETWORK_FAILED',
          error: '人脉图谱不可用，请运行 check --json 检查配置和依赖',
        }))
        process.exit(1)
      }
      console.error(chalk.red(`\n${safeSubprocessError(e, '查询失败')}`))
      process.exit(1)
    }
  })

// ==================== promises（欠账清单）====================
program
  .command('promises')
  .description('欠账清单：我说过要给谁做什么、后来做了没有（规则判定，带原话与后续证据）')
  .option('--days <number>', '看最近多少天', '60')
  .option('--talker <name>', '只看某个会话')
  .option('--limit <number>', '最多列几条', '30')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const script = join(resolvePackageRoot(), 'scripts', 'promises.py')
    const days = parseCliInteger(opts.days, 'days', 1, 3650, opts.json)
    const limit = parseCliInteger(opts.limit, 'limit', 1, 500, opts.json)

    try {
      const args = [script, '--days', String(days), '--limit', String(limit)]
      if (opts.json) args.push('--json')
      // D-020：同 today——会话标识走 WEFLOW_TALKER，不进 argv。
      const { stdout } = await execFileAsync(getPythonCommand(), args, {
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
        env: createPythonProcessEnv(opts.talker ? { WEFLOW_TALKER: String(opts.talker) } : {}),
      })
      console.log(stdout)
    } catch (e: any) {
      if (opts.json) {
        console.log(JSON.stringify({
          success: false,
          code: 'PROMISES_FAILED',
          error: '欠账清单不可用，请运行 check --json 检查配置和依赖',
        }))
        process.exit(1)
      }
      console.error(chalk.red(`\n${safeSubprocessError(e, '统计失败')}`))
      process.exit(1)
    }
  })

// ==================== leads（线索雷达）====================
program
  .command('leads')
  .description('线索雷达：聊天里的报价/采购/合作/需求信号，带原话与跟进状态（规则判定，不调模型）')
  .option('--days <number>', '看最近多少天', '30')
  .option('--min-score <number>', '最低分，4 分以上更接近真实生意', '2')
  .option('--limit <number>', '最多列几条', '20')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const script = join(resolvePackageRoot(), 'scripts', 'leads.py')
    const days = parseCliInteger(opts.days, 'days', 1, 3650, opts.json)
    const minScore = parseCliInteger(opts.minScore, 'min-score', 1, 50, opts.json)
    const limit = parseCliInteger(opts.limit, 'limit', 1, 500, opts.json)

    try {
      const args = [script, '--days', String(days), '--min-score', String(minScore),
                    '--limit', String(limit)]
      if (opts.json) args.push('--json')
      const { stdout } = await execFileAsync(getPythonCommand(), args, {
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
        env: pythonProcessEnv(),
      })
      console.log(stdout)
    } catch (e: any) {
      if (opts.json) {
        console.log(JSON.stringify({
          success: false,
          code: 'LEADS_FAILED',
          error: '线索雷达不可用，请运行 check --json 检查配置和依赖',
        }))
        process.exit(1)
      }
      console.error(chalk.red(`\n${safeSubprocessError(e, '统计失败')}`))
      process.exit(1)
    }
  })

// ==================== media（媒体精确匹配）====================
program
  .command('media')
  .description('媒体精确匹配：用 hardlink.db 把 md5 直接对到本地文件（图片/文件/视频；本地只读）')
  .option('--md5 <prefix>', '按 md5 前缀查')
  .option('--type <kind>', 'image | file | video | all', 'all')
  .option('--limit <n>', '最多列几条', '20')
  .option('--missing-only', '只列文件已不在本地的（微信会清理）')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const script = join(resolvePackageRoot(), 'scripts', 'media_index.py')
    const limit = parseCliInteger(opts.limit, 'limit', 1, 5000, opts.json)

    try {
      const args = [script, '--type', String(opts.type || 'all'), '--limit', String(limit)]
      if (opts.md5) args.push('--md5', String(opts.md5))
      if (opts.missingOnly) args.push('--missing-only')
      if (opts.json) args.push('--json')
      const { stdout } = await execFileAsync(getPythonCommand(), args, {
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
        env: pythonProcessEnv(),
      })
      console.log(stdout)
    } catch (e: any) {
      if (opts.json) {
        console.log(JSON.stringify({
          success: false,
          code: 'MEDIA_FAILED',
          error: '媒体索引不可用，请运行 check --json 检查配置和依赖',
        }))
        process.exit(1)
      }
      console.error(chalk.red(`\n${safeSubprocessError(e, '查询失败')}`))
      process.exit(1)
    }
  })

// ==================== replay（关系时间重放）====================
program
  .command('replay')
  .description('关系网络时间重放：按月展开，生成可播放的单文件 HTML（本地、离线、不调模型）')
  .option('--out <file>', '输出路径', 'output/replay.html')
  .option('--min-weight <number>', '当月互动量门槛，低于此不计入', '10')
  .option('--json', '只输出聚合结果（验收用）')
  .action(async (opts) => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const script = join(resolvePackageRoot(), 'scripts', 'replay.py')
    const minWeight = parseCliInteger(opts.minWeight, 'min-weight', 1, 10000, opts.json)

    try {
      const args = [script, '--min-weight', String(minWeight), '--out', String(opts.out)]
      if (opts.json) args.push('--json')
      const { stdout } = await execFileAsync(getPythonCommand(), args, {
        timeout: 600_000,
        maxBuffer: 64 * 1024 * 1024,
        env: pythonProcessEnv(),
      })
      console.log(stdout)
    } catch (e: any) {
      if (opts.json) {
        console.log(JSON.stringify({
          success: false,
          code: 'REPLAY_FAILED',
          error: '时间重放不可用，请运行 check --json 检查配置和依赖',
        }))
        process.exit(1)
      }
      console.error(chalk.red(`\n${safeSubprocessError(e, '生成失败')}`))
      process.exit(1)
    }
  })

// ==================== timeline（某号观点演变）====================
program
  .command('timeline')
  .description('观点时间线：某个公众号历次文章与要点，可按时间看它说法的变化')
  .option('--source <name>', '公众号名（子串匹配）')
  .option('--list', '列出存了哪些号、各多少篇')
  .option('--limit <number>', '最多列几篇（最近的在前）', '30')
  .option('--ai', '让模型总结观点变化（需要 API key）')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const script = join(resolvePackageRoot(), 'scripts', 'opinion_timeline.py')
    const limit = parseCliInteger(opts.limit, 'limit', 1, 2000, opts.json)

    try {
      const args = [script, '--limit', String(limit)]
      if (opts.list) args.push('--list')
      if (opts.source) args.push('--source', String(opts.source))
      if (opts.ai) args.push('--ai')
      if (opts.json) args.push('--json')
      if (!opts.list && !opts.source) {
        console.error(chalk.yellow('\n用法：timeline --list | --source <公众号名>'))
        process.exit(1)
      }
      const { stdout } = await execFileAsync(getPythonCommand(), args, {
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
        env: pythonProcessEnv(),
      })
      console.log(stdout)
    } catch (e: any) {
      if (opts.json) {
        console.log(JSON.stringify({
          success: false,
          code: 'TIMELINE_FAILED',
          error: '观点时间线不可用，请先运行 daily 生成日报',
        }))
        process.exit(1)
      }
      console.error(chalk.red(`\n${safeSubprocessError(e, '读取失败')}`))
      process.exit(1)
    }
  })
}
