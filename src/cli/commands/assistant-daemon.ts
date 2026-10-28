// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { configService } from '../../services/configService.js'
import { parseCliInteger } from '../context.js'

export function registerAssistantDaemon(program: Command): void {

// ==================== assistant (第二大脑持久化 Agent) ====================
const assistantCmd = program
  .command('assistant')
  .description('第二大脑助手 — 微信里的持久化 AI Agent (常驻 + 记忆 + DeepSeek)')

assistantCmd
  .command('start')
  .description('后台启动守护进程 (重启电脑前持续在线)')
  .option('--dry-run', '仅预览，不启动守护进程')
  .option('--yes', '确认启动')
  .option('--json', '输出 JSON 格式；启动仍需 --yes')
  .action(async (opts) => {
    const preview = { action: 'assistant.start', sideEffects: ['background-process', 'message-processing', 'possible-ai-usage'] }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify({ success: true, dryRun: true, ...preview }))
      else console.log(chalk.cyan('将后台启动第二大脑守护进程'))
      return
    }
    if (opts.json && !opts.yes) {
      console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认启动助手', ...preview }))
      process.exit(1)
    }
    const { startDaemon } = await import('../../services/assistantDaemon.js')
    const r = await startDaemon()
    if (opts.json) {
      console.log(JSON.stringify(r.started
        ? { success: true, started: true, pid: r.pid, ...preview }
        : { success: false, code: 'ASSISTANT_START_FAILED', started: false, error: '助手启动失败或已经运行', ...preview }))
      if (!r.started) process.exit(1)
      return
    }
    if (r.started) {
      console.log(chalk.green(`✓ 守护进程已启动 (pid ${r.pid})`))
      console.log(chalk.gray('  在微信 ClawBot 对话里直接说话即可'))
      console.log(chalk.gray('  日志: weflow-cli assistant log'))
      console.log(chalk.gray('  停止: weflow-cli assistant stop'))
    } else {
      console.log(chalk.yellow(`⚠ ${r.error}`))
    }
  })

assistantCmd
  .command('stop')
  .description('停止守护进程')
  .option('--dry-run', '仅预览，不停止守护进程')
  .option('--yes', '确认停止')
  .option('--json', '输出 JSON 格式；停止仍需 --yes')
  .action(async (opts) => {
    const preview = { action: 'assistant.stop', sideEffects: ['background-process'] }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify({ success: true, dryRun: true, ...preview }))
      else console.log(chalk.cyan('将停止第二大脑守护进程'))
      return
    }
    if (opts.json && !opts.yes) {
      console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认停止助手', ...preview }))
      process.exit(1)
    }
    const { stopDaemon } = await import('../../services/assistantDaemon.js')
    const r = stopDaemon()
    if (opts.json) {
      console.log(JSON.stringify({ success: r.stopped, stopped: r.stopped, code: r.stopped ? null : 'ASSISTANT_STOP_FAILED', ...preview }))
      if (!r.stopped) process.exit(1)
      return
    }
    console.log(r.stopped ? chalk.green(`✓ ${r.message}`) : chalk.yellow(`⚠ ${r.message}`))
  })

