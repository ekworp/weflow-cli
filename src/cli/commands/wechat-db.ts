// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { dbPathService } from '../../core/dbPathService.js'
import { keyService } from '../../core/keyService.js'
import { NtCore } from '../../core/ntCore.js'
import { configService } from '../../services/configService.js'
import { WechatMessageService } from '../../services/wechatMessageService.js'
import { parseCliInteger } from '../context.js'

export function registerWechatDb(program: Command): void {

// ==================== dbkey ====================
program
  .command('dbkey')
  .description('从运行中的微信进程提取数据库解密密钥 (自动检测版本)')
  .option('-t, --timeout <ms>', '超时时间(毫秒)', '60000')
  .option('--force', '即使已有本地配置也执行捕获')
  .option('--dry-run', '仅预览，不扫描进程内存或捕获密钥')
  .option('--yes', '确认启动人工密钥捕获流程')
  .option('--json', '输出机器可读预览；实际捕获必须在交互终端执行')
  .action(async (opts) => {
    const configured = configService.isConfigured()
    const preview = {
      success: true,
      dryRun: true,
      action: 'dbkey.capture',
      interactiveRequired: true,
      scansProcessMemory: true,
      captureRequired: Boolean(opts.force || !configured),
      writesConfiguration: false,
    }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify(preview))
      else console.log(chalk.cyan(`密钥捕获预览：${preview.captureRequired ? '将扫描运行中的微信进程' : '已有本地配置，默认不会重复捕获'}`))
      return
    }
    if (!opts.force && configured) {
      if (opts.json) {
        console.log(JSON.stringify({ success: true, action: 'dbkey.reuse', captureSkipped: true }))
        return
      }
      console.log(chalk.cyan('🔑 提取微信数据库密钥\n'))
      console.log(chalk.green('✓ 已检测到本地数据库访问配置，未重复捕获密钥。'))
      console.log(chalk.gray('  可直接运行 weflow-cli sessions 验证访问。'))
      console.log(chalk.gray('  仅在需要排障时使用 --force。'))
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
        message: '确认启动需要人工配合的数据库密钥捕获流程吗？',
        default: false,
      }])
      if (!confirmed) {
        console.log(chalk.gray('已取消'))
        return
      }
    }
    console.log(chalk.cyan('🔑 提取微信数据库密钥\n'))
    console.log(chalk.gray('请确保微信已登录且正在运行。\n'))

    if (process.platform === 'linux') {
      // Linux：/proc 内存扫描提取 NT 密钥
      const { NtCore } = await import('../../core/ntCore.js')
      const result = await NtCore.scan()
      if (result.success && result.matched && result.matched.length > 0) {
        for (const db of result.matched) {
          console.log(chalk.green(`✓ ${db.name} (${(db.size / 1024 / 1024).toFixed(1)}MB)`))
          console.log(chalk.white('  密钥: 已匹配，未显示'))
          console.log(chalk.white('  盐值: 已匹配，未显示'))
        }
        console.log(chalk.gray('\n提示: 运行 weflow-cli init 可自动写入配置'))
      } else if (result.error?.includes('PERMISSION_DENIED')) {
        console.log(chalk.red('✗ 需要 root 或 CAP_SYS_PTRACE 权限'))
        console.log(chalk.gray('  授权: sudo setcap cap_sys_ptrace=ep $(which python3)'))
        process.exit(1)
      } else {
        console.log(chalk.red(`✗ ${result.error || '未匹配到密钥'}`))
        process.exit(1)
      }
      return
    }

    const version = await keyService.detectWeChatVersion()
    if (!version) {
      console.log(chalk.red('未检测到微信进程 (WeChat.exe 或 Weixin.exe)'))
      process.exit(1)
    }
    console.log(chalk.gray(`检测到微信 ${version} 版本\n`))

    if (version === '3.x') {
      const result = await keyService.extract3xKey((msg) => {
        console.log(chalk.gray(`  ${msg}`))
      })
      if (result.success && result.key) {
        console.log(chalk.green('\n✓ 密钥已捕获，未显示'))
        console.log(chalk.green('  账号与消息目录: 已识别，未显示'))
      } else {
        console.log(chalk.red(`\n✗ 失败: ${result.error}`))
        process.exit(1)
      }
    } else {
      // `opts.json` 也要传：这一行在 `--json` 下**不可达**（上面就 `INTERACTIVE_REQUIRED` 退出了），
      // 但少传一个是安静的 —— 规则统一成"校验 helper 一律带上它"，判据才写得出来
      // （`test/json-error-surface.test.ts` 末尾那条静态检查）。
      const timeout = parseCliInteger(opts.timeout, 'timeout', 1000, 600000, opts.json)
      const result = await keyService.autoGetDbKey(timeout, (msg) => {
        console.log(chalk.gray(`  ${msg}`))
      })
      if (result.success && result.key) {
        console.log(chalk.green('\n✓ 密钥已捕获，未显示'))
        console.log(chalk.gray('\n提示: 运行 weflow-cli init 可自动派生并写入各库密钥配置'))
      } else {
        console.log(chalk.red(`\n✗ 失败: ${result.error}`))
        process.exit(1)
      }
    }
  })

