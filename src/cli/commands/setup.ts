// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { basename, join } from 'path'
import { existsSync } from 'fs'
import { planSetup, runSetup } from '../../services/setupVenv.js'
import { planImportQchat, runImportQchat, listImports, readImportedSession } from '../../services/qchatImport.js'

export function registerSetup(program: Command): void {

// ==================== setup（自管 Python venv） ====================
// Issues 里最大的两类环境噪音（PowerShell 策略 / 商店占位 python 的 9009）里，
// 后者的根因是"没有能 import sqlcipher3 的 Python"。这条命令一次性解决：
// 在 ~/.weflow-cli/venv 建 venv 并装 requirements，之后 getPythonCommand() 优先用它。
program
  .command('setup')
  .description('创建自管 Python 虚拟环境 (~/.weflow-cli/venv) 并安装依赖；之后所有 Python 工作流优先用它')
  .option('--dry-run', '只看计划：venv 位置、用哪个 Python 建、装哪些包（不动任何东西）')
  .option('--yes', '跳过交互确认（机器执行路径）')
  .option('--recreate', '删除现有 venv 后重建（默认已存在则复用）')
  .option('--with-3x', '同时安装 requirements-3x.txt（微信 3.x 旧版密钥提取）')
  .option('--with-voice', '同时安装 requirements-voice.txt（本机语音转写）')
  .option('--non-interactive', '禁止交互提问；与 --yes 配合用于脚本')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    let plan
    try {
      plan = await planSetup({ recreate: !!opts.recreate, with3x: !!opts.with3x, withVoice: !!opts.withVoice })
    } catch (error: any) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'SETUP_PLAN_FAILED', error: String(error?.message || error).slice(0, 200) })); process.exit(1) }
      console.error(chalk.red(`✗ 计划失败: ${error?.message || error}`))
      process.exit(1)
    }

    if (opts.dryRun || !opts.yes) {
      const preview = {
        success: true,
        dryRun: true,
        action: 'setup.venv',
        venvDir: plan.venvDir,
        venvExists: existsSync(plan.venvDir),
        creator: plan.creator,
        requirementFiles: plan.requirementFiles,
        packages: plan.packages,
        substitutions: plan.substitutions,
        recreate: plan.recreate,
        createsUnder: plan.createsUnder,
        network: plan.network,
        // 密钥/数据库一个都不碰：这条命令只写 ~/.weflow-cli/venv
        readsLocalData: false,
      }
      if (opts.dryRun) {
        if (opts.json) { console.log(JSON.stringify(preview)); return }
        console.log(chalk.cyan('\nsetup 计划（--dry-run，不执行）'))
        console.log(chalk.gray(`  venv: ${plan.venvDir}${existsSync(plan.venvDir) ? '（已存在，默认复用）' : ''}`))
        console.log(chalk.gray(`  创建者: ${plan.creator ?? '未找到可运行的 Python（先装 Python 3.10+）'}`))
        console.log(chalk.gray(`  安装: ${plan.packages.join(' ')}`))
        for (const sub of plan.substitutions) console.log(chalk.gray(`  替换: ${sub}`))
        console.log(chalk.gray('  网络请求: pip 访问 PyPI；不读聊天数据、不碰密钥\n'))
        return
      }
      if (opts.json) {
        console.log(JSON.stringify({ ...preview, success: false, dryRun: false, code: 'CONFIRMATION_REQUIRED' }))
        process.exit(1)
      }
      if (process.env.WEFLOW_NON_INTERACTIVE || opts.nonInteractive) {
        console.error(chalk.red('✗ 非交互模式需要 --yes'))
        process.exit(1)
      }
      const { confirmed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmed',
        message: `将在 ${plan.venvDir} 创建虚拟环境并安装 ${plan.packages.length} 个包（pip 需要访问 PyPI）。继续吗？`,
        default: false,
      }])
      if (!confirmed) {
        console.log(chalk.gray('已取消'))
        return
      }
    }

    const result = await runSetup(plan, (line) => console.log(chalk.gray(`  ${line}`)))
    if (opts.json) {
      console.log(JSON.stringify(result))
      if (!result.success) process.exit(1)
      return
    }
    console.log(chalk.cyan('\nPython 环境 setup'))
    for (const step of result.steps) {
      console.log(`  ${step.ok ? '✓' : '✗'} ${step.name}${step.detail ? chalk.gray(` — ${step.detail}`) : ''}`)
    }
    if (result.success) {
      console.log(chalk.green(`\n完成。之后的 Python 工作流会优先用: ${result.venvPython}`))
      console.log(chalk.gray('  下一步: weflow-cli check 验证环境，weflow-cli init 初始化本地数据'))
    } else {
      console.log(chalk.red(`\n失败（${result.error ?? '见上方步骤'}）。把 --json 输出贴到 issue 里最好排查。`))
      process.exit(1)
    }
  })

