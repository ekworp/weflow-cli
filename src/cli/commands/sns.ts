// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { keyService } from '../../core/keyService.js'
import { NtCore } from '../../core/ntCore.js'
import { configService } from '../../services/configService.js'
import { chatService } from '../../services/chatService.js'
import { parseCliInteger } from '../context.js'

export function registerSns(program: Command): void {

// ==================== sns (朋友圈本地缓存) ====================
const snsCmd = program
  .command('sns')
  .description('朋友圈本地缓存查询 (4.x WCDB / NT 连接均支持)')

snsCmd
  .command('timeline')
  .description('查看朋友圈时间线 (本地已缓存的动态)')
  .option('-u, --user <wxid>', '过滤指定 wxid (可多次使用)', (v: string, acc: string[]) => { acc.push(v); return acc }, [] as string[])
  .option('-k, --keyword <kw>', '内容关键词')
  .option('-n, --limit <number>', '最大数量', '20')
  .option('-o, --offset <number>', '偏移量', '0')
  .option('--start <timestamp>', '开始时间戳 (秒)')
  .option('--end <timestamp>', '结束时间戳 (秒)')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    if (!configService.isConfigured()) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'NOT_INITIALIZED', error: '未完成初始化' })); process.exit(1) }
      console.log(chalk.red('\n❌ 还没配置\n  运行: weflow-cli init\n'))
      process.exit(1)
    }

    // 先建立连接 (chatService 内部首次调用会自动 connect)
    const conn = await chatService.connect()
    if (!conn.success) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'DATABASE_CONNECTION_FAILED', error: '数据库连接失败' })); process.exit(1) }
      console.log(chalk.red(`\n❌ 数据库连接失败: ${conn.error}\n`))
      process.exit(1)
    }
    if (!chatService.isSnsSupported()) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'SNS_UNAVAILABLE', error: '当前数据通道不支持朋友圈查询' })); process.exit(1) }
      console.log(chalk.red('\n❌ 当前数据通道不支持朋友圈查询'))
      console.log(chalk.gray('  支持: 4.x + WCDB API, 或 NT 连接 + sns.db 密钥'))
      console.log(chalk.gray('  NT 用户请先运行: weflow-cli sns capture-key'))
      console.log(chalk.gray('  提示: 在微信客户端打开朋友圈让数据落盘后再查询\n'))
      process.exit(1)
    }

    const usernames = Array.isArray(opts.user) ? opts.user : (opts.user ? [opts.user] : undefined)
    const limit = parseCliInteger(opts.limit, 'limit', 1, 1000, opts.json)
    const offset = parseCliInteger(opts.offset, 'offset', 0, 1000000, opts.json)
    const startTime = opts.start ? parseCliInteger(opts.start, 'start', 0, Number.MAX_SAFE_INTEGER, opts.json) : undefined
    const endTime = opts.end ? parseCliInteger(opts.end, 'end', 0, Number.MAX_SAFE_INTEGER, opts.json) : undefined
    const result = await chatService.getSnsTimeline({
      limit,
      offset,
      usernames,
      keyword: opts.keyword,
      startTime,
      endTime,
    })

    if (!result.success || !result.timeline || result.timeline.length === 0) {
      if (opts.json) { console.log(JSON.stringify({ success: result.success, timeline: [], error: result.error || null })); return }
      console.log(chalk.gray(`未找到朋友圈动态${result.error ? `: ${result.error}` : ''}`))
      console.log(chalk.gray('提示: 在微信客户端打开朋友圈让数据落盘后再查询'))
      return
    }

    if (opts.json) {
      console.log(JSON.stringify({ success: true, timeline: result.timeline }, null, 2))
      return
    }
    console.log(chalk.cyan(`朋友圈时间线 (${result.timeline.length} 条):\n`))
    for (const item of result.timeline) {
      const ts = item.create_time || item.createTime || item.timestamp
      const time = ts ? new Date(Number(ts) * 1000).toLocaleString('zh-CN') : '未知时间'
      const author = item.username || item.user_name || item.wxid || item.nickname || '未知'
      const content = (item.content || item.text || '').replace(/\n/g, ' ').slice(0, 80)
      console.log(chalk.gray(`[${time}]`) + ` ${chalk.blue(author)}: ${content}`)
    }
  })