// ==================== scan ====================
program
  .command('scan')
  .description('扫描微信数据目录中的账号')
  .option('-p, --path <path>', '数据目录路径')
  .option('--json', '输出机器可读摘要，不返回路径、账号标识或昵称')
  .action(async (opts) => {
    const path = opts.path || configService.get('dbPath') || dbPathService.getDefaultPath()
    const wxids = dbPathService.scanWxidCandidates(path)
    if (opts.json) {
      console.log(JSON.stringify({ success: wxids.length > 0, accountCount: wxids.length }))
      return
    }
    console.log(chalk.cyan(`扫描目录: ${path}\n`))
    if (wxids.length === 0) {
      console.log(chalk.gray('未找到账号'))
      return
    }

    console.log(chalk.cyan(`找到 ${wxids.length} 个账号:\n`))
    for (const w of wxids) {
      const time = new Date(w.modifiedTime).toLocaleString('zh-CN')
      const nickname = w.nickname ? ` (${w.nickname})` : ''
      console.log(`  ${w.wxid}${nickname}  ${chalk.gray(time)}`)
    }
  })

// ==================== login-wechat ====================
program
  .command('login-wechat')
  .description('微信扫码登录，获取消息收发权限')
  .option('--base-url <url>', 'ilink 服务地址')
  .option('--dry-run', '仅预览，不请求二维码或修改登录状态')
  .option('--yes', '确认启动人工扫码登录流程')
  .option('--json', '输出机器可读预览；实际登录必须在交互终端执行')
  .action(async (opts) => {
    const token = configService.get('wechatOcToken')
    const preview = {
      success: true,
      dryRun: true,
      action: 'wechat-channel.login',
      interactiveRequired: true,
      replacesExistingSession: !!token,
    }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify(preview))
      else console.log(chalk.cyan(`登录预览：需要人工扫码${token ? '，成功后将替换现有消息通道登录' : ''}`))
      return
    }
    if (opts.json) {
      console.log(JSON.stringify({ ...preview, success: false, dryRun: false, code: 'INTERACTIVE_REQUIRED' }))
      process.exit(1)
    }
    if (!opts.yes) {
      // stdin 不是终端时（管道、计划任务、会话里的 `!` 前缀执行）inquirer 会抛 ExitPromptError——
      // 屏幕上是一条堆栈而不是一句话。这里把它变成解释：扫码登录必须在真实终端里跑。
      // 与守护进程那条 `--yes` 是同一类毛病：交互确认被塞进一个没人能回答的 stdin。
      let confirmed = false
      try {
        const answer = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: token ? '已有登录状态，确认启动重新登录吗？' : '确认启动人工扫码登录吗？',
          default: false,
        }])
        confirmed = !!answer.confirmed
      } catch (error: any) {
        if (error?.name === 'ExitPromptError' || /force closed the prompt/.test(String(error?.message))) {
          console.log(chalk.yellow('当前环境没有可交互的终端。扫码登录必须在真实终端窗口里执行，'))
          console.log(chalk.yellow('或者加 --yes 跳过这个确认（扫码那一步仍然要人来做）。'))
          process.exit(1)
        }
        throw error
      }
      if (!confirmed) {
        console.log(chalk.gray(token ? '保持当前登录状态' : '已取消'))
        return
      }
    }

    console.log(chalk.cyan('正在获取登录二维码...\n'))
    const service = new WechatMessageService({ baseUrl: opts.baseUrl })

    try {
      const { qrcodeContent } = await service.startLogin()
      console.log(chalk.green('请用微信扫描以下二维码:\n'))

      // Print QR in terminal
      try {
        const QRCode = (await import('qrcode-terminal')).default
        QRCode.generate(qrcodeContent, { small: true })
      } catch {
        console.log(chalk.yellow('(终端二维码显示失败，请安装: npm install qrcode-terminal)'))
      }

      console.log(chalk.cyan('\n等待扫码 (约2分钟有效)...'))
      const session = await service.waitForLogin()

      if (session.status === 'confirmed') {
        console.log(chalk.green('\n✓ 登录成功!'))
        console.log(chalk.gray('  消息通道登录状态已安全保存'))
        // 助手的白名单为空时**拒绝所有人**：登录完对着自己的机器人说话，什么都不会回来。
        // 所以这里必须说清"下一步该干什么"。
        // 只打在人看的这条路上——`--json` 那条路照旧不返回账号标识。
        console.log('')
        console.log(chalk.cyan('  助手默认拒绝所有人（白名单为空）。'))
        // 这里**不**替用户写白名单：登录响应给的是 ilink_user_id，而白名单要的是入站消息里
        // 那个 from_user_id（文档里写成 <@im.wechat ID>），两者是不是同一个值**没有被验证过**
        // ——猜错的后果是"白名单非空、看着配好了、却仍然拒你"。真值在第一条被拒的消息里，
        // 所以让它自己现形（见 assistant log 的 [首次配置] 那行）。
        console.log(chalk.gray('  启用方式：先 assistant start，从你的微信给机器人发一条消息，'))
        console.log(chalk.gray('  日志里会出现一行 ' + chalk.cyan('[首次配置]')
          + chalk.gray(' 带着你自己的发送者 ID 和该执行的命令。')))
        console.log(chalk.gray('  只想先看它「本来会怎么答」而不改行为：')
          + chalk.cyan('weflow-cli config set assistantFastRoute log'))
      } else {
        console.log(chalk.red(`\n✗ 登录失败: ${session.error || '超时'}`))
      }
    } catch (e: any) {
      console.log(chalk.red(`\n✗ 登录失败: ${e.message}`))
    }
  })

