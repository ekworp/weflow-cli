// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import { join } from 'path'
import { existsSync, statSync } from 'fs'
import { configService } from '../../services/configService.js'
import { renderDiagnosticReport } from '../../services/diagnosticReport.js'
import { getPythonCommand } from '../../utils/python.js'
import { detectWechatClient, samePath } from '../../services/wechatClient.js'
import { WECHAT_VERIFIED, compareWechatVersions, describeCompatVerdict } from '../../services/wechatCompat.js'
import { CLI_VERSION } from '../context.js'

export function registerCheck(program: Command): void {

// ==================== check ====================
program
  .command('check')
  .description('检查运行环境（Python、pip 依赖、数据库配置）')
  .option('--json', '输出 JSON 格式，不包含数据库路径或密钥')
  .option('--report', '输出一段可直接粘贴给 AI / 贴进 issue 的诊断结论（已脱敏：用户名与 wxid 换占位符，不含密钥与聊天内容）')
  .action(async (opts) => {
    // 微信客户端的**版本**与它自报的**数据目录**：两个分支都要用，所以在这里算一次。
    // 判据见 `wechatClient.ts`（版本取活进程的 `--user-lib-dir`；取不到就是"未知"，不是"没问题"）。
    const client = await detectWechatClient()
    // 客户端自报的数据目录 vs 配置里那个数据库推出来的根：**只比是不是同一份**，
    // 路径本身不进机器可读输出（`wechat-check/v1` 一直是不含路径的）。
    //
    // **只在 4.x 上比**：这个根是从 `ntDbPath`（4.x 的库）推的，而客户端自报的那条来自 4.x 客户端
    // —— 只用 3.x 的用户（`dbPath3x`）比出来的"不是同一份"没有意义，而这句话**只在 false 时打印**
    // ⇒ 那就是一条假警告。判据不成立时给 null（"不知道"），不是 false。
    const { dirname } = await import('node:path')
    // **四层**：`…/xwechat_files/<wxid>/db_storage/message/message_0.db`
    // → message → db_storage → <wxid> → xwechat_files。少一层就退到 `<wxid>` 目录，
    // 于是两个路径永远不相等、永远报"不是同一份"（一个看着很合理的假警告）。
    const dbPathConfigured = String(configService.get('dataVersion') || '') === '4.x'
      ? String(configService.get('ntDbPath') || '')
      : ''
    const configuredRoot = dbPathConfigured
      ? dirname(dirname(dirname(dirname(dbPathConfigured))))
      : ''
    const dataDirMatchesConfig = (client.dataDirs.length && configuredRoot)
      ? client.dataDirs.some(dir => samePath(dir, configuredRoot))
      : null
    // `--json`（给机器）与 `--report`（给人/AI）用的是**同一份事实**，所以只探测一次：
    // 两个分支各写一份探测，迟早会出现"JSON 说 Python 可用、报告说不可用"这种自相矛盾。
    const collectCheckData = async () => {
      const { execFileSync } = await import('child_process')
      const requiredDependencies = ['sqlcipher3', 'html2text', 'zstandard', 'cryptography']
      const optionalDependencies = ['scrapling']
      let pythonVersion = ''
      try {
        pythonVersion = execFileSync(getPythonCommand(), ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 5000 }).trim()
      } catch {}
      const dependencyStatus = (name: string): boolean => {
        if (!pythonVersion) return false
        try {
          execFileSync(getPythonCommand(), ['-c', `import ${name}`], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
          return true
        } catch {
          return false
        }
      }
      let daemonAlive = false
      try {
        const { isDaemonAlive } = await import('../../services/assistantDaemon.js')
        daemonAlive = isDaemonAlive().alive
      } catch {}
      const engine = String(configService.get('aiEngine') || 'deepseek')
      const data = {
        success: true,
        schema: 'weflow-check/v1',
        runtime: {
          node: { available: true, version: process.versions.node },
          python: { available: !!pythonVersion, version: pythonVersion },
        },
        dependencies: {
          required: Object.fromEntries(requiredDependencies.map(name => [name, dependencyStatus(name)])),
          optional: Object.fromEntries(optionalDependencies.map(name => [name, dependencyStatus(name)])),
        },
        configuration: {
          initialized: configService.isConfigured(),
          messageDatabase: !!configService.get('ntDbPath') && existsSync(configService.get('ntDbPath')),
          momentsDatabase: !!configService.get('snsDbPath') && existsSync(configService.get('snsDbPath')),
          favoritesDatabase: !!configService.get('favDbPath') && existsSync(configService.get('favDbPath')),
          // `favoritesDatabase` only says the file is there. Reading it also
          // needs a key, and a caller that took the former for "usable" would
          // attempt favorites and always fail.
          favoritesReady: !!configService.get('favDbPath')
            && existsSync(configService.get('favDbPath'))
            && (!!configService.get('favKey') || !!configService.get('favPassphrase')),
        },
        assistant: {
          engine,
          localInference: ['ollama', 'lmstudio'].includes(engine),
          aiConfigured: ['ollama', 'lmstudio'].includes(engine) || !!configService.get('deepseekApiKey'),
          messageChannelLoggedIn: !!configService.get('wechatOcToken'),
          daemonRunning: daemonAlive,
        },
        // `version` 只从活进程取；取不到就是 null + 一句 `note`（**不是**"没问题"）。
        // `unusableVersionDirs` 是磁盘上的残留版本目录（没有 `Weixin.dll`）—— 指向它们的加载会失败。
        wechatClient: {
          running: client.running,
          version: client.version,
          loadedDirs: client.loadedDirs,
          // 客户端自报的构建 token（并列的第二来源；**不拿它推版本号**，编码规则没解出来）
          versionTokens: client.versionTokens,
          note: client.note,
          unusableVersionDirs: client.unusableVersionDirs,
          // 客户端**自己说**数据目录在哪（与配置不一致时说明两边不是同一份库）
          dataDirs: client.dataDirs,
          // 只报结论（true/false/null），**不带路径** —— 这条 schema 一直是不含路径的
          dataDirMatchesConfig,
          // `update.data` 在场 ⇒ 加载路径可能不由命令行决定：这条不确定必须跟着版本一起出去
          updateData: client.updateData,
          // 只报条数与最近时间（不读崩溃内容）
          crashRecords: client.crashRecords,
          caveats: client.caveats,
          // D-130：本机实际加载的版本 vs 本包验证过的版本（判定只有这一份实现）
          compatibility: {
            verifiedVersion: WECHAT_VERIFIED.version,
            verifiedAt: WECHAT_VERIFIED.verifiedAt,
            verdict: compareWechatVersions(client.version, WECHAT_VERIFIED.version),
          },
        },
      }
      return data
    }

    if (opts.json) {
      console.log(JSON.stringify(await collectCheckData(), null, 2))
      return
    }

    // `--report`：一段**可整段复制**的诊断块（脱敏后）。这是"用户说不清、我们又猜不准"
    // 那个循环的出口 —— issue #3/#9/#10 与 2026-10-18 那封邮件都是同一个根因被描述成四种现象。
    if (opts.report) {
      const data = await collectCheckData()
      console.log(renderDiagnosticReport({
        cliVersion: CLI_VERSION,
        // 本地时间：用户对照日志/截图时要能直接对上，UTC 会多一步换算
        generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.versions.node,
        python: {
          command: getPythonCommand(),
          available: !!data.runtime.python.available,
          version: String(data.runtime.python.version || ''),
        },
        dependencies: data.dependencies,
        configuration: data.configuration,
        keys: {
          messageKeyConfigured: !!configService.get('ntKey') || !!configService.get('decryptKey'),
          passphraseConfigured: !!configService.get('favPassphrase'),
        },
        wechatClient: {
          running: data.wechatClient.running,
          version: data.wechatClient.version,
          note: data.wechatClient.note,
          dataDirMatchesConfig: data.wechatClient.dataDirMatchesConfig,
          dataDirs: data.wechatClient.dataDirs,
          unusableVersionDirs: data.wechatClient.unusableVersionDirs,
          compatibility: data.wechatClient.compatibility,
        },
      }))
      return
    }

    console.log(chalk.cyan('🔍 WeFlow CLI 环境检查\n'))

    // 1. Node.js
    console.log(chalk.white('Node.js:'), chalk.green(`v${process.versions.node}`))

    // 2. Python
    const { execFileSync } = await import('child_process')
    const pythonCommand = getPythonCommand()
    let pythonOk = false
    try {
      const pyVer = execFileSync(pythonCommand, ['--version'], { windowsHide: true, encoding: 'utf-8', timeout: 5000 }).trim()
      console.log(chalk.white('Python: '), chalk.green(pyVer))
      pythonOk = true
    } catch {
      console.log(chalk.white('Python: '), chalk.red('✗ 未找到'))
    }

    // 3. Pip dependencies
    if (pythonOk) {
      const deps = ['sqlcipher3', 'html2text', 'zstandard', 'cryptography']
      console.log(chalk.white('\nPython 依赖:'))
      let allOk = true
      for (const dep of deps) {
        try {
          execFileSync(pythonCommand, ['-c', `import ${dep}`], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
          console.log(`  ${dep.padEnd(20)} ${chalk.green('✓')}`)
        } catch {
          console.log(`  ${dep.padEnd(20)} ${chalk.red('✗ 缺失')}`)
          allOk = false
        }
      }
      if (!allOk) {
        console.log(chalk.yellow('\n⚠️  运行以下命令安装缺失依赖：'))
        if (process.platform === 'linux') {
          console.log(chalk.gray('  pip3 install --user sqlcipher3 html2text zstandard cryptography'))
          console.log(chalk.gray('  （sqlcipher3 编译需先: sudo apt install libsqlcipher-dev）'))
        } else {
          console.log(chalk.gray('  pip install sqlcipher3 html2text zstandard cryptography'))
        }
      }
      // 可选依赖
      const optDeps = ['scrapling']
      console.log(chalk.white('\n可选依赖（提升抓取成功率）:'))
      for (const dep of optDeps) {
        try {
          execFileSync(pythonCommand, ['-c', `import ${dep}`], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
          console.log(`  ${dep.padEnd(20)} ${chalk.green('✓')}`)
        } catch {
          console.log(`  ${dep.padEnd(20)} ${chalk.gray('○ (pip install scrapling)')}`)
        }
      }
    }

    // 3.5 微信版本兼容（D-130）：本机加载的 vs 本包验证过的
    {
      const verdict = compareWechatVersions(client.version, WECHAT_VERIFIED.version)
      const mark = verdict === 'verified' ? chalk.green('✓') : verdict === 'newer-than-verified' ? chalk.yellow('⚠') : chalk.gray('·')
      console.log(chalk.white('\n微信版本兼容:'))
      // **别把"看不见"讲成"没在运行"**：沙箱/容器里本进程可能连系统进程都看不到，
      // 这时版本未知的原因是"判断不了"，不是"微信没开"（2026-10-28 实测踩过）。
      const unknownReason = client.viewFiltered
        ? '未知（进程视图被隔离，判断不了）'
        : '未知（微信没在运行）'
      const compatReason = client.viewFiltered
        ? '本进程的进程视图被隔离，看不到主程序'
        : ''
      console.log(`  ${mark} ${client.version ?? unknownReason} · ${describeCompatVerdict(verdict, WECHAT_VERIFIED.version, compatReason)}`)
    }

    // 4. Config
    console.log(chalk.white('\n配置状态:'))
    const configured = configService.isConfigured()
    const hasKey = !!configService.get('ntKey') || !!configService.get('decryptKey')
    if (configured && hasKey) {
      console.log(chalk.green('  ✓ 已初始化 — 可以运行 weflow-cli'))
    } else {
      console.log(chalk.yellow('  ○ 未初始化 — 运行 weflow-cli init'))
    }

    // 5. Databases & extensions
    const dbRows: Array<[string, string, boolean]> = [
      ['消息数据库', configService.get('ntDbPath'), true],
      ['朋友圈数据库', configService.get('snsDbPath'), true],
      ['收藏数据库', configService.get('favDbPath'), true],
    ]
    for (const [label, path, keyRequired] of dbRows) {
      if (path && existsSync(path)) {
        const stat = (await import('fs')).statSync(path)
        const mb = (stat.size / 1024 / 1024).toFixed(0)
        console.log(chalk.white(`  ${label}: ${path} (${mb}MB)`))
        // 微信"存储位置"设到别的盘时，用户目录下那个是**junction**：显示的是 C 盘路径，
        // 数据其实在 D 盘。不点出来的话，用户会以为配置指错了地方（2026-10-19 实测：
        // `C:\Users\…\xwechat_files` → `D:\微信\xwechat_files`）。
        try {
          const { realpathSync } = await import('fs')
          const real = realpathSync(path)
          if (real.toLowerCase() !== path.toLowerCase()) {
            console.log(chalk.gray(`    ↳ 软链指向 ${real}`))
          }
        } catch { /* 解析不了就不说，别拿它当错误 */ }
      } else {
        const hint = keyRequired ? ' (可选, init 或 sns/fav 命令配置)' : ''
        console.log(chalk.gray(`  ${label}: 未配置${hint}`))
      }
    }

    // 6. 微信客户端版本（`client` / `dataDirMatchesConfig` 在 action 开头已经算过）
    console.log(chalk.white('\n微信客户端:'))
    if (client.version) {
      // 并列报上客户端自报的构建 token：这是"哪个构建"的第二个来源（**不用它推版本号**）
      const token = client.versionTokens.length ? chalk.gray(`  · 自报构建 ${client.versionTokens.join('、')}`) : ''
      console.log(chalk.green(`  ✓ 运行时加载 ${client.version}`) + chalk.gray(` (${client.loadedDirs[0]})`) + token)
    } else {
      // **说"未知"而不是"没问题"**：取不到就说取不到，别给人一个假的安心
      console.log(chalk.gray(`  ○ 版本未知 — ${client.note}`))
    }
    for (const dead of client.unusableVersionDirs) {
      console.log(chalk.yellow(`  ! 残留版本目录 ${dead.dir}：只剩 ${dead.files} 个文件（没有 Weixin.dll）`))
      console.log(chalk.gray('    指向它的加载会失败；如果客户端起不来，先看这里'))
    }
    // `update.data` 在场时上面那个版本**未必**是加载的那个 —— 这句话要跟着它一起出现
    for (const caveat of client.caveats) {
      console.log(chalk.yellow(`  ⚠ ${caveat}`))
    }
    if (client.dataDirs.length) {
      console.log(chalk.gray(`  · 客户端自报数据目录: ${client.dataDirs.join('、')}`))
      if (dataDirMatchesConfig === false) {
        // 不一致 = 两边可能不是同一份库（本机数据目录还有 D 盘软链，这条已经按真身比过）
        console.log(chalk.yellow('    ⚠ 与配置里那个数据库推出来的根**不是同一份** —— 先确认你在读的是客户端正在写的那份'))
      }
    }
    const crashes = client.crashRecords.reports + client.crashRecords.records
    if (crashes > 0) {
      const when = client.crashRecords.newest ? client.crashRecords.newest.slice(0, 16).replace('T', ' ') : '时间读不到'
      console.log(chalk.gray(`  · 客户端崩溃记录 ${crashes} 份（最近 ${when}）—— 客户端崩过时数据读不出来，先看这条`))
    }

    // 7. Assistant (第二大脑)
    console.log(chalk.white('\n第二大脑 Agent:'))
    const aiKey = configService.get('deepseekApiKey')
    const aiBase = configService.get('aiBaseUrl')
    const engine = String(configService.get('aiEngine') || 'deepseek')
    if (['ollama', 'lmstudio'].includes(engine)) {
      console.log(chalk.green(`  AI 引擎: ${engine} (本地推理, 数据不出网)`))
    } else if (aiKey) {
      console.log(chalk.green(`  AI 引擎: ${aiBase ? `自定义端点 (${configService.get('aiModel') || 'deepseek-chat'})` : 'DeepSeek'}`))
    } else {
      console.log(chalk.gray('  AI 引擎: 未配置 (config set deepseekApiKey <key>)'))
    }
    const ocToken = configService.get('wechatOcToken')
    console.log(ocToken
      ? chalk.green('  消息通道: 已登录 (login-wechat)')
      : chalk.gray('  消息通道: 未登录 (weflow-cli login-wechat)'))
    try {
      const { isDaemonAlive } = await import('../../services/assistantDaemon.js')
      const { alive, pid } = isDaemonAlive()
      console.log(alive
        ? chalk.green(`  守护进程: 运行中 (pid ${pid})`)
        : chalk.gray('  守护进程: 未运行 (weflow-cli assistant start)'))
    } catch { /* daemon 模块不可用时跳过 */ }
    console.log()
  })
}
