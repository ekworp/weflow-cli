// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { join } from 'path'
import { getPythonCommand } from '../../utils/python.js'
import { safeSubprocessError } from '../../utils/pythonProcessEnv.js'
import { resolvePackageRoot, pythonProcessEnv, parseCliInteger, requireCliChoice } from '../context.js'

export function registerSearch(program: Command): void {

  // semantic-search
  program
    .command('search')
    .description('语义搜索知识库（聊天记录 + 文章）')
    .argument('<query>', '搜索关键词')
    .option('--top-k <n>', '返回数量', '10')
    .option('--line <line>', 'wiki=文章线(默认) / chat=聊天记录 / all=两条都搜', 'wiki')
    .option('--no-rerank', '不调用决策模型重排，只按向量/关键词相似度返回（回退到引入重排之前）')
    .option('--no-hybrid', '不融合本地 BM25 名次（默认融合；门控后实测只增不减）')
    .option('--rerank-pool <n>', '重排看多少条候选（默认 100；越大越准也越贵）')
    .option('--no-dedup', '不折叠同文本的多号转载（默认折叠，结果里带 duplicateCount）')
    .option('--with-text [n]', '给每条命中挂上本地正文（fullText / sourceFile / url）；n 为每条最多多少字')
    .option('--fetch-missing [n]', '正文太薄时按 url 抓一次（最多 n 条，默认 3；复用日报缓存）')
    .option('--mmr', '对结果做 MMR 去冗余（压掉近似的同领域邻居，可能牺牲单点召回）')
    .option('--from <account>', '只查这个公众号的文章（按文件名匹配，不走语义）')
    .option('--phrase', '把这串当**原样短语**在本地定位（FTS5/trigram，不走向量、不出境、不花钱）：回答"哪个号在哪天原样写过它"')
    .option('--api-key <key>', 'DashScope embedding API key')
    .option('--dry-run', '仅预览，不读取索引或调用向量服务')
    .option('--yes', '确认执行可能调用云端向量服务的搜索')
    .option('--json', '输出机器可读结果；执行仍需 --yes')
    .action(async (query, opts) => {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execFileAsync = promisify(execFile)
    const pkgRoot = resolvePackageRoot()
      const script = join(pkgRoot, 'scripts', 'semantic_search.py')
      const topK = parseCliInteger(opts.topK, 'top-k', 1, 100, opts.json)
      // 没传就**不转发**（默认值只在 Python 侧定义一处）：commander 对未提供的选项给 undefined，
      // 直接 parseCliInteger 会被自己的校验判成非法参数 —— 实测就是这么红的。
      const rerankPool = opts.rerankPool
        ? parseCliInteger(opts.rerankPool, 'rerank-pool', 5, 500, opts.json) : null
      requireCliChoice(opts.line, ['wiki', 'chat', 'all'], 'line', opts.json)
      // `--phrase` 走的是**纯本地**那条路（FTS5）：不出境、不花钱，所以它既不需要向量 key，
      // 也不需要确认门。把它当成"向量搜索的降级"会让人以为它也花钱、也发数据。
      const phrase = opts.phrase === true
      // 下面这些旗标只属于**向量检索**那条路；`--phrase`（FTS5 原样定位）一个都用不上。
      // 以前它们会被原样转发，然后在 Python 的 phrase 分支里被**静默忽略** —— 用户以为自己在调参，
      // 实际上什么都没发生。这类"接受但不生效"的开关比报错更贵：它会让人把默认行为当成调过的结果。
      if (phrase) {
        const irrelevant: string[] = []
        if (opts.rerank === false) irrelevant.push('--no-rerank')
        if (opts.hybrid === false) irrelevant.push('--no-hybrid')
        if (rerankPool != null) irrelevant.push('--rerank-pool')
        if (opts.dedup === false) irrelevant.push('--no-dedup')
        if (opts.withText) irrelevant.push('--with-text')
        if (opts.fetchMissing) irrelevant.push('--fetch-missing')
        if (opts.mmr) irrelevant.push('--mmr')
        if (irrelevant.length) {
          const error = `--phrase 只做原样定位，不接受 ${irrelevant.join('、')}（它们只对向量检索有意义）`
          if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', error }))
          else console.log(chalk.red(error))
          process.exit(1)
        }
      }
      const preview = {
        success: true,
        dryRun: true,
        action: 'semantic-search.query',
        phrase,
        topK,
        line: opts.line,
        noRerank: opts.rerank === false,
        noHybrid: opts.hybrid === false,
        rerankPool,
        noDedup: opts.dedup === false,
        withText: opts.withText || null,
        fetchMissing: opts.fetchMissing || null,
        mmr: opts.mmr === true,
        from: opts.from || null,
        readsLocalIndex: true,
        mayUseCloudEmbedding: !phrase,
      }
      if (opts.dryRun) {
        if (opts.json) console.log(JSON.stringify(preview))
        else console.log(chalk.cyan(phrase
          ? '预览：原样短语定位 —— 只读本地短语索引，不联网、不花钱。'
          : '预览：将读取本地语义索引，并可能把查询发送到已配置的向量服务。'))
        return
      }
      if (!phrase && !opts.yes) {
        if (opts.json) {
          console.log(JSON.stringify({ ...preview, success: false, dryRun: false, code: 'CONFIRMATION_REQUIRED' }))
          process.exit(1)
        }
        const { confirmed } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: '确认执行搜索吗？查询可能发送到已配置的云端向量服务。',
          default: false,
        }])
        if (!confirmed) {
          console.log(chalk.gray('已取消'))
          return
        }
      }
      // `--no-rerank` 是**旗标**（不是密钥）⇒ 可以走 argv；查询本身仍然只走 env（见 `privacy-paths` 那条规矩）。
      // 接这条通道之前，`OPERATIONS.md` 一直在教用户敲 `search --no-rerank`，而 CLI 会答 `unknown option`
      // —— 同一份文档里 `--line` 是通的，所以它看起来像"能用的旗标"（2026-10-11 由文档命令面那道检查发现）。
      const args: string[] = [script, 'search', '--top-k', String(topK), '--line', opts.line,
        ...(phrase ? ['--phrase'] : []),
        ...(opts.rerank === false ? ['--no-rerank'] : []),
        ...(opts.hybrid === false ? ['--no-hybrid'] : []),
        ...(opts.from ? ['--from', opts.from] : []),
        ...(rerankPool ? ['--rerank-pool', String(rerankPool)] : []),
        ...(opts.dedup === false ? ['--no-dedup'] : []),
        ...(opts.withText ? ['--with-text', opts.withText === true ? '4000' : String(opts.withText)] : []),
        ...(opts.fetchMissing ? ['--fetch-missing',
          opts.fetchMissing === true ? '3' : String(opts.fetchMissing)] : []),
        ...(opts.mmr ? ['--mmr'] : [])]
      try {
        const { stdout } = await execFileAsync(getPythonCommand(), args, {
          timeout: 60_000, maxBuffer: 10 * 1024 * 1024,
          env: {
            ...pythonProcessEnv(opts.apiKey, 'DASHSCOPE_API_KEY'),
            WEFLOW_SEARCH_QUERY: query,
          },
        })
        console.log(stdout)
      } catch (e: any) {
        console.error(chalk.red(`\n✗ ${safeSubprocessError(e, '搜索失败')}`))
        process.exit(1)
      }
    })

  program
    .command('search-index')
    .description('构建语义搜索索引')
    .option('--full', '全量重建')
    .option('--phrase', '只建**精确短语索引**（本地 FTS5/trigram，不调用向量服务、不花钱、不出境）')
    .option('--api-key <key>', 'DashScope embedding API key')
    .option('--days <n>', '聊天记录收最近多少天（默认 90）')
    .option('--article-days <n>', '日报文章收最近多少个日期目录（默认 30）')
    .option('--include-imports', '把 weflow-cli import qchat 导入的 QQ 会话也收进索引（聊天半边）')
    .option('--dry-run', '仅预览，不读取数据库、调用网络或写入索引')
    .option('--yes', '确认构建或重建索引')
    .option('--json', '输出 JSON 格式')
    .action(async (opts) => {
      // `--phrase`：短语索引那条路完全不碰向量服务（也不碰聊天库——它从语义索引的 meta.json
      // 派生），所以它不走窗口参数、不需要确认门，也不校验 key。混进下面那条路会让用户以为
      // "建个本地的检索也要花 vector 的钱"。
      if (opts.phrase) {
        const phrasePreview = {
          success: true, dryRun: true, action: 'search-index.build-phrase',
          readsLocalData: true, usesCloudEmbedding: false, rebuildsPhraseIndex: true,
        }
        if (opts.dryRun) {
          if (opts.json) console.log(JSON.stringify(phrasePreview))
          else console.log(chalk.cyan('短语索引预览：全量重建本地 FTS5 索引（含两条线），不联网、不花钱。'))
          return
        }
        const { execFile } = await import('child_process')
        const { promisify } = await import('util')
        const execFileAsync = promisify(execFile)
        const pkgRoot = resolvePackageRoot()
        const script = join(pkgRoot, 'scripts', 'semantic_search.py')
        try {
          const { stdout } = await execFileAsync(getPythonCommand(),
            [script, 'phrase-build', '--line', 'all'],
            { timeout: 600_000, maxBuffer: 10 * 1024 * 1024, env: pythonProcessEnv() })
          console.log(opts.json ? stdout.trim() : stdout)
        } catch (e: any) {
          console.error(chalk.red(`\n✗ ${safeSubprocessError(e, '建短语索引失败')}`))
          process.exit(1)
        }
        return
      }
      // 窗口的**运行值由这里说了算**：默认值 + 校验 + 透传都在这一处，预览报的就是真跑的那些
      // （脚本文档里另有自己的默认值，只供手动直接跑脚本时用；CLI 这条路永远显式传参，
      // 所以两边万一漂了也不会影响实际行为）。
      // 上限 36500 天≈100 年：不设上限的后果是"给个 1e9 就把遍历变成一次全库穿透"。
      const chatDays = opts.days === undefined ? 90 : parseCliInteger(opts.days, 'days', 1, 36_500, opts.json)
      const articleDays = opts.articleDays === undefined
        ? 30 : parseCliInteger(opts.articleDays, 'article-days', 1, 36_500, opts.json)
      const windowText = `聊天最近 ${chatDays} 天、日报最近 ${articleDays} 个日期目录`
      const preview = {
        success: true,
        dryRun: true,
        action: 'search-index.build',
        mode: opts.full ? 'full' : 'incremental',
        chatDays,
        articleDays,
        includeImports: !!opts.includeImports,
        readsLocalData: true,
        usesCloudEmbedding: true,
        replacesExistingIndex: !!opts.full,
      }
      if (opts.dryRun) {
        if (opts.json) console.log(JSON.stringify(preview))
        else console.log(chalk.cyan(`语义索引预览：${opts.full ? '全量重建' : '增量构建'}；`
          + `窗口＝${windowText}（要改：--days / --article-days），将读取本地数据并调用向量服务`))
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
          // 窗口是**代价的一部分**：天数越多，发给向量服务的文本越多。所以确认语里要写出来，
          // 而不是只说"本地文本将发送"。
          message: `确认${opts.full ? '全量重建' : '增量构建'}语义索引（${windowText}）？`
            + '这些文本将发送到已配置的向量服务。',
          default: false,
        }])
        if (!confirmed) {
          console.log(chalk.gray('已取消'))
          return
        }
      }
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execFileAsync = promisify(execFile)
    const pkgRoot = resolvePackageRoot()
      const script = join(pkgRoot, 'scripts', 'semantic_search.py')
      const args: string[] = [script, 'build', '--days', String(chatDays),
                              '--article-days', String(articleDays)]
      if (opts.full) args.push('--full')
      if (opts.includeImports) args.push('--include-imports')
      try {
        const { stdout } = await execFileAsync(getPythonCommand(), args, {
          // 30 分钟：全量重建实测要跑二十分钟以上（16k 条 / 1500+ 批），而这里原来给的是 5 分钟 --
          // 那个值让 `--full` 在真实索引上**从来没跑完过**（超时被杀；且脚本改成了边嵌边落盘之前，
          // 中途被杀等于连已经嵌好的那部分也一起丢）。
          timeout: 1_800_000, maxBuffer: 10 * 1024 * 1024,
          env: pythonProcessEnv(opts.apiKey, 'DASHSCOPE_API_KEY'),
        })
        if (opts.json) console.log(stdout.trim())
        else console.log(stdout)
      } catch (e: any) {
        console.error(chalk.red(`\n✗ ${safeSubprocessError(e)}`))
        process.exit(1)
      }
    })

  // chat
  program
    .command('chat')
    .description('RAG 智能助手 — 基于聊天记录和公众号的对话式问答')
    .argument('[question]', '要问的问题（不传则进入交互模式）')
    .option('--top-k <n>', '检索数量', '10')
    .option('--line <line>', 'wiki=文章/文章概念(默认) / chat=聊天记录 / all=两条都搜', 'wiki')
    .option('--talker <name>', '限定联系人/群聊')
    .option('--api-key <key>', 'AI API key')
    .option('--dry-run', '仅预览，不读取知识库或调用 AI')
    .option('--yes', '确认读取本地知识并发送筛选后的上下文到 AI')
    .option('--json', 'JSON 输出；单次执行仍需 --yes，交互模式不可由机器启动')
    .action(async (question, opts) => {
      const { execFile, spawn } = await import('child_process')
      const { promisify } = await import('util')
      const execFileAsync = promisify(execFile)
    const pkgRoot = resolvePackageRoot()
      const script = join(pkgRoot, 'scripts', 'rag_chat.py')
      const topK = parseCliInteger(opts.topK, 'top-k', 1, 100, opts.json)
      requireCliChoice(opts.line, ['wiki', 'chat', 'all'], 'line', opts.json)
      const preview = {
        success: true,
        dryRun: true,
        action: 'rag-chat.query',
        topK,
        line: opts.line,
        interactiveRequired: !question,
        readsLocalKnowledge: true,
        usesCloudEmbedding: true,
        usesAi: true,
        sendsSelectedContextToAi: true,
        conversationRestricted: Boolean(opts.talker),
      }
      if (opts.dryRun) {
        if (opts.json) console.log(JSON.stringify(preview))
        else console.log(chalk.cyan(`预览：将读取本地知识并调用 AI${question ? '' : '；未提供问题时会进入人工交互模式'}。`))
        return
      }
      if (!question && opts.json) {
        console.log(JSON.stringify({ ...preview, success: false, dryRun: false, code: 'INTERACTIVE_REQUIRED' }))
        process.exit(1)
      }
      if (!opts.yes) {
        if (opts.json) {
          console.log(JSON.stringify({ ...preview, success: false, dryRun: false, code: 'CONFIRMATION_REQUIRED' }))
          process.exit(1)
        }
        const { confirmed } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: '确认读取本地知识并将筛选后的上下文发送到 AI 服务吗？',
          default: false,
        }])
        if (!confirmed) {
          console.log(chalk.gray('已取消'))
          return
        }
      }
      const args: string[] = [script]
      if (question) {
        args.push('--top-k', String(topK), '--line', opts.line)
        if (opts.json) args.push('--json')
        try {
          const { stdout } = await execFileAsync(getPythonCommand(), args, {
            timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
            env: {
              ...pythonProcessEnv(opts.apiKey),
              WEFLOW_RAG_QUESTION: question,
              ...(opts.talker ? { WEFLOW_RAG_TALKER: opts.talker } : {}),
            },
          })
          console.log(stdout)
        } catch (e: any) {
          console.error(chalk.red(`\n✗ ${safeSubprocessError(e, '对话失败')}`))
          process.exit(1)
        }
      } else {
        // 交互模式：使用 spawn 保持终端交互
        args.push('--interactive', '--top-k', String(topK), '--line', opts.line)
        const child = spawn(getPythonCommand(), args, {
          windowsHide: true,
          stdio: 'inherit',
          env: {
            ...pythonProcessEnv(opts.apiKey),
            ...(opts.talker ? { WEFLOW_RAG_TALKER: opts.talker } : {}),
          },
        })
        await new Promise<void>((resolve) => child.on('exit', (code) => {
          if (code !== 0) process.exit(code || 1);
          resolve();
        }))
      }
    })
}
