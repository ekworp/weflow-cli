// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { runPythonScript, parseCliInteger, requireCliChoice } from '../context.js'

export function registerNotes(program: Command): void {

  // chat-notes：把会话整理成知识卡，喂给 wiki compile 聚成概念页
  program
    .command('chat-notes')
    .description('把最近一段时间的会话整理成知识卡（之后用 wiki compile 聚成概念页）—— **只写本地文件，不发送**')
    .option('--days <n>', '看最近多少天', '30')
    .option('--limit <n>', '最多处理几个会话', '40')
    .option('--source <source>', '聊天来源：wechat（默认）/ qq（只读 import qchat 导入的会话，不碰微信库）/ all（都要）', 'wechat')
    .option('--dry-run', '仅预览：几个会话、多少字符会发给生成模型（只读本地，零出境）')
    .option('--yes', '确认把对话发送给生成模型')
    .option('--transcribe-voice',
            '把缺转写的语音**本机**识别掉再产卡（本地 whisper，慢、吃 CPU、不出网；配合 --dry-run 就是只补转写、不调模型）')
    .option('--json', '输出机器可读结果；执行仍需 --yes')
    .action(async (opts) => {
      const days = parseCliInteger(opts.days, 'days', 1, 3650, opts.json)
      const limit = parseCliInteger(opts.limit, 'limit', 1, 200, opts.json)
      requireCliChoice(opts.source, ['wechat', 'qq', 'all'], 'source', opts.json)
      // 与 `draft` 同一条纪律：**"确认过了"只用一个变量**，参数在确认之后才拼
      let confirmed = !!opts.yes
      if (!opts.dryRun && !confirmed) {
        const preview = {
          success: false, dryRun: false, action: 'chat-notes',
          code: 'CONFIRMATION_REQUIRED', days, limit, source: opts.source,
          readsLocalChat: true, invokesAI: true, writesLocalFiles: true, sendsNothing: true,
        }
        if (opts.json) {
          console.log(JSON.stringify(preview))
          process.exit(1)
        }
        const answer = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: '确认把最近这些会话的对话发送给生成模型吗？（只会产出本地知识卡，不会替你发送任何消息）',
          default: false,
        }])
        confirmed = !!answer.confirmed
        if (!confirmed) {
          console.log(chalk.gray('已取消'))
          return
        }
      }
      const args = ['--days', String(days), '--limit', String(limit),
                    '--source', String(opts.source),
                    ...(confirmed ? ['--yes'] : []),
                    ...(opts.transcribeVoice ? ['--transcribe-voice'] : []),
                    ...(opts.json ? ['--json'] : []),
                    ...(opts.dryRun ? ['--dry-run'] : [])]
      const stdout = await runPythonScript('scripts/chat_notes.py', args, {
        json: opts.json,
        code: 'CHAT_NOTES_FAILED',
        action: 'chat-notes',
        timeout: 900_000, maxBuffer: 50 * 1024 * 1024,
      })
      process.stdout.write(stdout)
    })

  // user-notes：读你自己写的笔记（第四条来源，也是唯一读"人写的东西"的一条）
  program
    .command('user-notes')
    .description('读你自己写的笔记，长成知识卡（之后用 wiki compile 聚成概念页）—— **你的笔记只读，绝不修改**')
    .option('--limit <n>', '最多处理几篇笔记', '20')
    .option('--vault <dir>', '库目录', './output/wechat-vault')
    .option('--refresh', '已有卡的也重做')
    .option('--dry-run', '仅预览：几篇笔记会发给模型（只读本地，零出境）')
    .option('--yes', '确认把笔记发给生成模型')
    .option('--json', '输出机器可读结果；执行仍需 --yes')
    .action(async (opts) => {
      const limit = parseCliInteger(opts.limit, 'limit', 1, 500, opts.json)
      let confirmed = !!opts.yes
      if (!opts.dryRun && !confirmed) {
        const preview = {
          success: false, dryRun: false, action: 'user-notes',
          code: 'CONFIRMATION_REQUIRED', limit,
          readsLocalData: true, invokesAI: true, writesLocalFiles: true,
          modifiesYourNotes: false, sendsNothing: true,
        }
        if (opts.json) {
          console.log(JSON.stringify(preview))
          process.exit(1)
        }
        const answer = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: '确认把你自己写的这些笔记发给生成模型吗？（你的笔记只读，产出的卡另存；只写本地文件）',
          default: false,
        }])
        confirmed = !!answer.confirmed
        if (!confirmed) {
          console.log(chalk.gray('已取消'))
          return
        }
      }
      const args = ['--limit', String(limit), '--vault', String(opts.vault),
                    ...(opts.refresh ? ['--refresh'] : []),
                    ...(confirmed ? ['--yes'] : []),
                    ...(opts.json ? ['--json'] : []),
                    ...(opts.dryRun ? ['--dry-run'] : [])]
      const stdout = await runPythonScript('scripts/user_notes.py', args, {
        json: opts.json,
        code: 'USER_NOTES_FAILED',
        action: 'user-notes',
        jsonExtra: (error) => ({ detail: String((error as any)?.stdout || '').slice(0, 2000) }),
        timeout: 1_800_000, maxBuffer: 50 * 1024 * 1024,
      })
      process.stdout.write(stdout)
    })

  // fav-notes：把微信收藏里的文章变成知识卡（第三条来源）
  program
    .command('fav-notes')
    .description('把微信收藏里的文章整理成知识卡（之后用 wiki compile 聚成概念页）—— **只写本地文件，不发送**')
    .option('--limit <n>', '最多处理几条收藏（按收藏时间倒序）', '10')
    .option('--refresh', '已有卡的也重做（默认增量：只做还没卡的）')
    .option('--dry-run', '仅预览：几条、多少要联网抓（只读本地，零出境）')
    .option('--yes', '确认把收藏的正文发给生成模型')
    .option('--json', '输出机器可读结果；执行仍需 --yes')
    .action(async (opts) => {
      const limit = parseCliInteger(opts.limit, 'limit', 1, 500, opts.json)
      // 与另外两条线同一条纪律：**「确认过了」只用一个变量**，参数在确认之后才拼
      let confirmed = !!opts.yes
      if (!opts.dryRun && !confirmed) {
        const preview = {
          success: false, dryRun: false, action: 'fav-notes',
          code: 'CONFIRMATION_REQUIRED', limit,
          readsLocalData: true, fetchesArticleUrls: true, invokesAI: true,
          writesLocalFiles: true, sendsNothing: true,
        }
        if (opts.json) {
          console.log(JSON.stringify(preview))
          process.exit(1)
        }
        const answer = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: '确认把这些收藏的正文发给生成模型吗？（只写本地知识卡；正文取不到时会去抓文章链接）',
          default: false,
        }])
        confirmed = !!answer.confirmed
        if (!confirmed) {
          console.log(chalk.gray('已取消'))
          return
        }
      }
      const args = ['--limit', String(limit),
                    ...(opts.refresh ? ['--refresh'] : []),
                    ...(confirmed ? ['--yes'] : []),
                    ...(opts.json ? ['--json'] : []),
                    ...(opts.dryRun ? ['--dry-run'] : [])]
      const stdout = await runPythonScript('scripts/fav_notes.py', args, {
        json: opts.json,
        code: 'FAV_NOTES_FAILED',
        action: 'fav-notes',
        jsonExtra: (error) => ({ detail: String((error as any)?.stdout || '').slice(0, 2000) }),
        timeout: 1_800_000, maxBuffer: 50 * 1024 * 1024,
      })
      process.stdout.write(stdout)
    })

  // article-notes：从文章笔记里提炼概念，喂给 wiki compile
  program
    .command('article-notes')
    .description('从 Vault 的文章笔记里提炼概念（之后用 wiki compile 聚成概念页）—— **只写本地文件，不发送**')
    .option('--source <dir>', '文章笔记目录', './output/wechat-vault/002_Literature')
    .option('--limit <n>', '最多处理几篇（按发布时间倒序）', '30')
    .option('--since <date>', '只看这个日期之后的（YYYY-MM-DD）—— 比 --limit 精确，例："9 月的都跑一遍"')
    .option('--until <date>', '只看这个日期之前的（YYYY-MM-DD）')
    .option('--topic <name>', '只做这些主题，可重复或用逗号分隔（如 --topic AI）；不传=全部',
            (value, previous: string[] = []) => [...previous, value], [])
    .option('--workers <n>', '并发问几篇（只并行"问"，写仍是串行）', '6')
    .option('--dry-run', '仅预览：几篇、多少字会发给生成模型（只读本地，零出境）')
    .option('--refresh-summaries', '只按原笔记重算已有卡片的摘要（本地，不调用模型、不必 --yes）')
    .option('--yes', '确认把文章发给生成模型')
    .option('--json', '输出机器可读结果；执行仍需 --yes')
    .action(async (opts) => {
      const limit = parseCliInteger(opts.limit, 'limit', 1, 5000, opts.json)
      // 主题筛选：这一步是**纯花钱的**（一篇一次调用），而实测主题分布是新闻 57% /
      // AI 28% / 学术 13%，所以"只做 AI"是省掉一半以上花费的那个开关。它必须出现在
      // 确认框里——不然用户看到的是"要花 1.6 万次调用"，而不是"要花 4 千次"。
      const topics = (opts.topic as string[])
        .flatMap(value => String(value).split(','))
        .map(value => value.trim())
        .filter(Boolean)
      const workers = parseCliInteger(opts.workers, 'workers', 1, 64, opts.json)
      // 与 `chat-notes`/`draft` 同一条纪律：**"确认过了"只用一个变量**，参数在确认之后才拼
      let confirmed = !!opts.yes
      if (!opts.dryRun && !opts.refreshSummaries && !confirmed) {
        const preview = {
          success: false, dryRun: false, action: 'article-notes',
          code: 'CONFIRMATION_REQUIRED', source: opts.source, limit, topics,
          readsLocalData: true, invokesAI: true, writesLocalFiles: true, sendsNothing: true,
        }
        if (opts.json) {
          console.log(JSON.stringify(preview))
          process.exit(1)
        }
        const answer = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: '确认把这些文章（只问概念，摘要照抄）发给生成模型吗？（只写本地知识卡，不会发送任何消息）',
          default: false,
        }])
        confirmed = !!answer.confirmed
        if (!confirmed) {
          console.log(chalk.gray('已取消'))
          return
        }
      }
      const args = ['--source', String(opts.source), '--limit', String(limit),
                    ...(opts.since ? ['--since', String(opts.since)] : []),
                    ...(opts.until ? ['--until', String(opts.until)] : []),
                    ...(topics.length ? ['--topic', topics.join(',')] : []),
                    '--workers', String(workers),
                    ...(opts.refreshSummaries ? ['--refresh-summaries'] : []),
                    ...(confirmed ? ['--yes'] : []),
                    ...(opts.json ? ['--json'] : []),
                    ...(opts.dryRun ? ['--dry-run'] : [])]
      const stdout = await runPythonScript('scripts/article_notes.py', args, {
        json: opts.json,
        code: 'ARTICLE_NOTES_FAILED',
        action: 'article-notes',
        timeout: 1_800_000, maxBuffer: 50 * 1024 * 1024,
      })
      process.stdout.write(stdout)
    })
}