// ==================== import（外部 IM 数据导入，D-129） ====================
// 边界是**文件契约**：读 qchat-cli `qce export --format json` 的产物，归一化落到
// output/imports/qq/，之后 chat-notes / search-index 就能把 QQ 会话当普通聊天线处理。
const importCmd = program
  .command('import')
  .description('导入外部 IM 的聊天记录（当前支持 qchat-cli 的 JSON 导出），并入本地知识管道')

importCmd
  .command('qchat <path>')
  .description('导入 qchat-cli 的 JSON 导出（单文件或目录；按 messageId 去重，重复导入安全）')
  .option('--dry-run', '只看会导入什么：文件、会话、条数（不写任何东西）')
  .option('--yes', '确认执行（写本地存储 output/imports/qq/）')
  .option('--own-id <qq>', '可选：自己的 QQ 号，用来标 isSend（不给则该字段缺省为未知）')
  .option('--json', '输出 JSON 格式')
  .action(async (inputPath: string, opts) => {
    let plan
    try {
      plan = planImportQchat(inputPath)
    } catch (error: any) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'IMPORT_PLAN_FAILED', error: String(error?.message || error).slice(0, 200) })); process.exit(1) }
      console.error(chalk.red(`✗ 计划失败: ${error?.message || error}`))
      process.exit(1)
    }

    const preview = {
      success: true,
      dryRun: true,
      action: 'import.qchat',
      input: inputPath,
      files: plan.files.map(f => ({
        file: basename(f.file), ok: f.ok,
        ...(f.reason ? { reason: f.reason } : {}),
        sessions: f.sessions.map(s => ({ id: s.id, name: s.name, type: s.type, messages: s.messages })),
      })),
      sessionsFound: plan.sessionsFound,
      messagesTotal: plan.messagesTotal,
      storeRoot: plan.storeRoot,
      ownIdProvided: Boolean(opts.ownId),
      readsLocalData: true,
      writesLocalStore: true,
      invokesAI: false,
      network: false,
    }
    if (opts.dryRun) {
      if (opts.json) { console.log(JSON.stringify(preview)); return }
      console.log(chalk.cyan('\nimport qchat 计划（--dry-run，不执行）'))
      console.log(chalk.gray(`  存储: ${plan.storeRoot}`))
      for (const f of plan.files) {
        if (f.ok) {
          for (const sess of f.sessions) {
            console.log(chalk.gray(`  ✓ ${basename(f.file)} → 会话「${sess.name}」（${sess.type}，${sess.messages} 条）`))
          }
        } else {
          console.log(chalk.yellow(`  ✗ ${basename(f.file)} — ${f.reason}`))
        }
      }
      if (opts.ownId) console.log(chalk.gray(`  isSend 判定: 按自己的 QQ 号 ${String(opts.ownId).slice(0, 4)}…`))
      console.log('')
      return
    }
    if (!opts.yes) {
      if (opts.json) {
        console.log(JSON.stringify({ ...preview, success: false, dryRun: false, code: 'CONFIRMATION_REQUIRED' }))
        process.exit(1)
      }
      console.error(chalk.red(`✗ 需要确认：将把 ${plan.messagesTotal} 条消息写入本地存储 ${plan.storeRoot}。加 --yes 执行`))
      process.exit(1)
    }

    const result = runImportQchat(inputPath, opts.ownId ? String(opts.ownId) : undefined)
    if (opts.json) {
      console.log(JSON.stringify(result))
      if (!result.success) process.exit(1)
      return
    }
    if (!result.success) {
      console.error(chalk.red(`✗ 没有可导入的文件（${result.filesSkipped} 个被跳过，原因见 --dry-run）`))
      process.exit(1)
    }
    console.log(chalk.cyan('\n导入完成'))
    for (const sess of result.sessions) {
      console.log(chalk.green(`  ✓ 「${sess.name}」共 ${sess.total} 条（新增 ${sess.added}、更新 ${sess.updated}、原样 ${sess.unchanged}）`))
    }
    if (result.filesSkipped) console.log(chalk.yellow(`  ⚠ 跳过 ${result.filesSkipped} 个不认识的文件`))
    console.log(chalk.gray(`  存储: ${result.storeRoot}`))
    console.log(chalk.gray('  下一步: weflow-cli import list 查看；chat-notes --source qq 产知识卡；search-index --include-imports 进搜索'))
  })

