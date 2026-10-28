// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { join } from 'path'
import { resolvePackageRoot, parseCliInteger, runConfirmedPythonMutation, runPython } from '../context.js'

export function registerTodos(program: Command): void {

  // todos
  const todosCmd = program
    .command('todos')
    .description('待办提取与任务追踪')

  async function runTodoMutation(action: 'done' | 'undone' | 'remove', id: string, opts: { dryRun?: boolean; yes?: boolean; json?: boolean }): Promise<void> {
    if (opts.dryRun) {
      await runPython('scripts/extract_todos.py', ['preview', id, '--action', action])
      return
    }
    if (!opts.yes) {
      if (opts.json) {
        console.log(JSON.stringify({
          success: false,
          code: 'CONFIRMATION_REQUIRED',
          error: '先使用 --dry-run --json 预览，再由用户确认后使用 --yes --json 执行',
        }))
        process.exit(1)
      }
      const { confirmed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmed',
        message: `确认执行待办操作 ${action} (${id})？`,
        default: false,
      }])
      if (!confirmed) {
        console.log(chalk.gray('已取消'))
        return
      }
    }
    const command = action === 'remove' ? 'rm' : action
    await runPython('scripts/extract_todos.py', [command, id, ...(opts.json ? ['--json'] : [])])
  }

  todosCmd
    .command('extract')
    .description('AI 扫描聊天记录提取待办')
    .option('--days <n>', '扫描天数', '7')
    .option('--api-key <key>', 'DeepSeek API key')
    .option('--dry-run', '仅预览，不读取聊天、调用 AI 或写入待办')
    .option('--yes', '确认提取并写入待办')
    .option('--json', '输出机器可读结果，不返回聊天或待办正文')
    .action(async (opts) => {
      const days = parseCliInteger(opts.days, 'days', 1, 365, opts.json)
      await runConfirmedPythonMutation({
        action: 'todos.extract',
        script: join(resolvePackageRoot(), 'scripts', 'extract_todos.py'),
        args: ['extract', '--days', String(days)],
        cliOptions: opts,
        preview: { days, readsLocalChat: true, usesAi: true, writesTodos: true },
        confirmationMessage: `确认读取最近 ${days} 天聊天并发送到已配置的 AI 服务以提取待办？`,
        apiKey: opts.apiKey,
      })
    })

  todosCmd
    .command('list')
    .description('列出待办')
    .option('--status <s>', 'pending / done')
    .option('--urgency <u>', '高 / 中 / 低')
    .option('--json', 'JSON 输出')
    .action(async (opts) => {
      const a = ['list']
      if (opts.status) a.push('--status', opts.status)
      if (opts.urgency) a.push('--urgency', opts.urgency)
      if (opts.json) a.push('--json')
      await runPython('scripts/extract_todos.py', a)
    })

  todosCmd
    .command('done')
    .description('标记待办为已完成')
    .argument('<id>', '待办 ID')
    .option('--dry-run', '仅预览，不修改待办')
    .option('--yes', '确认执行修改')
    .option('--json', '输出 JSON 格式')
    .action(async (id, opts) => {
      await runTodoMutation('done', id, opts)
    })

  todosCmd
    .command('undone')
    .description('取消已完成标记')
    .argument('<id>', '待办 ID')
    .option('--dry-run', '仅预览，不修改待办')
    .option('--yes', '确认执行修改')
    .option('--json', '输出 JSON 格式')
    .action(async (id, opts) => {
      await runTodoMutation('undone', id, opts)
    })

  todosCmd
    .command('rm')
    .description('删除待办')
    .argument('<id>', '待办 ID')
    .option('--dry-run', '仅预览，不删除待办')
    .option('--yes', '确认执行删除')
    .option('--json', '输出 JSON 格式')
    .action(async (id, opts) => {
      await runTodoMutation('remove', id, opts)
    })

  todosCmd
    .command('remind')
    .description('查看待办提醒')
    .option('--json', '输出 JSON 格式')
    .action(async (opts) => {
      await runPython('scripts/extract_todos.py', ['remind', ...(opts.json ? ['--json'] : [])])
    })
}
