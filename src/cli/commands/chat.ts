// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import { configService } from '../../services/configService.js'
import { chatService } from '../../services/chatService.js'
import { emptyMessagesNote, looksLikeTalkerId } from '../../services/messageQuery.js'
import { parseCliInteger } from '../context.js'
import { resolveTalker } from '../talker.js'

export function registerChat(program: Command): void {

// ==================== sessions ====================
program
  .command('sessions')
  .description('查看会话列表')
  .option('-k, --keyword <keyword>', '搜索关键词')
  .option('-n, --limit <number>', '最大数量', '30')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const limit = parseCliInteger(opts.limit, 'limit', 1, 1000, !!opts.json)
    if (!configService.isConfigured()) {
      if (opts.json) { console.log(JSON.stringify({ success: false, error: '未完成初始化' })); process.exit(1) }
      console.log(chalk.red('请先运行 weflow-cli init'))
      process.exit(1)
    }

    const sessions = await chatService.listSessions(opts.keyword, limit)
    if (sessions.length === 0) {
      if (opts.json) { console.log(JSON.stringify({ success: true, sessions: [] })); return }
      console.log(chalk.gray('未找到会话'))
      // "0 条"有两种完全不同的原因：真的没有会话，和**初始化/密钥坏了读不出来**。
      // 后者以前只显示这一句，用户就去猜"是不是我微信坏了 / 版本太新"（issue #3/#9/#10 的老路：
      // 同一个根因被描述成三种现象）。给一条能立刻分清的动作，比让他猜有用。
      console.log(chalk.yellow('\n如果微信里明明有聊天记录，那多半是读取这一步没成功。运行这条看结论：'))
      console.log(chalk.cyan('  weflow-cli check --report'))
      console.log(chalk.gray('  它会指出卡在哪一步（Python / sqlcipher3 / 密钥 / 数据目录），那段文字可直接复制给 AI 或贴到 issue。'))
      return
    }

    if (opts.json) {
      console.log(JSON.stringify({ success: true, sessions }, null, 2))
      return
    }
    console.log(chalk.cyan(`会话列表 (${sessions.length} 条):\n`))
    console.log(chalk.gray('序号  会话ID                昵称            最后消息'))
    console.log(chalk.gray('─'.repeat(70)))

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]
      const num = String(i + 1).padStart(3)
      const id = (s.username || '').padEnd(20)
      const name = (s.displayName || '').slice(0, 12).padEnd(12)
      const summary = (s.summary || '').slice(0, 30)
      console.log(`${num}  ${id} ${name} ${summary}`)
    }
  })

// ==================== messages ====================
program
  .command('messages <talker>')
  .description('查看指定会话的消息 (支持 wxid / 昵称 / 备注 / 序号)')
  .option('-n, --limit <number>', '最大数量', '50')
  .option('-o, --offset <number>', '偏移量', '0')
  .option('-s, --start <timestamp>', '开始时间戳')
  .option('-e, --end <timestamp>', '结束时间戳')
  .option('--json', '输出 JSON 格式')
  .option('--non-interactive', '禁止交互选择；匹配不唯一时返回错误')
  .action(async (talkerInput: string, opts) => {
    const limit = parseCliInteger(opts.limit, 'limit', 1, 5000, !!opts.json)
    const offset = parseCliInteger(opts.offset, 'offset', 0, 1_000_000, !!opts.json)
    const start = opts.start === undefined ? undefined : parseCliInteger(opts.start, 'start', 0, Number.MAX_SAFE_INTEGER, !!opts.json)
    const end = opts.end === undefined ? undefined : parseCliInteger(opts.end, 'end', 0, Number.MAX_SAFE_INTEGER, !!opts.json)
    if (start !== undefined && end !== undefined && start > end) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', field: 'start', error: 'start 不能晚于 end' }))
      else console.log(chalk.red('start 不能晚于 end'))
      process.exit(1)
    }
    if (!configService.isConfigured()) {
      if (opts.json) { console.log(JSON.stringify({ success: false, error: '未完成初始化' })); process.exit(1) }
      console.log(chalk.red('\n❌ 还没配置'))
      console.log(chalk.gray('  运行: weflow-cli init\n'))
      process.exit(1)
    }

    const talker = await resolveTalker(talkerInput, opts.json, opts.nonInteractive || opts.json)

    const messages = start !== undefined || end !== undefined
      ? (await chatService.getMessagesInRange(talker, limit + offset, start, end)).slice(offset, offset + limit)
      : await chatService.getMessages(talker, limit, offset)

    if (messages.length === 0) {
      // 拼错的 ID 会被 resolveTalker 原样放行 ⇒ 取不到消息。这里补一句话把两种情况分开，
      // 但**不改退出码、也不改 success**（"没有消息"不是错误，脚本与 MCP 依赖这一点）。
      let note = ''
      if (looksLikeTalkerId(talkerInput)) {
        const [sessions, contacts] = await Promise.all([
          chatService.listSessions(talkerInput, 5),
          chatService.listContacts(talkerInput, 5),
        ])
        note = emptyMessagesNote(talkerInput, {
          sessionUsernames: sessions.map(s => s.username),
          contactUsernames: contacts.map(c => c.username),
        })
      }
      if (opts.json) {
        console.log(JSON.stringify({ success: true, talker, messages: [], ...(note ? { note } : {}) }))
        return
      }
      console.log(chalk.gray('未找到消息'))
      if (note) console.log(chalk.yellow(note))
      return
    }

    if (opts.json) {
      console.log(JSON.stringify({ success: true, talker, messages }, null, 2))
      return
    }
    console.log(chalk.cyan(`消息记录 - ${talker} (${messages.length} 条):\n`))

    for (const m of messages) {
      const time = new Date(m.createTime * 1000).toLocaleString('zh-CN')
      const senderName = m.isSend ? chalk.green('我') : chalk.blue((m as any).senderDisplay || m.senderUsername || talker)
      const content = (m.parsedContent || m.rawContent || '').replace(/\n/g, ' ').slice(0, 80)
      console.log(chalk.gray(`[${time}]`) + ` ${senderName}: ${content}`)
    }
  })
}
