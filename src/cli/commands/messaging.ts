// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { basename } from 'path'
import { statSync } from 'fs'
import { configService } from '../../services/configService.js'
import { chatService } from '../../services/chatService.js'
import { WechatMessageService } from '../../services/wechatMessageService.js'
import { whitelistService, MAX_TEXT_LENGTH } from '../../services/whitelistService.js'
import { authorizeOutbound, parseOutboundPolicy, performOutbound } from '../../services/outboundSend.js'
import { resolveTalker } from '../talker.js'

export function registerMessaging(program: Command): void {

// ==================== send ====================
program
  .command('send <target> <message>')
  .description('发送文本消息给指定联系人')
  .option('--image <path>', '发图片')
  .option('--file <path>', '发文件')
  .option('--dry-run', '仅预览不实际发送')
  .option('--yes', '确认实际发送')
  .option('--json', '输出 JSON 格式；实际发送仍需 --yes')
  .option('--rate-window <ms>', '速率窗口毫秒', '60000')
  .option('--rate-max <n>', '窗口内最大发送条数', '10')
  .action(async (target: string, message: string, opts) => {
    if (opts.image && opts.file) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'CONFLICTING_MEDIA', error: '--image 与 --file 不能同时使用' }))
      else console.log(chalk.red('--image 与 --file 不能同时使用'))
      process.exit(1)
    }

    // Resolve target
    let wxid: string
    try {
      wxid = await resolveTalker(target, !!opts.json, !!opts.json)
    } catch (e: any) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'TALKER_RESOLUTION_FAILED', error: e.message }))
      else console.log(chalk.red(`${e.message}`))
      process.exit(1)
    }

    // 解析 displayName 用于二次确认 (优先用名单里存的)
    let displayName = whitelistService.lookupName(wxid)
    if (displayName === wxid) {
      try {
        const sessions = await chatService.listSessions(undefined, 200)
        const match = sessions.find(s => s.username === wxid)
        if (match?.displayName) displayName = match.displayName
      } catch {}
    }

    // 类型与预览
    const kind: 'text' | 'image' | 'file' = opts.image ? 'image' : opts.file ? 'file' : 'text'
    let preview = message.slice(0, 80) + (message.length > 80 ? '...' : '')
    if (kind !== 'text') {
      const mediaPath = String(opts.image || opts.file)
      try {
        const mediaStat = statSync(mediaPath)
        if (!mediaStat.isFile() || mediaStat.size === 0) throw new Error('invalid media')
        preview = `[${kind}] ${basename(mediaPath)} (${mediaStat.size} bytes)`
      } catch {
        if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_MEDIA_FILE', kind }))
        else console.log(chalk.red('媒体路径必须指向可读取的非空文件'))
        process.exit(1)
      }
    }

    // 文本长度限制 (仅文本)
    if (kind === 'text' && message.length > MAX_TEXT_LENGTH) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'MESSAGE_TOO_LONG', error: `文本上限为 ${MAX_TEXT_LENGTH} 字符` }))
      else {
        console.log(chalk.red(`\n❌ 文本过长 (${message.length} 字符), 上限 ${MAX_TEXT_LENGTH}`))
        console.log(chalk.gray('  过长内容请拆分多条或使用 --file 发送文件\n'))
      }
      whitelistService.auditSend({
        timestamp: Date.now(), action: 'send', targetWxid: wxid, targetName: displayName,
        kind, success: false, preview, error: `text too long (${message.length})`,
      })
      process.exit(1)
    }

    // 三道闸（黑名单 → 白名单 → 限速）与"每次尝试都写审计"在 `src/services/outboundSend.ts`
    // 里**只有一份**，因为 2026-10-01 起有了第二条发送路（`draft --pick N --send`，见 D-063）。
    // 两份写同一件事，分叉的后果具体是"某一条路绕过了白名单"。
    const policy = parseOutboundPolicy(Number(opts.rateWindow), Number(opts.rateMax))
    if ('code' in policy) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: policy.code, error: policy.error }))
      else console.log(chalk.red('速率参数无效：rate-window 必须为 1000-3600000，rate-max 必须为 1-100'))
      process.exit(1)
    }
    const attempt = {
      wxid, displayName, kind, preview, text: message,
      mediaPath: kind === 'text' ? undefined : String(opts.image || opts.file),
    }
    const decision = authorizeOutbound(attempt, policy)
    if (!decision.ok) {
      const { refusal } = decision
      if (opts.json) {
        console.log(JSON.stringify({
          success: false, code: refusal.code, error: refusal.error,
          ...(refusal.code === 'TARGET_BLOCKED' || refusal.code === 'TARGET_NOT_ALLOWED'
            ? { target: { wxid, displayName } } : {}),
          ...(refusal.rateLimit ? { rateLimit: refusal.rateLimit } : {}),
        }))
      } else if (refusal.code === 'TARGET_BLOCKED') {
        console.log(chalk.red('\n❌ 目标在黑名单中，绝对禁止发送'))
        console.log(chalk.gray(`  wxid: ${wxid}`))
        console.log(chalk.gray(`  解除: weflow-cli blacklist rm ${wxid}\n`))
      } else if (refusal.code === 'TARGET_NOT_ALLOWED') {
        console.log(chalk.red('\n❌ 目标不在白名单中，拒绝发送'))
        console.log(chalk.gray(`  先运行: weflow-cli whitelist add ${target}`))
        console.log(chalk.gray(`  查看名单: weflow-cli whitelist\n`))
      } else {
        const rate = refusal.rateLimit!
        console.log(chalk.red(`\n❌ 触发速率限制: 最近 ${rate.windowMs / 1000}s 内已发送 ${rate.count} 条 (上限 ${rate.max})`))
        console.log(chalk.gray('  请稍后再试, 或调整 --rate-window / --rate-max\n'))
      }
      process.exit(1)
    }
    const rate = decision.rate

    // 二次确认 — 同时显示 wxid + displayName + 消息预览
    const actionPreview = {
      action: 'send',
      target: { wxid, displayName },
      kind,
      preview,
      rateLimit: { count: rate.count, max: rate.max, windowMs: rate.windowMs },
    }
    if (!opts.json) {
      console.log(chalk.cyan('\n⚠️  即将发送:'))
      console.log(chalk.white(`  目标: ${displayName}`))
      console.log(chalk.gray(`  wxid: ${wxid}`))
      console.log(chalk.gray(`  类型: ${kind}`))
      console.log(chalk.gray(`  预览: ${preview}`))
      console.log(chalk.gray(`  速率: ${rate.count}/${rate.max} (窗口 ${rate.windowMs / 1000}s)\n`))
    }

    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify({ success: true, dryRun: true, ...actionPreview }))
      else console.log(chalk.yellow('⚠️  --dry-run 模式, 不实际发送'))
      return
    }

    if (opts.json && !opts.yes) {
      console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认发送', ...actionPreview }))
      process.exit(1)
    }

    if (!opts.yes) {
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `确认发送给 ${chalk.cyan(displayName)} (${wxid})？`,
        default: false,
      }])
      if (!confirm) {
        console.log(chalk.gray('已取消'))
        return
      }
    }

    // Login check
    const token = configService.get('wechatOcToken')
    if (!token) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'MESSAGE_CHANNEL_NOT_LOGGED_IN', error: '消息通道未登录' }))
      else {
        console.log(chalk.red('\n❌ 未登录消息通道'))
        console.log(chalk.gray('  先运行: weflow-cli login-wechat\n'))
      }
      process.exit(1)
    }

    // 真的发 + 按结果写审计，都在共享模块里（与 `draft --send` 同一份）
    const { success, error: errorMsg } = await performOutbound(attempt)

    if (success) {
      if (opts.json) console.log(JSON.stringify({ success: true, ...actionPreview }))
      else console.log(chalk.green('✓ 发送成功'))
    } else {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'SEND_FAILED', error: errorMsg, ...actionPreview }))
      else console.log(chalk.red(`✗ 发送失败 — ${errorMsg}`))
      if (opts.json) process.exit(1)
    }
  })

