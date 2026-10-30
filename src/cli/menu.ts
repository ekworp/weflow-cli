// 由 bin/weflow-cli.ts 拆分而来：无参数启动时的交互式菜单。
import type { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { join } from 'path'
import { configService } from '../services/configService.js'
import { chatService } from '../services/chatService.js'
import { getPythonCommand } from '../utils/python.js'
import { resolvePackageRoot, pythonProcessEnv } from './context.js'

// ==================== Interactive Menu (no arguments) ====================
export async function showInteractiveMenu(program: Command) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configured = configService.isConfigured()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasNtKey = !!configService.get('ntKey')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasLogin = !!configService.get('wechatOcToken')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasVault = !!configService.get('vaultRepo')

  // 首次运行：自动引导初始化
  if (!configured) {
    console.log(chalk.cyan('\n👋 欢迎使用 WeFlow CLI！'))
    console.log(chalk.gray('检测到尚未初始化，让我们开始设置...\n'))

    const { startInit } = await inquirer.prompt([{
      type: 'confirm',
      name: 'startInit',
      message: '是否现在开始初始化（检测微信数据目录并提取密钥）？',
      default: true,
    }])
    if (startInit) {
      const initCmd = program.commands.find(c => c.name() === 'init')
      if (initCmd) { await (initCmd as any).action(); return }
    }
    console.log(chalk.gray('\n稍后可运行: weflow-cli init\n'))
    return
  }

  // 构建菜单选项
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const choices: any[] = []

  choices.push(new inquirer.Separator('  📬 聊天记录'))
  choices.push({ name: '  查看会话列表', value: 'sessions' })
  choices.push({ name: '  查看聊天消息', value: 'messages' })
  choices.push({ name: '  导出聊天记录', value: 'export' })
  choices.push({ name: '  生成聊天月报', value: 'report' })

  choices.push(new inquirer.Separator('  📰 公众号日报'))
  choices.push({ name: '  生成今日日报', value: 'daily' })
  choices.push({ name: '  启动阅读器', value: 'daily-server' })

  choices.push(new inquirer.Separator('  💬 微信消息'))
  choices.push({
    name: `  扫码登录${hasLogin ? chalk.green(' (已登录)') : ''}`,
    value: 'login-wechat',
  })
  choices.push({
    name: `  监听消息${!hasLogin ? chalk.gray(' (需先登录)') : ''}`,
    value: 'listen',
    disabled: !hasLogin ? '请先扫码登录' : undefined,
  })
  choices.push({
    name: `  发送消息${!hasLogin ? chalk.gray(' (需先登录)') : ''}`,
    value: 'send',
    disabled: !hasLogin ? '请先扫码登录' : undefined,
  })

  const hasAiKey = !!configService.get('deepseekApiKey') || ['ollama', 'lmstudio'].includes(String(configService.get('aiEngine')))
  choices.push(new inquirer.Separator('  🧠 第二大脑 Agent'))
  choices.push({
    name: `  启动微信 AI 助手${hasLogin && hasAiKey ? '' : chalk.gray(' (需登录+API key)')}`,
    value: 'assistant-start',
    disabled: hasLogin && hasAiKey ? undefined : '需要消息通道登录和 AI 引擎配置',
  })
  choices.push({
    name: '  查看助手状态',
    value: 'assistant-status',
  })
  choices.push({
    name: '  停止助手',
    value: 'assistant-stop',
  })

  choices.push(new inquirer.Separator('  📚 知识库'))
  choices.push({ name: '  初始化 Obsidian Vault', value: 'vault-init' })
  choices.push({ name: '  编译概念图谱', value: 'wiki-compile' })
  choices.push({
    name: `  同步到远端${hasVault ? '' : chalk.gray(' (未配置仓库)')}`,
    value: 'vault-sync',
    disabled: !hasVault ? '请先配置 vaultRepo' : undefined,
  })

  choices.push(new inquirer.Separator('  📊 统计 & 报告'))
  choices.push({ name: '  📊 个人信息消费报告', value: 'chat-stats' })
  choices.push({ name: '  📚 微信读书统计', value: 'weread' })
  choices.push({ name: '  🧠 提取待办事项', value: 'extract-todos' })
  choices.push({ name: '  📝 AI 学习日报', value: 'generate-review' })

  choices.push(new inquirer.Separator('  ⚙️ 系统'))
  choices.push({ name: '  查看配置', value: 'config-show' })
  choices.push({ name: '  重新初始化', value: 'init' })

  // 显示状态摘要
  console.log(chalk.cyan('\n🚀 WeFlow CLI v1.5.0\n'))
  const statusParts: string[] = []
  statusParts.push(hasNtKey ? chalk.green('✓ 数据库') : chalk.yellow('○ 数据库'))
  statusParts.push(hasLogin ? chalk.green('✓ 消息通道') : chalk.gray('○ 消息通道'))
  statusParts.push(hasVault ? chalk.green('✓ Vault') : chalk.gray('○ Vault'))
  console.log(chalk.gray(`  状态: ${statusParts.join('  ')}\n`))

  const { action } = await inquirer.prompt([{
    type: 'select' as any,
    name: 'action',
    message: '请选择操作',
    choices,
    loop: false,
  }])

  // 辅助函数：执行命令
  const runCmd = async (name: string, opts: Record<string, any> = {}) => {
    const cmd = program.commands.find(c => c.name() === name)
    if (cmd) await (cmd as any).action(opts)
  }
  const runSubCmd = async (parent: string, child: string, opts: Record<string, any> = {}) => {
    const cmd = program.commands.find(c => c.name() === parent) as any
    const sub = cmd?.commands?.find((c: any) => c.name() === child)
    if (sub) await sub.action(opts)
  }

  switch (action) {
    case 'sessions':
      await runCmd('sessions')
      break
    case 'messages': {
      const sessions = await chatService.listSessions(undefined, 30)
      if (sessions.length === 0) { console.log(chalk.gray('无会话')); break }
      const { talker } = await inquirer.prompt([{
        type: 'select' as any, name: 'talker', message: '选择会话',
        choices: sessions.map((s, i) => ({
          name: `${String(i + 1).padStart(3)}. ${s.displayName || s.username}  ${chalk.gray((s.summary || '').slice(0, 30))}`,
          value: s.username,
        })),
        loop: false,
      }])
      await runCmd('messages', { talker, limit: '50', offset: '0' })
      break
    }
    case 'export': {
      const sessions = await chatService.listSessions(undefined, 30)
      if (sessions.length === 0) { console.log(chalk.gray('无会话')); break }
      const { talker } = await inquirer.prompt([{
        type: 'select' as any, name: 'talker', message: '选择要导出的会话',
        choices: sessions.map((s, i) => ({
          name: `${String(i + 1).padStart(3)}. ${s.displayName || s.username}`,
          value: s.username,
        })),
        loop: false,
      }])
      const { format } = await inquirer.prompt([{
        type: 'select' as any, name: 'format', message: '选择导出格式',
        choices: ['html', 'json', 'txt', 'excel'], loop: false,
      }])
      await runCmd('export', { talker, format, output: './output' })
      break
    }
    case 'report':
      await runCmd('report', {})
      break
    case 'daily': {
      const configKey = String(configService.get('deepseekApiKey') || '')
      const apiKey = process.env.DEEPSEEK_API_KEY || configKey
      if (!apiKey) {
        console.log(chalk.red('\n❌ 缺少 DeepSeek API key'))
        console.log(chalk.gray('  设置环境变量: set DEEPSEEK_API_KEY=<key>'))
        console.log(chalk.gray('  或持久化配置: weflow-cli config set deepseekApiKey <key>'))
        break
      }
      const now = new Date()
      const yyyy = now.getFullYear()
      const mm = String(now.getMonth() + 1).padStart(2, '0')
      const dd = String(now.getDate()).padStart(2, '0')
      const dateStr = `${yyyy}-${mm}-${dd}`
      const { spawn } = await import('child_process')
      const pipeline = join(resolvePackageRoot(), 'scripts', 'pipeline.py')
      console.log(chalk.cyan(`\n📰 正在生成 ${dateStr} 公众号日报...\n`))
      const child = spawn(getPythonCommand(), [pipeline, '--date', dateStr, '--interest', 'AI'], {
        windowsHide: true,
        stdio: 'inherit',
        env: pythonProcessEnv(apiKey),
      })
      await new Promise<void>((resolve) => child.on('exit', () => resolve()))
      break
    }
    case 'daily-server': {
      const now = new Date()
      const yyyy = now.getFullYear()
      const mm = String(now.getMonth() + 1).padStart(2, '0')
      const dd = String(now.getDate()).padStart(2, '0')
      const dateStr = `${yyyy}-${mm}-${dd}`
      await runCmd('fav-server', { date: dateStr, port: '8765', open: true })
      break
    }
    case 'login-wechat':
      await runCmd('login-wechat', {})
      break
    case 'assistant-start':
      await runSubCmd('assistant', 'start')
      break
    case 'assistant-status':
      await runSubCmd('assistant', 'status')
      break
    case 'assistant-stop':
      await runSubCmd('assistant', 'stop')
      break
    case 'listen':
      await runCmd('listen', {})
      break
    case 'send': {
      const sessions = await chatService.listSessions(undefined, 30)
      if (sessions.length === 0) { console.log(chalk.gray('无会话')); break }
      const { talker } = await inquirer.prompt([{
        type: 'select' as any, name: 'talker', message: '选择接收人',
        choices: sessions.map((s, i) => ({
          name: `${String(i + 1).padStart(3)}. ${s.displayName || s.username}`,
          value: s.username,
        })),
        loop: false,
      }])
      const { message } = await inquirer.prompt([{
        type: 'input', name: 'message', message: '输入消息内容',
      }])
      if (!message.trim()) { console.log(chalk.gray('已取消')); break }
      await runCmd('send', { talker, message })
      break
    }
    case 'vault-init':
      await runSubCmd('vault', 'init', {})
      break
    case 'wiki-compile':
      await runSubCmd('wiki', 'compile', {})
      break
    case 'vault-sync':
      await runSubCmd('vault', 'sync', {})
      break
    case 'config-show':
      await runSubCmd('config', 'show')
      break
    case 'chat-stats':
      await runCmd('chat-stats', { period: 'week' })
      break
    case 'weread': {
      const wCmd = program.commands.find(c => c.name() === 'weread') as any
      const statsCmd = wCmd?.commands?.find((c: any) => c.name() === 'stats')
      if (statsCmd) await statsCmd.action({ mode: 'monthly' })
      break
    }
    case 'extract-todos': {
      const sessions = await chatService.listSessions(undefined, 30)
      if (sessions.length === 0) { console.log(chalk.gray('无会话')); break }
      const { talker } = await inquirer.prompt([{
        type: 'select' as any, name: 'talker', message: '选择联系人',
        choices: sessions.map((s, i) => ({
          name: `${String(i + 1).padStart(3)}. ${s.displayName || s.username}`,
          value: s.displayName || s.username,
        })),
        loop: false,
      }])
      await runCmd('todos', { talker, days: '7' })
      break
    }
    case 'generate-review':
      await runCmd('review', {})
      break
    case 'init':
      await runCmd('init')
      break
  }
}