snsCmd
  .command('users')
  .description('列出本地缓存中有朋友圈动态的 wxid')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    if (!configService.isConfigured()) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'NOT_INITIALIZED', error: '未完成初始化' })); process.exit(1) }
      console.log(chalk.red('\n❌ 还没配置\n  运行: weflow-cli init\n'))
      process.exit(1)
    }
    const conn = await chatService.connect()
    if (!conn.success) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'DATABASE_CONNECTION_FAILED', error: '数据库连接失败' })); process.exit(1) }
      console.log(chalk.red(`\n❌ 数据库连接失败: ${conn.error}\n`))
      process.exit(1)
    }
    if (!chatService.isSnsSupported()) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'SNS_UNAVAILABLE', error: '当前数据通道不支持朋友圈查询' })); process.exit(1) }
      console.log(chalk.red('\n❌ 当前数据通道不支持朋友圈查询\n'))
      process.exit(1)
    }

    const result = await chatService.getSnsUsernames()
    if (!result.success || !result.usernames || result.usernames.length === 0) {
      if (opts.json) { console.log(JSON.stringify({ success: result.success, usernames: [], error: result.error || null })); return }
      console.log(chalk.gray('本地缓存中无朋友圈动态'))
      return
    }

    if (opts.json) {
      console.log(JSON.stringify({ success: true, usernames: result.usernames }, null, 2))
      return
    }
    console.log(chalk.cyan(`朋友圈用户 (${result.usernames.length}):\n`))
    for (let i = 0; i < result.usernames.length; i++) {
      console.log(`  ${String(i + 1).padStart(3)}. ${result.usernames[i]}`)
    }
  })

snsCmd
  .command('stats')
  .description('朋友圈本地缓存统计')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    if (!configService.isConfigured()) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'NOT_INITIALIZED', error: '未完成初始化' })); process.exit(1) }
      console.log(chalk.red('\n❌ 还没配置\n  运行: weflow-cli init\n'))
      process.exit(1)
    }
    const conn = await chatService.connect()
    if (!conn.success) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'DATABASE_CONNECTION_FAILED', error: '数据库连接失败' })); process.exit(1) }
      console.log(chalk.red(`\n❌ 数据库连接失败: ${conn.error}\n`))
      process.exit(1)
    }
    if (!chatService.isSnsSupported()) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'SNS_UNAVAILABLE', error: '当前数据通道不支持朋友圈查询' })); process.exit(1) }
      console.log(chalk.red('\n❌ 当前数据通道不支持朋友圈查询\n'))
      process.exit(1)
    }

    const myWxid = configService.get('wxid') || undefined
    const result = await chatService.getSnsExportStats(myWxid)
    if (!result.success || !result.data) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'SNS_STATS_FAILED', error: result.error || '获取统计失败' })); return }
      console.log(chalk.gray(`获取统计失败${result.error ? `: ${result.error}` : ''}`))
      return
    }

    const d = result.data
    if (opts.json) {
      console.log(JSON.stringify({ success: true, stats: d }, null, 2))
      return
    }
    console.log(chalk.cyan('朋友圈本地缓存统计:\n'))
    console.log(`  本地缓存动态总数: ${d.totalPosts}`)
    console.log(`  涉及好友数:       ${d.totalFriends}`)
    if (d.myPosts !== null) {
      console.log(`  我的动态数:       ${d.myPosts}`)
    }
    console.log(chalk.gray('\n注: 仅统计本地缓存，需在微信客户端打开朋友圈让数据落盘'))
  })