importCmd
  .command('list')
  .description('列出已导入的会话')
  .option('--json', '输出 JSON 格式')
  .action((opts) => {
    const entries = listImports()
    if (opts.json) { console.log(JSON.stringify({ success: true, sessions: entries })); return }
    if (!entries.length) {
      console.log(chalk.gray('\n还没有导入任何会话。先跑 weflow-cli import qchat <qchat 导出文件>'))
      return
    }
    console.log(chalk.cyan(`\n已导入 ${entries.length} 个会话`))
    for (const e of entries) {
      const span = e.newestCreateTime
        ? `${new Date((e.oldestCreateTime ?? 0) * 1000).toLocaleDateString('zh-CN')} ~ ${new Date(e.newestCreateTime * 1000).toLocaleDateString('zh-CN')}`
        : '（无消息）'
      console.log(`  「${e.name}」（${e.type}，${e.messages} 条，${span}）`)
    }
    console.log('')
  })

importCmd
  .command('show <sessionId>')
  .description('读回一个已导入会话的消息（验证导入）')
  .option('-n, --limit <n>', '只看最近 N 条（0 = 全部）', '20')
  .option('--json', '输出 JSON 格式')
  .action((sessionId: string, opts) => {
    const limit = Number(opts.limit)
    if (!Number.isInteger(limit) || limit < 0) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', error: 'limit 必须是 ≥ 0 的整数' })); process.exit(1) }
      console.error(chalk.red('✗ limit 必须是 ≥ 0 的整数'))
      process.exit(1)
    }
    const data = readImportedSession(sessionId, limit)
    if (!data) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'IMPORT_SESSION_NOT_FOUND' })); process.exit(1) }
      console.error(chalk.red(`✗ 没有会话 ${sessionId} 的导入记录`))
      process.exit(1)
    }
    if (opts.json) { console.log(JSON.stringify({ success: true, ...data })); return }
    console.log(chalk.cyan(`\n「${data.session.name}」共 ${data.messages.length} 条（存储里全部 ${listImports().find(e => e.id === sessionId)?.messages ?? '?'} 条）`))
    for (const m of data.messages) {
      const who = m.isSend === undefined ? m.senderName : (m.isSend ? '我' : m.senderName)
      console.log(chalk.gray(`[${new Date(m.createTime * 1000).toLocaleString('zh-CN')}] ${who}(${m.messageType}): `) + m.parsedContent.slice(0, 80))
    }
    console.log('')
  })
}