// ==================== logout-wechat ====================
program
  .command('logout-wechat')
  .description('退出微信消息通道登录')
  .option('--dry-run', '仅预览，不清除登录状态')
  .option('--yes', '确认退出并清除消息通道状态')
  .option('--json', '输出机器可读结果')
  .action(async (opts) => {
    const loggedIn = !!configService.get('wechatOcToken')
    const preview = {
      success: true,
      dryRun: true,
      action: 'wechat-channel.logout',
      loggedIn,
      clearsContextTokens: true,
    }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify(preview))
      else console.log(chalk.cyan(`登出预览：${loggedIn ? '将清除消息通道登录和会话令牌' : '当前未登录，执行后状态不变'}`))
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
        message: '确认退出消息通道并清除本地会话令牌？',
        default: false,
      }])
      if (!confirmed) {
        console.log(chalk.gray('已取消'))
        return
      }
    }
    configService.set('wechatOcToken', '')
    configService.set('wechatOcAccountId', '')
    configService.set('wechatOcSyncBuf', '')
    // 登出后历史 context_token 失效, 一并清空
    configService.setContextTokens({})
    if (opts.json) console.log(JSON.stringify({ success: true, action: 'wechat-channel.logout', changed: loggedIn }))
    else console.log(chalk.green('✓ 已退出登录'))
  })
}