// ==================== listen ====================
program
  .command('listen')
  .description('监听微信消息 (Ctrl+C 退出)')
  .option('--target <wxid>', '只显示指定用户的消息')
  .option('--dry-run', '仅预览，不连接消息通道或输出消息')
  .option('--yes', '确认启动人工前台监听')
  .option('--json', '输出机器可读预览；实际监听必须在交互终端执行')
  .action(async (opts) => {
    const preview = {
      success: true,
      dryRun: true,
      action: 'wechat-channel.listen',
      interactiveRequired: true,
      outputsMessageContent: true,
      targetRestricted: !!opts.target,
    }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify(preview))
      else console.log(chalk.cyan('监听预览：将前台持续接收并显示白名单消息，需 Ctrl+C 退出'))
      return
    }
    if (opts.json) {
      console.log(JSON.stringify({ ...preview, success: false, dryRun: false, code: 'INTERACTIVE_REQUIRED' }))
      process.exit(1)
    }
    if (!opts.yes) {
      const { confirmed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmed',
        message: '确认在当前终端持续监听并显示白名单消息？',
        default: false,
      }])
      if (!confirmed) {
        console.log(chalk.gray('已取消'))
        return
      }
    }
    const token = configService.get('wechatOcToken')
    if (!token) {
      console.log(chalk.red('\n❌ 未登录消息通道'))
      console.log(chalk.gray('  先运行: weflow-cli login-wechat\n'))
      process.exit(1)
    }

    // Whitelist must be non-empty before listening
    const wl = whitelistService.getList()
    if (wl.length === 0) {
      console.log(chalk.red('\n❌ 白名单为空，拒绝监听'))
      console.log(chalk.gray('  为了防止收到非预期消息，必须先配置白名单'))
      console.log(chalk.gray('  运行: weflow-cli whitelist add <昵称>\n'))
      process.exit(1)
    }
    console.log(chalk.gray(`当前白名单: ${wl.length} 项`))
    const bl = whitelistService.getBlacklist()
    if (bl.length > 0) {
      console.log(chalk.gray(`当前黑名单: ${bl.length} 项 (绝对拦截)`))
    }

    const service = new WechatMessageService({ token })
    console.log(chalk.cyan('\n开始监听消息... (Ctrl+C 退出)\n'))

    service.onMessage((msg) => {
      // Whitelist filter (strict)
      if (!whitelistService.isAllowed(msg.fromUserId)) {
        return
      }
      // Target filter
      if (opts.target && msg.fromUserId !== opts.target) {
        return
      }

      const time = new Date(msg.timestampMs).toLocaleString('zh-CN')
      const kind = msg.messageKind !== 'text' ? ` [${msg.messageKind}]` : ''
      console.log(chalk.gray(`[${time}]`) + ` ${chalk.blue(msg.senderNickname || '未知发送者')}:${kind} ${msg.messageStr}`)
    })

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log(chalk.gray('\n正在停止监听...'))
      await service.stop()
      process.exit(0)
    })

    await service.startPolling()
  })
}