assistantCmd
  .command('status')
  .description('查看运行状态')
  .option('--json', '输出 JSON 格式，不返回令牌、成员或日志内容')
  .action(async (opts) => {
    const { isDaemonAlive, tailLog, rotateLogIfNeeded } = await import('../../services/assistantDaemon.js')
    const { alive, pid } = isDaemonAlive()
    const token = configService.get('wechatOcToken')
    const aiKey = configService.get('deepseekApiKey')
    const { privacyGate } = await import('../../services/assistantPrivacy.js')
    const { readEndpoint } = await import('../../panel/endpoint.js')
    const wl = String(configService.get('assistantWhitelist') || '').trim()
    const groups = String(configService.get('assistantGroupWhitelist') || '').trim()
    // 端点是**运行态**的权威来源：它由守护进程原子写出，而且读取端会探活（进程没了就当没有）。
    // 它能回答一个配置回答不了的问题：**通道到底接上了没有**。
    // `messageChannelLoggedIn` 说的只是"配了 token 吗"——token 配了而进程以本机模式跑着，
    // 这两个字段会一个 true 一个 false，今天完全没有别的办法区分。
    const endpoint = alive ? readEndpoint() : null
    if (opts.json) {
      console.log(JSON.stringify({
        success: true,
        daemonRunning: alive,
        messageChannelLoggedIn: !!token,
        channelActive: !!endpoint && endpoint.channel === 'wechat',
        mode: endpoint ? endpoint.channel : null,
        panelPort: endpoint ? endpoint.port : null,
        memoryBucket: endpoint ? endpoint.memoryBucket : null,
        aiConfigured: privacyGate.isLocalInference() || !!aiKey,
        localInference: privacyGate.isLocalInference(),
        privacyMode: privacyGate.mode(),
        whitelistCount: wl ? wl.split(/[,;\s]+/).filter(Boolean).length : 0,
        groupWhitelistCount: groups ? groups.split(/[,;\s]+/).filter(Boolean).length : 0,
        groupMentionRequired: configService.get('assistantGroupRequireMention') !== 'false',
      }, null, 2))
      return
    }
    console.log(`守护进程: ${alive ? chalk.green(`运行中 (pid ${pid})`) : chalk.gray('未运行')}`)
    console.log(`消息通道: ${token ? chalk.green('已登录') : chalk.red('未登录 (先 login-wechat)')}`)
    if (endpoint) {
      console.log(`  └ 实际接入: ${endpoint.channel === 'wechat' ? chalk.green('微信') : chalk.yellow('仅本机入口')}`
        + `｜本机入口 http://127.0.0.1:${endpoint.port}｜记忆桶 ${endpoint.memoryBucket}`)
    } else if (alive) {
      console.log(chalk.gray('  └ 本机入口未启动（看 assistant log 里的“本机入口启动失败”）'))
    }
    console.log(`LLM 大脑: ${aiKey ? chalk.green('DeepSeek 已配置') : chalk.gray('未配置 (config set deepseekApiKey)')}`)
    console.log(`隐私模式: ${chalk.cyan(privacyGate.mode())}${privacyGate.isLocalInference() ? chalk.green(' (本地推理, 数据不出境)') : chalk.gray(' (工具结果脱敏后出境)')}`)
    console.log(`白名单: ${wl ? chalk.green(`${wl.split(/[,;\s]+/).filter(Boolean).length} 人`) : chalk.red('未设置 (默认拒绝所有人; config set assistantWhitelist "<@im.wechat ID>")')}`)
    console.log(`群聊实验: ${groups ? chalk.yellow(`${groups.split(/[,;\s]+/).filter(Boolean).length} 个已配置，等待上游群事件`) : chalk.gray('未配置（默认拒绝所有群）')}`)
    console.log(`群聊 @ 门槛: ${configService.get('assistantGroupRequireMention') === 'false' ? chalk.red('已关闭') : chalk.green('已开启')}`)
    console.log(`用量护栏: ${chalk.cyan('100 条/天')} (微信内发「记忆」可查今日用量)`)
    rotateLogIfNeeded()
    console.log(chalk.cyan('\n最近日志:'))
    console.log(chalk.gray(tailLog(10)))
  })

assistantCmd
  .command('log')
  .description('查看守护进程日志 (最近 N 行)')
  .option('-n, --lines <number>', '行数', '30')
  .option('--json', '仅输出日志可用状态和行数，不返回日志内容')
  .action(async (opts) => {
    const { tailLog } = await import('../../services/assistantDaemon.js')
    const lines = parseCliInteger(opts.lines, 'lines', 1, 1000, opts.json)
    const content = tailLog(lines)
    if (opts.json) {
      const available = !content.startsWith('(')
      console.log(JSON.stringify({
        success: true,
        available,
        requestedLines: lines,
        returnedLineCount: available ? content.split(/\r?\n/).length : 0,
      }))
      return
    }
    console.log(content)
  })

assistantCmd
  .command('trace')
  .description('看助手最近几轮是怎么走的（判断层 → 工具 → 答复），含模型返回的推理内容')
  .option('-n, --last <number>', '看最近几轮', '3')
  .option('--json', '输出结构化轨迹')
  .action(async (opts) => {
    const { readTurns, describeTurn, traceFile } = await import('../../services/assistantTrace.js')
    const count = parseCliInteger(opts.last, 'last', 1, 50, opts.json)
    const turns = readTurns(count)
    if (opts.json) {
      console.log(JSON.stringify({ success: true, file: traceFile(), count: turns.length, turns }))
      return
    }
    if (!turns.length) {
      console.log('还没有轨迹。助手收到消息之后才会有；文件：' + traceFile())
      return
    }
    console.log(traceFile())
    for (const turn of turns) {
      for (const line of describeTurn(turn)) console.log(line)
      console.log('')
    }
  })

assistantCmd
  .command('run')
  .description('前台运行 (调试用; 常驻请用 start)')
  .option('--dry-run', '仅预览，不连接消息通道或调用 AI')
  .option('--yes', '确认启动人工前台调试')
  .option('--json', '输出机器可读预览；实际调试必须在交互终端执行')
  .action(async (opts) => {
    const preview = {
      success: true,
      dryRun: true,
      action: 'assistant.run',
      interactiveRequired: true,
      handlesMessages: true,
      mayUseAi: true,
    }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify(preview))
      else console.log(chalk.cyan('前台助手预览：将持续处理消息并可能调用 AI，需 Ctrl+C 退出'))
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
        message: '确认在当前终端运行助手调试流程？',
        default: false,
      }])
      if (!confirmed) {
        console.log(chalk.gray('已取消'))
        return
      }
    }
    const { AssistantService } = await import('../../services/assistantService.js')
    const assistant = new AssistantService()
    console.log(chalk.cyan('第二大脑前台运行中... (Ctrl+C 退出)'))
    await assistant.start((line) => console.log(chalk.gray(line)))
  })
}
