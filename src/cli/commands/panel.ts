// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import { join } from 'path'
import { resolvePackageRoot } from '../context.js'

export function registerPanel(program: Command): void {

/**
 * 本机面板：不登录微信也能跟助手说话的入口。
 *
 * **它只是客户端**：消息走守护进程的回环端点，于是两个入口共用一个大脑
 * （同一份记忆、同一条配额、同一条串行队列）。面板自己起一个 `AssistantService` 会变成
 * 第二个大脑——那是这个功能最容易走错的一步。
 */
program
  .command('panel')
  .description('打开本机面板窗口 (Electron 悬浮球；没有 Electron 就降级用 Edge --app)')
  .option('--status', '只看状态，不打开窗口')
  .option('--ask <text>', '在命令行里问一句（面板减去像素）')
  .option('--dry-run', '仅预览，不启动窗口或守护进程')
  .option('--yes', '确认打开')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const { readEndpoint, endpointFile } = await import('../../panel/endpoint.js')
    const { panelStatus, panelAsk, panelPair } = await import('../../panel/client.js')

    // ---------------------------------------------------------- 只读：状态
    if (opts.status) {
      const endpoint = readEndpoint()
      if (!endpoint) {
        if (opts.json) console.log(JSON.stringify({ success: false, code: 'PANEL_NOT_RUNNING', error: '本机入口没在运行（先 weflow-cli assistant start）' }))
        else console.log(chalk.gray('本机入口没在运行（先 weflow-cli assistant start）'))
        process.exit(1)
      }
      const r = await panelStatus(endpoint)
      if (opts.json) {
        console.log(JSON.stringify(r.ok
          ? { success: true, port: endpoint.port, ...r.data }
          : { success: false, code: r.code }))
        return
      }
      if (!r.ok) { console.log(chalk.yellow(`读状态失败: ${r.code}`)); return }
      const d = r.data
      console.log(`本机入口: ${chalk.green(`http://127.0.0.1:${endpoint.port}`)}`)
      console.log(`接入: ${d.channelActive ? '微信 + 本机' : '仅本机入口'}｜今日 ${d.quota.used}/${d.quota.limit}｜LLM ${d.aiConfigured ? '已配置' : '未配置'}`)
      console.log(chalk.gray(`记忆桶: ${d.memoryBucket}`))
      if (d.memoryNote) console.log(chalk.gray(`  ${d.memoryNote}`))
      return
    }

    // ---------------------------------------------------------- 在命令行里问一句
    if (opts.ask !== undefined) {
      const text = String(opts.ask || '').trim()
      if (!text) {
        if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', error: '--ask 不能为空' }))
        else console.log(chalk.red('--ask 不能为空'))
        process.exit(1)
      }
      if (opts.json && !opts.yes) {
        console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '这会真的问助手（可能调用 AI 并占用配额），用 --yes 确认' }))
        process.exit(1)
      }
      const endpoint = readEndpoint()
      if (!endpoint) {
        if (opts.json) console.log(JSON.stringify({ success: false, code: 'PANEL_NOT_RUNNING', error: '本机入口没在运行（先 weflow-cli assistant start）' }))
        else console.log(chalk.yellow('本机入口没在运行（先 weflow-cli assistant start）'))
        process.exit(1)
      }
      const r = await panelAsk(endpoint, text)
      if (opts.json) {
        console.log(JSON.stringify(r.ok
          ? { success: true, status: r.data.status, reply: r.data.reply }
          : { success: false, code: r.code, error: r.error }))
        if (!r.ok) process.exit(1)
        return
      }
      console.log(r.ok ? r.data.reply : chalk.yellow(`没成: ${r.code}`))
      return
    }

    // ---------------------------------------------------------- 打开窗口
    const { resolveElectronBinary, resolveBrowserBinary, electronLaunchArgs,
            browserLaunchArgs, browserProfileDir } = await import('../../panel/launch.js')
    const { isDaemonAlive, startDaemon } = await import('../../services/assistantDaemon.js')
    const { weflowHome } = await import('../../panel/endpoint.js')

    const electron = resolveElectronBinary({
      packageRoot: resolvePackageRoot(),
      localAppData: process.env.LOCALAPPDATA,
      programFiles: process.env.ProgramFiles,
    })
    const browser = electron.found ? { found: null } : resolveBrowserBinary({
      programFiles: process.env.ProgramFiles,
      programFilesX86: process.env['ProgramFiles(x86)'],
      localAppData: process.env.LOCALAPPDATA,
    })
    const shell: 'electron' | 'browser' | 'none' = electron.found ? 'electron' : browser.found ? 'browser' : 'none'
    const running = isDaemonAlive().alive

    const preview = {
      action: 'panel.open',
      shell,
      daemonRunning: running,
      // 明确声明后果：面板会需要一个守护进程；关掉窗口**不会**顺手把它停掉
      willStartDaemon: !running,
      keepsRunningAfterClose: true,
      endpointFile: endpointFile(),
    }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify({ success: true, dryRun: true, ...preview }))
      else console.log(chalk.cyan(`将打开面板（${shell === 'none' ? '没有可用的窗口程序，只会打印地址' : shell}）`
        + `${running ? '' : '，并启动本机助手守护进程'}`))
      return
    }
    if (opts.json && !opts.yes) {
      console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认打开面板', ...preview }))
      process.exit(1)
    }

    // 守护进程没起来就先起，并**轮询到真的就绪**——不要相信 spawn 的返回值
    // （`startDaemon` 里没有 `child.unref()`，stdio 又是 pipe；照抄 daily-reader 的 30×100ms 循环）
    if (!running) {
      const started = await startDaemon()
      if (!started.started && !started.error?.includes('已经运行')) {
        const msg = `本机助手启动失败: ${started.error ?? '未知原因'}`
        if (opts.json) console.log(JSON.stringify({ success: false, code: 'ASSISTANT_START_FAILED', error: msg, ...preview }))
        else console.log(chalk.red(msg))
        process.exit(1)
      }
    }
    let endpoint = readEndpoint()
    for (let attempt = 0; attempt < 30 && !endpoint; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      endpoint = readEndpoint()
    }
    if (!endpoint) {
      const msg = '本机入口还没就绪（看 weflow-cli assistant log 里的“本机入口启动失败”，端口可能被占）'
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'PANEL_NOT_READY', error: msg, ...preview }))
      else console.log(chalk.red(msg))
      process.exit(1)
    }

    const { spawn } = await import('child_process')
    let launched: string
    let url: string | null = null
    if (electron.found) {
      // argv 里**什么都没有**：不带 token、不带端口、不带 URL（命令行对同机任何进程可见）
      const child = spawn(electron.found, electronLaunchArgs(join(resolvePackageRoot(), 'resources', 'panel')), {
        detached: true, stdio: 'ignore', windowsHide: true,
      })
      child.unref()
      launched = 'electron'
    } else if (browser.found) {
      // 浏览器那条路只能靠一次性口令：它单次使用、60 秒过期，所以进命令行与浏览器历史都不算泄漏
      const pair = await panelPair(endpoint)
      if (!pair.ok) {
        const msg = `换一次性口令失败: ${pair.code}`
        if (opts.json) console.log(JSON.stringify({ success: false, code: 'PAIR_FAILED', error: msg, ...preview }))
        else console.log(chalk.red(msg))
        process.exit(1)
      }
      url = pair.data.url
      const child = spawn(browser.found, browserLaunchArgs({ url, profileDir: browserProfileDir(weflowHome()) }), {
        detached: true, stdio: 'ignore', windowsHide: true,
      })
      child.unref()
      launched = 'browser'
    } else {
      // 两条路都没有：**别静默什么都不做**，把地址交出去
      const pair = await panelPair(endpoint)
      url = pair.ok ? pair.data.url : `http://127.0.0.1:${endpoint.port}/panel`
      launched = 'none'
    }

    if (opts.json) {
      // 展开在前、实际结果在后：`preview.shell` 是"打算用哪个"，这里是"实际用了哪个"，
      // 两者可能不同（例如打算用 Electron 但 spawn 之后没起来）——以后者为准
      console.log(JSON.stringify({ ...preview, success: true, shell: launched, port: endpoint.port, url }))
      return
    }
    if (launched === 'electron') {
      console.log(chalk.green(`✓ 面板已启动（记忆桶 ${endpoint.memoryBucket}）`))
      console.log(chalk.gray('  关掉窗口只是隐藏；助手仍在后台跑，要停它用 weflow-cli assistant stop'))
    } else if (launched === 'browser') {
      console.log(chalk.green('✓ 已用浏览器打开面板窗口'))
      console.log(chalk.yellow('  注意：这条路给不了悬浮球——浏览器窗口不能无边框/置顶，也没有托盘与快捷键。'))
      console.log(chalk.gray('  想要真·悬浮球：npm i -g electron 之后再跑一次'))
    } else {
      console.log(chalk.yellow('没找到 Electron，也没找到 Edge/Chrome。自己打开这个地址即可：'))
      console.log(chalk.cyan(`  ${url}`))
      console.log(chalk.gray('  想要悬浮球：npm i -g electron'))
    }
  })
}
