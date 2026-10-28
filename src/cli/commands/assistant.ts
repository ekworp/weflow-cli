// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { join } from 'path'
import { readFileSync } from 'fs'
import { chatService } from '../../services/chatService.js'
import { getPythonCommand } from '../../utils/python.js'
import { safeSubprocessError } from '../../utils/pythonProcessEnv.js'
import { whitelistService } from '../../services/whitelistService.js'
import { authorizeOutbound, parseOutboundPolicy, performOutbound } from '../../services/outboundSend.js'
import { resolvePackageRoot, pythonProcessEnv, parseCliInteger, openLocalUrl } from '../context.js'
import { resolveTalker } from '../talker.js'

export function registerAssistant(program: Command): void {

  // decide —— 本机判断层。一个 state + 一批类型化问题，一次调用。
  // state 由调用方给，命令自己**不读任何本地数据**；但它是出境调用，所以照 awaiting/search
  // 的规矩：--dry-run 只校验、--yes 才真跑。这一版**不暴露成 MCP 工具**——那会变成
  // 远端 MCP 客户端能驱动本机往第三方发任意文本，属于要单独决策的出境面。
  program
    .command('decide')
    .description('本机判断层：一个 state + 一批类型化问题，一次调用返回带概率的答案')
    .option('--request <file>', '请求 JSON 的路径（含 state 与 questions）')
    .option('--over <glob>', '批量模式：对匹配到的每个文件问 --ask 里的每个问题（可重复）',
            (value: string, previous: string[]) => previous.concat([value]), [] as string[])
    .option('--ask <text>', '批量模式下的一个是非题，逐文件展开（可重复）',
            (value: string, previous: string[]) => previous.concat([value]), [] as string[])
    .option('--max-chars <n>', '批量模式下每个文件喂多少字符（默认 1500；它决定上限）', '1500')
    .option('--limit <n>', '批量模式最多取多少个文件（默认 50）', '50')
    .option('--model <name>', '模型别名，默认 jev-latest')
    .option('--dry-run', '只校验请求并回显形状，不调用决策模型')
    .option('--yes', '确认把 state 发送到已配置的决策模型服务')
    .option('--json', '输出机器可读结果（本命令的输出本来就是 JSON）')
    .action(async (opts) => {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const { readFileSync } = await import('fs')
      const execFileAsync = promisify(execFile)
      const pkgRoot = resolvePackageRoot()
      const decideScript = join(pkgRoot, 'scripts', 'decide.py')

      // 预览里要报"这批几个问题"，所以在这里读一眼；**校验仍然只由脚本做**，
      // 免得两处校验逻辑各说各话。
      // 两种输入方式：--request 一个文件、或 --over 批量展开。脚本自己会拒掉
      // 两个都没给的情况，所以这里不做重复校验。
      const batch = Array.isArray(opts.over) && opts.over.length > 0
      let questionCount: number | null = null
      if (batch) {
        questionCount = opts.over.length * opts.ask.length || null
      } else if (opts.request) {
        try {
          const parsed = JSON.parse(readFileSync(opts.request, 'utf8'))
          if (parsed && typeof parsed === 'object' && parsed.questions
              && typeof parsed.questions === 'object') {
            questionCount = Object.keys(parsed.questions).length
          }
        } catch {
          // 读不到或不是 JSON：交给脚本去报一个准确得多的错误。
        }
      }
      const limit = parseCliInteger(opts.limit, 'limit', 1, 500, opts.json)
      const maxChars = parseCliInteger(opts.maxChars, 'max-chars', 1, 100000, opts.json)

      const args = [decideScript,
                    ...(batch
                      ? [...opts.over.flatMap((g: string) => ['--over', g]),
                         ...opts.ask.flatMap((a: string) => ['--ask', a]),
                         '--max-chars', String(maxChars), '--limit', String(limit)]
                      : ['--request', opts.request]),
                    ...(opts.model ? ['--model', opts.model] : [])]
      if (opts.dryRun) {
        args.push('--dry-run')
      } else if (!opts.yes) {
        const preview = {
          success: false, dryRun: false, action: 'decide',
          code: 'CONFIRMATION_REQUIRED',
          questionCount, readsLocalData: batch, invokesAI: true,
        }
        if (opts.json) {
          console.log(JSON.stringify(preview))
          process.exit(1)
        }
        const { confirmed } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: `确认把请求里的 state 发送到已配置的决策模型服务吗？`
            + (questionCount === null ? '' : `（${questionCount} 个问题）`),
          default: false,
        }])
        if (!confirmed) {
          console.log(chalk.gray('已取消'))
          return
        }
      }

      try {
        const { stdout } = await execFileAsync(getPythonCommand(), args, {
          timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
          env: pythonProcessEnv(),
        })
        process.stdout.write(stdout)
      } catch (error) {
        const payload = (error as { stdout?: string }).stdout
        if (payload && payload.trim()) {
          // 脚本自己已经给出了结构化的失败，原样透传比自己编一个更有用。
          process.stdout.write(payload)
        } else {
          console.log(JSON.stringify({ success: false, code: 'DECIDE_FAILED',
            action: 'decide', error: safeSubprocessError(error) }))
        }
        process.exit(1)
      }
    })

  // awaiting —— 谁在等我回话。读本地聊天并把正文发给决策模型，所以照 search 的规矩：
  // --dry-run 预览、--yes 才真跑。它**不写任何本地数据**，但仍是一次正文出境，
  // 而聊天正文比日报的文章正文敏感一档。
  program
    .command('awaiting')
    .description('谁在等我回话：逐会话判断有没有欠下的回复（读取聊天正文并调用决策模型）')
    .option('--days <n>', '只看最近多少天有动静的会话', '14')
    .option('--limit <n>', '最多判多少个会话', '40')
    .option('--min-prob <p>', 'waiting 概率低于此值不算欠账', '0.5')
    .option('--dry-run', '仅预览会判哪些会话、要发多少字符，不调用决策模型')
    .option('--yes', '确认把聊天正文发送到已配置的决策模型服务')
    .option('--json', '输出机器可读结果；执行仍需 --yes')
    .action(async (opts) => {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execFileAsync = promisify(execFile)
      const pkgRoot = resolvePackageRoot()
      const script = join(pkgRoot, 'scripts', 'reply_debt.py')
      const days = parseCliInteger(opts.days, 'days', 1, 3650, opts.json)
      const limit = parseCliInteger(opts.limit, 'limit', 1, 500, opts.json)
      const args = [script, '--days', String(days), '--limit', String(limit),
                    '--min-prob', String(opts.minProb),
                    ...(opts.json ? ['--json'] : [])]

      if (opts.dryRun) {
        // 交给脚本自己报数：它才知道要发多少字符。这一步只读本地，零出境。
        args.push('--dry-run')
      } else if (!opts.yes) {
        const preview = {
          success: false, dryRun: false, action: 'reply-debt.scan',
          code: 'CONFIRMATION_REQUIRED', days, limit,
          readsLocalChat: true, invokesAI: true, writesNothing: true,
        }
        if (opts.json) {
          console.log(JSON.stringify(preview))
          process.exit(1)
        }
        const { confirmed } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: '确认把最近这些会话的聊天正文发送到已配置的决策模型服务吗？',
          default: false,
        }])
        if (!confirmed) {
          console.log(chalk.gray('已取消'))
          return
        }
      }

      try {
        const { stdout } = await execFileAsync(getPythonCommand(), args, {
          timeout: 600_000, maxBuffer: 50 * 1024 * 1024,
          env: pythonProcessEnv(),
        })
        process.stdout.write(stdout)
      } catch (error) {
        if (opts.json) {
          console.log(JSON.stringify({ success: false, code: 'AWAITING_FAILED', action: 'reply-debt.scan', error: safeSubprocessError(error) }))
        } else {
          console.error(chalk.red(`\n✗ ${safeSubprocessError(error)}`))
        }
        process.exit(1)
      }
    })

  // draft：判断在前、起草在后、**绝不发送**
  program
    .command('draft <talker>')
    .description('帮我起草回复：先判断（意图/风险/该不该给实质），再起草候选 —— **默认只产出文本；给了 --pick N --send 才会替你发送**')
    .option('--count <n>', '要几条候选', '3')
    .option('--pick <n>', '选第几条（从 1 数）；不带 --send 时只把那条的完整原文打出来')
    .option('--send', '把选中的那条发出去 —— **必须同时给 --pick**（不允许"自己挑一条发"），仍需 --yes/--dry-run')
    .option('--rate-window <ms>', '发送速率窗口毫秒（与 send 同一份策略）', '60000')
    .option('--rate-max <n>', '窗口内最大发送条数', '10')
    .option('--gate-commitment', '承诺未兑现时也拒绝起草（默认只在提示词里约束）')
    .option('--dry-run', '仅预览会发多少字符给哪两个模型，不调用')
    .option('--yes', '确认把这段对话发送到判断模型与生成模型')
    .option('--json', '输出机器可读结果；执行仍需 --yes')
    .action(async (talker: string, opts) => {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execFileAsync = promisify(execFile)
      // **用法错误先报**，而且都在调模型之前报：`--send` 少了 `--pick` 是"你没说发哪条"，
      // `--pick 9` 而只有 3 条是"那条根本不存在" —— 两者都不该先问一遍"要不要把对话发给云端模型"、
      // 更不该先花掉模型调用再拒绝。
      const count = parseCliInteger(opts.count, 'count', 1, 5, opts.json)
      if (opts.send && opts.pick === undefined) {
        const message = '--send 必须同时给 --pick <序号>：先看候选，再点名要发哪一条'
        if (opts.json) console.log(JSON.stringify({ success: false, code: 'PICK_REQUIRED', error: message }))
        else console.log(chalk.red(`
❌ ${message}`))
        process.exit(1)
      }
      const pick = opts.pick === undefined ? 0 : parseCliInteger(opts.pick, 'pick', 1, count, opts.json)
      const pkgRoot = resolvePackageRoot()
      const script = join(pkgRoot, 'scripts', 'draft_reply.py')
      // **"确认过了"只用一个变量表示**（`--yes` 或交互回答"是"），参数在确认之后才拼。
      // 原来的写法是先拼参数、再问，于是**交互确认那条路是坏的**：答了"是"，`args` 里
      // 却从没补上 `--yes`，脚本照样拒绝（用户看到的是"我确认了它却说没确认"）。
      // 两者合成一个变量之后，这种漏传在结构上不可能再发生。
      let confirmed = !!opts.yes
      if (!opts.dryRun && !confirmed) {
        const preview = {
          success: false, dryRun: false, action: 'draft-reply',
          code: 'CONFIRMATION_REQUIRED', talker, count,
          readsLocalChat: true, invokesAI: true, writesNothing: true, sendsNothing: true,
        }
        if (opts.json) {
          console.log(JSON.stringify(preview))
          process.exit(1)
        }
        const answer = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: '确认把这段对话发送到判断模型与生成模型吗？（只会产出候选文本，不会替你发送）',
          default: false,
        }])
        confirmed = !!answer.confirmed
        if (!confirmed) {
          console.log(chalk.gray('已取消'))
          return
        }
      }
      // ---------------- 选中并（可选）发送 ----------------
      //
      // **只有给了 `--pick` 或 `--send` 才走这条分支**；不带它们的调用与以前逐字相同（原样透传脚本输出）。
      //
      // 这条分支存在的理由：起草那一半早就有了（判断 → 候选 → 排序），缺的是"人选定之后能真的发出去"。
      // 而它的**要点是这个 `--pick`**：发送必须由人点名"第几条"。少了它，就成了"模型起草三条、
      // 模型挑一条、模型发出去" —— 那正是本仓库划掉的那件事
      // （docs/EXTENDING.md：sending is structurally unreachable from a model-driven path）。
      if (opts.pick !== undefined || opts.send) {
        // **`--dry-run` 的语义是"零出境"**，而候选必须由模型产出来 —— 两者不可兼得：不起草就没有
        // 候选，"预览某一条会发什么"这件事本身不成立。所以这里只报"会发多少字符给哪两个模型"
        // （脚本的 dry-run 本来就报这个），并把话说清楚，而不是假装预览了一条。
        if (opts.dryRun) {
          try {
            const { stdout } = await execFileAsync(getPythonCommand(),
              [script, '--talker', String(talker), '--count', String(count), '--dry-run',
               ...(opts.json ? ['--json'] : [])],
              { timeout: 120_000, maxBuffer: 20 * 1024 * 1024, env: pythonProcessEnv() })
            process.stdout.write(stdout)
          } catch (error) {
            console.error(chalk.red(`\n✗ ${safeSubprocessError(error, '预览失败')}`))
            process.exit(1)
          }
          if (!opts.json) {
            console.log(chalk.gray('\n候选要由模型产出来，所以 --dry-run 下没有候选可挑。'
              + '要预览"发第几条"：先起草一次（会调用模型），再用 --pick N --send。\n'))
          }
          return
        }
        // `--pick`/`--send` 的用法错误在 action 开头就报过了（那一段全在调模型之前）
        // 内部一律用 `--json` 拿结构化结果（用户那侧的 `--json` 管的是最终输出，两回事）
        const pickArgs = [script, '--talker', String(talker), '--count', String(count), '--json',
                          ...(confirmed ? ['--yes'] : []),
                          ...(opts.gateCommitment ? ['--gate-commitment'] : [])]
        let drafts: Array<{ text: string }> = []
        try {
          const { stdout } = await execFileAsync(getPythonCommand(), pickArgs, {
            timeout: 300_000, maxBuffer: 50 * 1024 * 1024, env: pythonProcessEnv(),
          })
          const parsed = JSON.parse(stdout)
          if (parsed.gate === 'refused') {
            // **不起草就不发**：那道闸（涉钱/风险高）拒绝时压根没有候选，这里也不能凭空发点什么
            const message = `这次不起草：${parsed.reason || '判断层拒绝了'}`
            if (opts.json) console.log(JSON.stringify({ success: false, code: 'DRAFT_REFUSED', error: message, advice: parsed.advice || [] }))
            else {
              console.log(chalk.yellow(`\n${message}`))
              for (const item of parsed.advice || []) console.log(chalk.gray(`  · ${item}`))
            }
            process.exit(1)
          }
          drafts = parsed.drafts || []
        } catch (error) {
          const message = safeSubprocessError(error, '起草失败')
          if (opts.json) console.log(JSON.stringify({ success: false, code: 'DRAFT_FAILED', error: message }))
          else console.error(chalk.red(`\n✗ ${message}`))
          process.exit(1)
        }
        const chosen = drafts[pick - 1]
        if (!chosen) {
          const message = `没有第 ${pick} 条候选（这次只有 ${drafts.length} 条）`
          if (opts.json) console.log(JSON.stringify({ success: false, code: 'PICK_OUT_OF_RANGE', error: message }))
          else console.log(chalk.red(`\n❌ ${message}`))
          process.exit(1)
        }
        if (!opts.send) {
          if (opts.json) console.log(JSON.stringify({ success: true, action: 'draft', sent: false, pick, text: chosen.text }))
          else console.log(`第 ${pick} 条：\n${chosen.text}\n\n${chalk.gray('（没有发送任何东西；要发加 --send）')}`)
          return
        }

        // 发送这一半走**与 `send` 命令完全相同的那份策略**（黑名单 → 白名单 → 限速 → 审计）
        let wxid: string
        try {
          wxid = await resolveTalker(String(talker), !!opts.json, !!opts.json)
        } catch (error: any) {
          if (opts.json) console.log(JSON.stringify({ success: false, code: 'TALKER_RESOLUTION_FAILED', error: error.message }))
          else console.log(chalk.red(`\n❌ ${error.message}`))
          process.exit(1)
        }
        let displayName = whitelistService.lookupName(wxid)
        if (displayName === wxid) {
          try {
            const sessions = await chatService.listSessions(undefined, 200)
            const match = sessions.find(s => s.username === wxid)
            if (match?.displayName) displayName = match.displayName
          } catch { /* 拿不到名字就退回 wxid */ }
        }
        const policy = parseOutboundPolicy(Number(opts.rateWindow), Number(opts.rateMax))
        if ('code' in policy) {
          if (opts.json) console.log(JSON.stringify({ success: false, code: policy.code, error: policy.error }))
          else console.log(chalk.red(`\n❌ ${policy.error}`))
          process.exit(1)
        }
        const attempt = {
          wxid, displayName, kind: 'text' as const,
          preview: chosen.text.slice(0, 80) + (chosen.text.length > 80 ? '...' : ''),
          text: chosen.text,
        }
        const decision = authorizeOutbound(attempt, policy)
        if (!decision.ok) {
          const { refusal } = decision
          if (opts.json) {
            // 这里**还没有** sendPreview（它在闸门通过之后才建），所以逐字段写
            console.log(JSON.stringify({ success: false, code: refusal.code, error: refusal.error,
              ...(refusal.rateLimit ? { rateLimit: refusal.rateLimit } : {}) }))
          } else {
            console.log(chalk.red(`\n❌ ${refusal.error}`))
            if (refusal.code === 'TARGET_NOT_ALLOWED') console.log(chalk.gray(`  先运行: weflow-cli whitelist add ${talker}\n`))
            if (refusal.code === 'TARGET_BLOCKED') console.log(chalk.gray('  这个人在黑名单里，任何一条命令行都不会发给他\n'))
            if (refusal.rateLimit) console.log(chalk.gray(`  最近 ${refusal.rateLimit.windowMs / 1000}s 内已发 ${refusal.rateLimit.count} 条\n`))
          }
          process.exit(1)
        }
        const sendPreview = { success: true, action: 'draft-send', target: { wxid, displayName },
                              pick, text: chosen.text, rateLimit: decision.rate }
        // 两段式在这里：不给 `--yes` 时，JSON 模式回 `CONFIRMATION_REQUIRED`（**带着要发的原文**），
        // 交互模式则问一句"确定把第 N 条发给 X？"。`--dry-run` 那条路在上面的分支入口就返回了
        // （它意味着零出境，与"必须由模型产出候选"不可兼得），所以这里没有第三个预览分支。
        if (opts.json && !opts.yes) {
          console.log(JSON.stringify({ ...sendPreview, success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认发送' }))
          process.exit(1)
        }
        if (!opts.yes) {
          const answer = await inquirer.prompt([{
            type: 'confirm', name: 'send', default: false,
            message: `确定把第 ${pick} 条发给 ${displayName}？`,
          }])
          if (!answer.send) {
            console.log(chalk.gray('已取消，没有发送'))
            return
          }
        }
        const sent = await performOutbound(attempt)
        if (sent.success) {
          if (opts.json) console.log(JSON.stringify(sendPreview))
          else console.log(chalk.green('✓ 发送成功'))
          return
        }
        if (opts.json) console.log(JSON.stringify({ ...sendPreview, success: false, code: 'SEND_FAILED', error: sent.error }))
        else console.log(chalk.red(`✗ 发送失败 — ${sent.error}`))
        process.exit(1)
      }

      const args = [script, '--talker', String(talker), '--count', String(count),
                    // 脚本自己有第二道闸门（`--yes` 才真的把对话发出去），所以要透传
                    ...(confirmed ? ['--yes'] : []),
                    ...(opts.gateCommitment ? ['--gate-commitment'] : []),
                    ...(opts.json ? ['--json'] : []),
                    // dry-run 交给脚本自己报数（它才知道这段对话有多少字符），这一步只读本地、零出境
                    ...(opts.dryRun ? ['--dry-run'] : [])]

      try {
        const { stdout } = await execFileAsync(getPythonCommand(), args, {
          timeout: 300_000, maxBuffer: 50 * 1024 * 1024,
          env: pythonProcessEnv(),
        })
        process.stdout.write(stdout)
      } catch (error) {
        if (opts.json) {
          console.log(JSON.stringify({ success: false, code: 'DRAFT_FAILED', action: 'draft-reply', error: safeSubprocessError(error) }))
        } else {
          console.error(chalk.red(`\n✗ ${safeSubprocessError(error)}`))
        }
        process.exit(1)
      }
    })

  // wiki graph：把概念图谱导成一张**自包含**的 3D 页面（全本地：只读 Vault、不联网、不调用模型）
  //
  // 自包含是硬要求，不是顺手：页面用 `file://` 双击打开，那时 `fetch` 会被 CORS 挡死，
  // 所以库、数据、坐标全部内联进去 —— 也因此三个库随 npm 包发（见 resources/js/graph3d/NOTICE.txt）。
  // 布局（250 tick 实测 55 秒）在构建期用 Node 算完并缓存，打开页面即用。
  program.commands.find(c => c.name() === 'wiki')?.addCommand(
    new Command('graph')
      .description('把概念图谱导成一张自包含的图谱页面（只读本地、不联网；生成的 HTML 双击就能逛）。--flat 出 2D 版')
      .option('--vault <dir>', 'Vault 根目录（默认 output/wechat-vault）')
      .option('-o, --out <file>', '页面写到哪（默认 output/knowledge-graph-3d.html）')
      .option('--ticks <n>', '力导向迭代次数（默认 250，越多越舒展也越慢）')
      .option('--cache <dir>', '布局缓存目录（派生数据；测试/多份图分开放时用）')
      .option('--flat', '2D 版：平面图（更像 Obsidian 那种），canvas 渲染，输出默认 knowledge-graph-2d.html')
      .option('--min-degree <n>', '只画在原图里连接数 ≥N 的概念（去掉细枝看骨架；0 = 全画）')
      .option('--line <which>', '只画一条线：all / wiki / chat')
      .option('--dry-run', '只报概念与链接数：不写文件、也不算布局（本地，零改动）')
      .option('--open', '生成后用默认浏览器打开它')
      .option('--json', '输出机器可读结果')
      .action(async (opts) => {
        const { execFile } = await import('child_process')
        const { promisify } = await import('util')
        const execFileAsync = promisify(execFile)
        // 2D 与 3D 是**两个入口脚本**：图怎么建共用（graph_2d 直接 import graph_3d），
        // 换的是布局维度与渲染器 —— 两套渲染器塞一个文件就没人看得完了。
        const script = join(resolvePackageRoot(), 'scripts', opts.flat ? 'graph_2d.py' : 'graph_3d.py')
        const ticks = opts.ticks === undefined ? undefined : parseCliInteger(opts.ticks, 'ticks', 1, 100000, !!opts.json)
        // `--json` 一律要：CLI 要拿到 out 路径与计数，才决定怎么印。开关只决定**给谁看**。
        const minDegree = opts.minDegree === undefined
          ? undefined : parseCliInteger(opts.minDegree, 'min-degree', 0, 100000, !!opts.json)
        const args = [script,
                      ...(opts.vault ? ['--vault', opts.vault] : []),
                      ...(opts.out ? ['--out', opts.out] : []),
                      ...(opts.cache ? ['--cache', opts.cache] : []),
                      ...(ticks === undefined ? [] : ['--ticks', String(ticks)]),
                      ...(minDegree === undefined || minDegree === 0 ? [] : ['--min-degree', String(minDegree)]),
                      ...(opts.line ? ['--line', opts.line] : []),
                      ...(opts.dryRun ? ['--dry-run'] : []),
                      '--json']
        try {
          const { stdout } = await execFileAsync(getPythonCommand(), args, {
            timeout: 900_000, maxBuffer: 64 * 1024 * 1024, env: pythonProcessEnv(),
          })
          const body = JSON.parse(stdout.slice(stdout.indexOf('{')))
          if (opts.json) {
            console.log(JSON.stringify(body))
          } else if (body.dryRun) {
            console.log(`概念 ${body.nodes} 个、链接 ${body.links} 条（--dry-run：没有写文件）`)
          } else {
            console.log(chalk.green(`✓ 已生成 ${body.out}`))
            console.log(chalk.gray(`  概念 ${body.nodes} / 链接 ${body.links} / ${body.mb} MB · ${opts.flat ? '2D' : '3D'} · 双击就能逛，不需要服务器`))
          }
          if (!opts.dryRun && opts.open && body.out) await openLocalUrl(body.out)
        } catch (error) {
          if (opts.json) {
            console.log(JSON.stringify({ success: false, code: 'GRAPH_FAILED', action: 'graph-3d', error: safeSubprocessError(error) }))
          } else {
            console.error(chalk.red(`\n✗ ${safeSubprocessError(error)}`))
          }
          process.exit(1)
        }
      })
  )

  // wiki lint：知识库体检（全本地：不联网、不调用模型）
  program.commands.find(c => c.name() === 'wiki')?.addCommand(
    new Command('lint')
      .description('知识库体检：断链、孤儿、空页、同名（本地，不联网）')
      // 不给默认值：不传 `--dir` 时体检脚本自己的默认（清单里的**全部线**）。
      // 这里曾经默认只给文章线，而脚本默认两条线都体检 ⇒"半开半合"：命令行跑出来
      // 与脚本跑出来口径不同，而两边都不报错。
      .option('--dir <dirs...>', '概念页目录（可重复；不传则体检清单里的全部线）')
      .option('--json', '输出机器可读结果')
      .action(async (opts) => {
        const { execFile } = await import('child_process')
        const { promisify } = await import('util')
        const execFileAsync = promisify(execFile)
        const script = join(resolvePackageRoot(), 'scripts', 'wiki_lint.py')
        const dirs = Array.isArray(opts.dir) ? opts.dir : (opts.dir ? [opts.dir] : [])
        const args = [script, ...dirs.flatMap((d: string) => ['--dir', String(d)]),
          ...(opts.json ? ['--json'] : [])]
        try {
          const { stdout } = await execFileAsync(getPythonCommand(), args, {
            timeout: 120_000, maxBuffer: 20 * 1024 * 1024, env: pythonProcessEnv(),
          })
          process.stdout.write(stdout)
        } catch (error) {
          if (opts.json) console.log(JSON.stringify({ success: false, code: 'WIKI_LINT_FAILED', error: safeSubprocessError(error) }))
          else console.error(chalk.red(`
✗ ${safeSubprocessError(error)}`))
          process.exit(1)
        }
      }))
}