snsCmd
  .command('capture-key')
  .description('从微信进程捕获 sns.db 解密密钥 (需打开微信朋友圈触发)')
  .option('--dry-run', '仅预览，不扫描进程或修改配置')
  .option('--yes', '确认启动人工密钥捕获流程')
  .option('--json', '输出机器可读预览；实际捕获必须在交互终端执行')
  .action(async (opts) => {
    const preview = {
      success: true,
      dryRun: true,
      action: 'sns.capture-key',
      interactiveRequired: true,
      scansProcessMemory: true,
      writesEncryptedConfiguration: true,
    }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify(preview))
      else console.log(chalk.cyan('捕获预览：需要管理员终端，并由用户在微信中打开朋友圈触发'))
      return
    }
    if (opts.json) {
      console.log(JSON.stringify({ ...preview, success: false, dryRun: false, code: 'INTERACTIVE_REQUIRED' }))
      process.exit(1)
    }
    console.log(chalk.cyan('\n🔑 捕获 sns.db 解密密钥\n'))
    console.log(chalk.yellow('准备工作:'))
    console.log('  1. 确保微信 4.x (Weixin.exe) 已登录运行')
    console.log('  2. 确保当前终端以管理员身份运行')
    console.log('  3. 准备好点击微信中的"朋友圈"标签\n')

    if (!opts.yes) {
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: '准备好了吗？点击确认后请立即打开微信朋友圈',
        default: false,
      }])
      if (!confirm) {
        console.log(chalk.gray('已取消'))
        return
      }
    }

    // Check sns.db path
    let snsPath = configService.get('snsDbPath')
    if (!snsPath) {
      // Auto-detect
      try {
        const ntResult = await NtCore.scan()
        if (ntResult.databases) {
          const snsDb = ntResult.databases.find((db: any) => db.name === 'sns/sns.db')
          if (snsDb) {
            snsPath = snsDb.path
            configService.set('snsDbPath', snsDb.path)
            configService.set('snsSalt', snsDb.salt)
            console.log(chalk.green('✓ 已自动发现 sns.db'))
            console.log(chalk.gray('  数据库位置与盐值: 已识别，未显示'))
          }
        }
      } catch (e) {
        // Ignore scan errors
      }
    }
    if (!snsPath) {
      console.log(chalk.red('\n❌ 未找到 sns.db 路径，请手动设置:'))
      console.log(chalk.gray('  weflow-cli config set snsDbPath <path>'))
      console.log(chalk.gray('  weflow-cli config set snsSalt <32位hex>'))
      return
    }

    console.log(chalk.cyan('\n正在 Hook 微信进程...'))
    console.log(chalk.yellow('⚠  请立即在微信中打开"朋友圈"标签！(30 秒内)\n'))

    try {
      const result = await keyService.captureSnsKey(30000, snsPath, (msg) => {
        console.log(chalk.gray(`  ${msg}`))
      })

      if (result.success && result.key) {
        configService.set('snsKey', result.key)
        console.log(chalk.green(`\n✓ 成功捕获 sns.db 密钥!`))
        console.log(chalk.white('  密钥: 已安全保存'))
        console.log(chalk.cyan('\n现在可以使用朋友圈功能:'))
        console.log(chalk.gray('  weflow-cli sns timeline'))
        console.log(chalk.gray('  weflow-cli sns users'))
        console.log(chalk.gray('  weflow-cli sns stats'))
      } else {
        console.log(chalk.red(`\n❌ 捕获失败: ${result.error || '超时'}`))
        console.log(chalk.gray('提示:'))
        console.log(chalk.gray('  1. 确保在 30 秒内打开了朋友圈'))
        console.log(chalk.gray('  2. 如果有多个 wxid 目录，请手动设置 snsDbPath'))
        console.log(chalk.gray('  3. 或手动设置密钥: weflow-cli config set snsKey <64位hex>'))
      }
    } catch (e: any) {
      console.log(chalk.red(`\n❌ 错误: ${e.message}`))
    }
  })
}
