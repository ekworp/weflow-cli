// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import { join } from 'path'
import { existsSync } from 'fs'
import { dbPathService } from '../../core/dbPathService.js'
import { keyService } from '../../core/keyService.js'
import { NtCore } from '../../core/ntCore.js'
import { configService } from '../../services/configService.js'
import { chatService } from '../../services/chatService.js'
import { getPythonCommand } from '../../utils/python.js'
import { applyDerivedNtKeys, enableFavorites } from '../../services/initKeyService.js'
import { reportedDataDirs } from '../../services/wechatClient.js'
import { tryReadWeFlowKey } from '../context.js'

export function registerInit(program: Command): void {

// ==================== init ====================
program
  .command('init')
  .description('自动检测微信数据目录并提取解密密钥')
  .option('-p, --path <path>', '微信数据目录、账号目录或 db_storage 目录')
  .option('--search-drives', '跨本机磁盘按标准微信目录名搜索（耗时较长）')
  .option('--full-scan', '目录名被修改时，使用深度磁盘结构扫描（耗时较长）')
  .option('--refresh', '忽略已有配置并重新初始化')
  .option('--test-missing-keys', '仅在本次运行模拟密钥缺失，不修改已保存配置')
  .option('--dry-run', '仅预览，不连接数据库、扫描磁盘、捕获密钥或修改配置')
  .option('--json', '输出机器可读预览；实际初始化必须在交互终端执行')
  .action(async (opts) => {
    const preview = {
      success: true,
      dryRun: true,
      action: 'initialize',
      interactiveRequired: true,
      configured: configService.isConfigured(),
      refreshRequested: Boolean(opts.refresh),
      explicitPathProvided: Boolean(opts.path),
      driveSearchRequested: Boolean(opts.searchDrives),
      fullScanRequested: Boolean(opts.fullScan),
      missingKeyTestRequested: Boolean(opts.testMissingKeys),
      mayScanProcessMemory: true,
      mayWriteConfiguration: true,
    }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify(preview))
      else console.log(chalk.cyan('初始化预览：可能检查数据库、搜索数据目录、捕获密钥并更新本地配置。'))
      return
    }
    if (opts.json) {
      console.log(JSON.stringify({ ...preview, success: false, dryRun: false, code: 'INTERACTIVE_REQUIRED' }))
      process.exit(1)
    }
    console.log(chalk.cyan('🔧 WeFlow CLI 初始化\n'))

    if (opts.testMissingKeys) {
      configService.maskDatabaseKeysForTesting()
      console.log(chalk.yellow('测试模式：本次运行忽略已保存的数据库密钥。'))
      console.log(chalk.gray('测试失败不会清除磁盘上的现有密钥配置。\n'))
    }

    if (!opts.refresh && !opts.path && !opts.testMissingKeys && configService.isConfigured()) {
      const existingConnection = await chatService.connect()
      if (existingConnection.success) {
        console.log(chalk.green('✓ 已验证现有本地配置可用，跳过密钥捕获。'))
        console.log(chalk.gray('  可直接运行 weflow-cli sessions、messages 等命令。'))
        console.log(chalk.gray('  仅在微信迁移、切换账号或访问失败后运行 weflow-cli init --refresh。'))
        return
      }
      console.log(chalk.yellow('  已发现现有配置，但无法验证数据库访问；继续重新初始化。'))
    }

    // Step 0: 检测微信版本
    console.log(chalk.yellow('步骤 0/3: 检测微信版本...'))
    const version = await keyService.detectWeChatVersion()

    if (version) {
      console.log(chalk.green(`✓ 检测到微信 ${version} 版本`))
    } else {
      // 没有运行中的微信，尝试已安装的版本
      console.log(chalk.gray('  未检测到运行中的微信进程'))
      // 检查已有配置或数据目录
      const existingPath = configService.get('dbPath')
      if (existingPath && existsSync(existingPath)) {
        console.log(chalk.green(`  使用已配置的数据目录: ${existingPath}`))
      }
    }

    if (version === '3.x') {
      // ====== 3.x 初始化 ======
      console.log(chalk.yellow('\n步骤 1/3: 提取 3.x 数据库密钥...'))
      const result = await keyService.extract3xKey((msg) => {
        console.log(chalk.gray(`  ${msg}`))
      })

      if (!result.success || !result.key) {
        console.log(chalk.red(`\n✗ 密钥提取失败: ${result.error}`))
        console.log(chalk.gray('\n解决方案:'))
        console.log(chalk.gray('  1. 确保 WeChat 3.x (WeChat.exe) 已登录'))
        console.log(chalk.gray('  2. 确保 Python + pywxdump 已安装'))
        console.log(chalk.gray('  3. 或手动指定密钥: weflow-cli config set decryptKey3x <64位密钥>'))
        process.exit(1)
      }

      const msgDir = result.msgDir || ''
      const wxDir = result.wxDir || ''
      const wxid = result.wxid || ''

      configService.set('decryptKey3x', result.key)
      configService.set('dataVersion', '3.x')

      // 查找 MSG0.db
      const msg0Path = join(msgDir, 'Multi', 'MSG0.db')
      if (existsSync(msg0Path)) {
        configService.set('dbPath3x', msg0Path)
        console.log(chalk.green(`✓ 数据库: ${msg0Path}`))
      }

      if (wxid) configService.set('wxid', wxid)
      if (wxDir) configService.set('dbPath', wxDir)

      console.log(chalk.green('\n✓ 密钥获取成功!'))
      console.log(chalk.cyan('\n=============================='))
      console.log(chalk.cyan('初始化完成! (3.x 模式)'))
      console.log(chalk.cyan('=============================='))
      console.log(chalk.white(`数据目录: ${wxDir}`))
      console.log(chalk.white(`消息数据库: ${msg0Path}`))
      console.log(chalk.white(`账号: ${wxid}`))
      console.log(chalk.white('密钥: 已安全保存'))

    } else {
      // ====== 4.x 初始化 (原有逻辑) ======
      console.log(chalk.yellow('\n步骤 1/3: 检测微信数据目录...'))
      const configuredPath = opts.path || configService.get('dbPath')
      const configuredDataRoot = configuredPath
        ? dbPathService.resolveDataRoot(configuredPath)
        : null
      if (configuredPath && !configuredDataRoot) {
        console.log(chalk.yellow('  已检查指定路径，但未识别到有效的微信数据结构；继续自动搜索...'))
      }
      if (!configuredDataRoot) {
        console.log(chalk.gray('  正在自动检查常见的微信数据目录位置...'))
      }
      if (!configuredDataRoot && opts.searchDrives) {
        console.log(chalk.gray('  将跨本机磁盘按标准目录名搜索，过程可能需要较长时间...'))
      }
      if (!configuredDataRoot && opts.fullScan) {
        console.log(chalk.gray('  目录名未命中时将继续进行深度结构扫描，过程可能需要较长时间...'))
      }
      const detected = configuredDataRoot
        ? { success: true, path: configuredDataRoot, source: 'known' as const }
        : await dbPathService.autoDetect({
            searchDrives: opts.searchDrives, fullScan: opts.fullScan,
            // **先问客户端自己**（它命令行上带着 `--wechat-files-path`）：这是唯一"来自
            // 客户端自己"的来源，其余都是按目录名猜。取不到就是空数组，走老路。
            hintedRoots: await reportedDataDirs(),
          })
      if (!detected.success || !detected.path) {
        console.log(chalk.red('✗ 未检测到微信数据目录'))
        if (!opts.searchDrives && !opts.fullScan) {
          console.log(chalk.gray('  已完成常见位置搜索。'))
          console.log(chalk.cyan('  下一步: weflow-cli init --search-drives'))
          console.log(chalk.gray('  该模式会跨本机磁盘按 xwechat_files 或 WeChat Files 名称搜索。'))
        } else if (!opts.fullScan) {
          console.log(chalk.gray('  已完成标准目录名的跨盘搜索。'))
          console.log(chalk.cyan('  下一步: weflow-cli init --full-scan'))
          console.log(chalk.gray('  此模式会继续按目录结构扫描可访问磁盘，耗时较长。'))
        } else {
          console.log(chalk.gray('  已完成深度结构扫描，仍未找到可识别的数据目录。'))
          console.log(chalk.cyan('  请指定数据根、账号目录或 db_storage 目录:'))
          console.log(chalk.cyan('  weflow-cli init --path "D:\\微信数据目录"'))
        }
        process.exit(1)
      }
      // **说清是怎么找到的**：来源不同，可信度与后续排查都不同（"客户端自己说的"最硬）
      const howFound = detected.source === 'client' ? '（客户端自己报的）'
        : detected.source === 'scan' ? '（全盘扫描找到的）' : ''
      console.log(chalk.green(`✓ 检测到数据目录: ${detected.path}${howFound}`))
      configService.set('dbPath', detected.path)
      configService.set('dataVersion', '4.x')

      // Step 2: 扫描账号
      console.log(chalk.yellow('\n步骤 2/3: 扫描微信账号...'))
      const wxids = dbPathService.scanWxidCandidates(detected.path)
      if (wxids.length === 0) {
        console.log(chalk.red('✗ 未找到微信账号目录'))
        process.exit(1)
      }

      const selectedWxid = wxids[0]
      console.log(chalk.green(`✓ 找到 ${wxids.length} 个账号`))
      for (const w of wxids) {
        const marker = w === selectedWxid ? chalk.green(' → ') : '   '
        const nickname = w.nickname ? ` (${w.nickname})` : ''
        console.log(`${marker}${w.wxid}${nickname}`)
      }
      configService.set('wxid', selectedWxid.wxid)

      // Step 3: 提取密钥
      console.log(chalk.yellow('\n步骤 3/3: 提取数据库解密密钥...'))

      // **先看 Python 在不在**（Windows）：它决定"读库"这一整步能不能做。
      // 以前不看，于是 Python 不可用时还要先等 120 秒 hook 超时，然后把用户引向
      // "退出微信重试"——而真正的原因（商店占位程序 / 缺 sqlcipher3）一个字都没提。
      // 2026-10-19 用一台"PATH 里没有 python"的机器实测，2 分钟换来一条误导性建议。
      let pythonUsable = process.platform !== 'win32'
      if (process.platform === 'win32' && !opts.testMissingKeys) {
        try {
          const { execFileSync } = await import('node:child_process')
          execFileSync(getPythonCommand(), ['--version'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
          pythonUsable = true
        } catch {
          pythonUsable = false
          console.log(chalk.red('  ✗ 没有可用的 Python —— 读微信库这一步跑不起来'))
          console.log(chalk.gray('    NT 数据库扫描与密钥派生都靠它（需要 Python 3.10+ 且能 import sqlcipher3）。'))
          console.log(chalk.gray('    Windows 上最常见的原因是只装了应用商店的 python 占位程序：'))
          console.log(chalk.gray('    在终端里运行 `python --version`，能打出版本号才算装对。'))
          console.log(chalk.gray('    跑 `weflow-cli check --report` 可以看到完整判定（那段话可直接贴给 AI）。'))
        }
      }

      // 优先尝试从 WeFlow 配置读取
      console.log(chalk.gray('  尝试从 WeFlow 桌面版配置读取...'))
      let extractedKey = opts.testMissingKeys ? '' : tryReadWeFlowKey()
      let linuxNtKey = ''
      /** 密钥是本次从 hook 捕获的, 还是沿用已有的 - 摘要要说准, 不能一律报"获取成功" */
      let keyCaptured = false

      if (extractedKey) {
        console.log(chalk.green('  ✓ 从 WeFlow 配置读取到密钥'))
      } else if (process.platform === 'linux') {
        // Linux：/proc 内存扫描提取 NT 密钥（需 root 或 CAP_SYS_PTRACE）
        console.log(chalk.gray('  Linux 模式：扫描微信进程内存提取 NT 密钥...'))
        const ntScan = await NtCore.scan(detected.path)

        if (ntScan.success && ntScan.matched && ntScan.matched.length > 0) {
          console.log(chalk.green(`  ✓ 从内存中匹配到 ${ntScan.matched.length} 个数据库密钥`))
          const primaryDb = ntScan.matched.find((db: any) => db.name === 'message/message_0.db')
            || ntScan.matched.sort((a: any, b: any) => b.size - a.size)[0]
          configService.set('ntDbPath', primaryDb.path)
          configService.set('ntKey', primaryDb.key)
          configService.set('ntSalt', primaryDb.salt)
          console.log(chalk.green(`  ✓ 主数据库: ${primaryDb.name} (${(primaryDb.size / 1024 / 1024).toFixed(1)}MB)`))

          const contactDb = ntScan.matched.find((db: any) => db.name === 'contact/contact.db')
          if (contactDb) {
            configService.set('contactDbPath', contactDb.path)
            configService.set('contactKey', contactDb.key)
            configService.set('contactSalt', contactDb.salt)
            console.log(chalk.green(`  ✓ 联系人数据库: ${contactDb.name}`))
          }
          const snsDb = ntScan.matched.find((db: any) => db.name === 'sns/sns.db')
          if (snsDb) {
            configService.set('snsDbPath', snsDb.path)
            configService.set('snsKey', snsDb.key)
            configService.set('snsSalt', snsDb.salt)
            console.log(chalk.green(`  ✓ 朋友圈数据库: ${snsDb.name}`))
          }
          linuxNtKey = primaryDb.key
        } else {
          // 较新微信版本: /proc 内存扫描同样匹配不到 x'...' 文本, 从已配置 passphrase 派生
          const favPass = configService.get('favPassphrase') || ''
          const scanDbs = (ntScan as any).databases || []
          const wxidDbs = scanDbs.filter((d: any) => d.wxid === selectedWxid.wxid)
          const deriveDbs = wxidDbs.length > 0 ? wxidDbs : scanDbs
          let derivedOk = false
          if (favPass && deriveDbs.length > 0) {
            console.log(chalk.gray('  内存扫描未发现密钥文本 (较新微信密钥体系), 尝试从 passphrase 派生...'))
            derivedOk = await applyDerivedNtKeys(favPass, deriveDbs, (l) => console.log(l))
            if (derivedOk) linuxNtKey = configService.get('ntKey') || ''
          }
          if (!derivedOk) {
            const err = ntScan.error || '未匹配到数据库密钥'
            console.log(chalk.red(`  ✗ ${err}`))
            console.log(chalk.gray('\n  Linux 密钥提取方案：'))
            if (err.includes('PERMISSION_DENIED')) {
              console.log(chalk.gray('  1. 一次性授权（推荐）: sudo setcap cap_sys_ptrace=ep $(which python3)'))
              console.log(chalk.gray('  2. 或用 sudo 运行: sudo weflow-cli init'))
              console.log(chalk.gray('     （sudo 后需修复配置属主: sudo chown -R $(id -u):$(id -g) ~/.weflow-cli）'))
            } else {
              console.log(chalk.gray('  1. 确保微信已启动并完成登录（登录后才会在内存中缓存密钥）'))
              console.log(chalk.gray('  2. 确保以 root 或 CAP_SYS_PTRACE 运行（sudo setcap cap_sys_ptrace=ep $(which python3)）'))
              console.log(chalk.gray('  3. 较新微信版本需配置全库 passphrase: weflow-cli fav set-key --passphrase <64位hex>，再重新 init 自动派生'))
              console.log(chalk.gray('  4. 或用第三方工具提取密钥后手动配置 weflow-cli config set ntKey <密钥>'))
            }
            process.exit(1)
          }
        }
      } else if (!pythonUsable) {
        // Python 不可用时**不去等 hook**：就算 hook 抓到了密钥，Step 4 的扫描/派生照样跑不起来，
        // 而那 120 秒的等待只会把用户引向"退出微信重试"这种无效动作。
        const fallback = configService.get('favPassphrase') || configService.get('decryptKey') || ''
        if (fallback) {
          console.log(chalk.gray('  跳过 hook 等待：已配置的密钥会原样保留，但要先修好 Python 才读得动'))
          extractedKey = fallback
        } else {
          console.log(chalk.red('\n✗ 这台机器现在无法读取微信数据库（缺 Python），因此没有可用密钥'))
          console.log(chalk.gray('\n按顺序做：'))
          console.log(chalk.gray('  1) 装一个真正的 Python 3.10+，确认 `python --version` 能打出版本号'))
          console.log(chalk.gray('  2) `pip install sqlcipher3`'))
          console.log(chalk.gray('  3) 重新 `weflow-cli init`'))
          console.log(chalk.gray('  卡住时跑 `weflow-cli check --report`，那段文字可直接贴给 AI 或贴到 issue'))
          process.exit(1)
        }
      } else if (process.platform !== 'win32') {
        // macOS：自动提取不可用，引导手动提供密钥
        console.log(chalk.yellow('  ⚠ 当前平台无法自动提取密钥（自动提取支持 Windows/Linux）'))
        console.log(chalk.gray('\n  macOS 手动配置方式：'))
        console.log(chalk.gray('  1. 用第三方工具从运行中的微信进程提取密钥（如 wechat-dump-rs）'))
        console.log(chalk.gray('  2. 或从 Windows 机器上的 WeFlow 配置复制密钥'))
        console.log(chalk.gray('  3. 写入配置: weflow-cli config set decryptKey <64位密钥>'))
        console.log(chalk.gray('  4. 数据目录与账号已完成配置，设置密钥后即可使用 sessions/messages 等命令'))
        process.exit(1)
      } else {
        // hook 只在**登录那一瞬**触发。所以要不要等，取决于微信现在在不在跑：
        //   · 已在运行  → 用户早就登录了，hook 永远不会再触发，等满 2 分钟纯属浪费
        //                 （2026-10-19 用一个空配置实测：每次 init 都白等）
        //   · 没在运行  → 这正是 README「三分钟上手」第 2 步要求的姿势（关掉微信再 init，
        //                 然后按提示启动并登录）。人要打开客户端、等它起来、扫码/点确认，
        //                 30 秒根本不够，**必须留足**，否则按文档操作的人会被那句
        //                 "hook 没抓到" 误导。所以就按文档给满 120 秒。
        let keyResult: { success: boolean; key?: string; error?: string } = { success: false }
        if (version) {
          console.log(chalk.gray('  微信已在运行：hook 只在登录那一瞬触发，不再等待，直接尝试扫描/派生'))
        } else {
          console.log(chalk.cyan('\n  请现在启动微信并登录（登录那一瞬会自动抓取密钥）'))
          console.log(chalk.cyan('  最多等 2 分钟；不启动也没关系，之后会继续尝试 NT 扫描 / passphrase 派生\n'))
          keyResult = await keyService.waitForKey(120000, (msg) => {
            console.log(chalk.gray(`  ${msg}`))
          })
        }

        if (keyResult.success && keyResult.key) {
          extractedKey = keyResult.key
          keyCaptured = true
        } else {
          // hook 只在登录瞬间触发; 微信已登录时捕获不到 → 回退到已有密钥。
          // decryptKey 也必须算数: init 成功时写入的就是它, 而 favPassphrase
          // 仅在收藏库存在且验证通过时才会被设置。只看 favPassphrase 会让
          // `init --refresh` 在一把完全可用的密钥面前报「密钥提取失败」——
          // 而那正是 CLI 自己在微信迁移后建议用户执行的命令。
          const fallback = configService.get('favPassphrase') || configService.get('decryptKey') || ''
          if (fallback) {
            console.log(chalk.gray('  Hook 未捕获到密钥 (微信已登录时不再触发密钥函数)'))
            console.log(chalk.gray('  检测到已配置的密钥, 沿用它并重新验证各库...'))
            extractedKey = fallback
          } else {
            // **不退出**：hook 只在"登录那一瞬"触发，而一个正常用户装完工具时微信早就登录了，
            // 于是这条 120 秒的等待**必然**超时。以前这里 process.exit(1)，用户就被卡在
            // 「退出微信后重新运行 init」——而下一步（Step 4 的 NT 扫描 / 从 passphrase 派生）
            // 才是新版本真正能拿到密钥的地方，却永远不会被执行（2026-10-19 用空配置实测）。
            // 现在改成继续往下走：拿得到就成功，拿不到由结尾统一判"未完成"。
            console.log(chalk.yellow('\n  Hook 没抓到密钥（它只在登录那一瞬触发，已登录时不会再有）'))
            console.log(chalk.gray('  继续尝试 NT 扫描 / passphrase 派生 —— 这是新版本主要的取密钥方式...'))
          }
        }
      }

      if (extractedKey) {
        configService.set('decryptKey', extractedKey)
        if (keyCaptured) console.log(chalk.green('\n✓ 密钥获取成功!'))
        else if (pythonUsable) console.log(chalk.green('\n✓ 已沿用配置中的密钥 (本次未重新捕获)'))
        // 缺 Python 时**不能说"已沿用"**：那句话在这里会被读成"密钥没问题"，
        // 而下面紧接着就会说"密钥未就绪"，两句自相矛盾（2026-10-19 实跑看到）。
        else console.log(chalk.yellow('\n· 配置里的密钥原样保留，但**这次验证不了**（缺 Python）——它可能仍然可用'))
      } else {
        // 空密钥时不能说"配置完成"：下一句就是"密钥未就绪"，两句打架。
        console.log(chalk.yellow('\n· 本次没有拿到密钥，继续尝试 NT 扫描 / passphrase 派生'))
      }

      // Step 4: 尝试扫描 NT 格式数据库 (xwechat_files)
      // 即使检测到传统路径，也可能存在 NT 格式数据库
      // 进入这里已经确认是 4.x 初始化流程。不要依赖步骤 0 的 version：
      // 微信可能是在 init 等待期间才启动，初始 version 会保持为 null。
      // Linux 分支已在步骤 3 完成配置，跳过。
      // 这次 init 到底有没有**取得可用的密钥** —— 只有它决定结尾能不能说"初始化完成"。
      // 扫描失败 + 沿用旧密钥 = 一次看着成功、实际什么也读不到的初始化：2026-10-18 一位用户
      // 的 init 打在 "NT scan failed (exit 9009)" 上（Python 是商店占位程序），结尾照样报
      // "初始化完成！"、"密钥: 已安全保存"，然后 sessions 一条都没有。
      let ntReady = process.platform === 'linux'   // Linux 分支已在步骤 3 配好
      if (process.platform !== 'linux') {
        console.log(chalk.yellow('\n步骤 4/4: 扫描 NT 格式数据库...'))
        console.log(chalk.gray('  正在从微信内存中匹配数据库密钥...'))

        const ntScanRoot = configService.get('dbPath') || detected.path
        const ntResult = await NtCore.scan(ntScanRoot)
        if (ntResult.success && ntResult.matched && ntResult.matched.length > 0) {
          console.log(chalk.green(`  ✓ 找到 ${ntResult.matched.length} 个 NT 数据库`))

          // 优先选择 message_0.db (主聊天数据库)
          let primaryDb = ntResult.matched.find((db: any) => db.name === 'message/message_0.db')
          if (!primaryDb) {
            // 按大小降序排序，选择最大的数据库
            primaryDb = ntResult.matched.sort((a: any, b: any) => b.size - a.size)[0]
          }

          if (primaryDb) {
            ntReady = true
            configService.set('ntDbPath', primaryDb.path)
            configService.set('ntKey', primaryDb.key)
            configService.set('ntSalt', primaryDb.salt)
            console.log(chalk.green(`  ✓ 主数据库: ${primaryDb.name} (${(primaryDb.size / 1024 / 1024).toFixed(1)}MB)`))

            // 检查 contact.db 是否已匹配
            const contactDb = ntResult.matched.find((db: any) => db.name === 'contact/contact.db')
            if (contactDb) {
              configService.set('contactDbPath', contactDb.path)
              configService.set('contactKey', contactDb.key)
              configService.set('contactSalt', contactDb.salt)
              console.log(chalk.green(`  ✓ 联系人数据库: ${contactDb.name} (${(contactDb.size / 1024 / 1024).toFixed(1)}MB)`))
            }

            // 检查 sns.db (朋友圈) 是否已匹配
            const snsDb = ntResult.matched.find((db: any) => db.name === 'sns/sns.db')
            if (snsDb) {
              configService.set('snsDbPath', snsDb.path)
              configService.set('snsKey', snsDb.key)
              configService.set('snsSalt', snsDb.salt)
              console.log(chalk.green(`  ✓ 朋友圈数据库: ${snsDb.name} (${(snsDb.size / 1024 / 1024).toFixed(1)}MB)`))
            }

            // 显示所有匹配的数据库
            for (const db of ntResult.matched) {
              const marker = db === primaryDb || db === contactDb || db === snsDb ? chalk.green('  → ') : '     '
              console.log(chalk.gray(`${marker}${db.name} (${(db.size / 1024 / 1024).toFixed(1)}MB)`))
            }
          }

          // 收藏库与聊天库共用 passphrase, 顺手启用收藏功能
          const passForFav = extractedKey || configService.get('decryptKey') || ''
          if (passForFav) await enableFavorites(passForFav, ntResult.databases || [])
        } else {
          console.log(chalk.gray(`  NT 数据库扫描: ${ntResult.error || '未找到匹配的数据库'}`))

          // 较新微信版本: 内存中不再有 x'<key><salt>' 文本, 内存扫描匹配不到密钥,
          // 从 DLL hook 拿到的全库 passphrase 派生各库密钥并逐一验证
          const passphrase = extractedKey || configService.get('decryptKey') || ''
          const allDbs = ntResult.databases || []
          const wxidDbs = allDbs.filter((db: any) => db.wxid === selectedWxid.wxid)
          const deriveDbs = wxidDbs.length > 0 ? wxidDbs : allDbs
          let derivedMessage = false
          if (passphrase && deriveDbs.length > 0) {
            console.log(chalk.gray('  检测到较新微信密钥体系 (内存中无密钥文本), 从 passphrase 派生各库密钥...'))
            derivedMessage = await applyDerivedNtKeys(passphrase, deriveDbs, (l) => console.log(l))
          }

          if (derivedMessage) {
            ntReady = true
            console.log(chalk.green('  ✓ 派生模式初始化成功 (聊天/联系人/朋友圈库已配置)'))
          } else {
            // 即使密钥未匹配，仍尝试自动发现 sns.db 路径和盐值
            if (ntResult.databases && ntResult.databases.length > 0) {
              const snsDb = ntResult.databases.find((db: any) => db.name === 'sns/sns.db')
              if (snsDb) {
                configService.set('snsDbPath', snsDb.path)
                configService.set('snsSalt', snsDb.salt)
                console.log(chalk.yellow(`  ⚠ 发现朋友圈数据库: ${snsDb.name} (${(snsDb.size / 1024 / 1024).toFixed(1)}MB)`))
                console.log(chalk.gray('    密钥未匹配，请运行: weflow-cli sns capture-key'))
              }
            }
            console.log(chalk.gray('  提示: 可以稍后运行 weflow-cli init 重新扫描'))
          }
        }
      }

      console.log(chalk.cyan('\n=============================='))
      // 只有**这次真的拿到可用密钥**才叫"完成"。否则说清楚"没就绪"以及下一步做什么 ——
      // 报"完成"再让 sessions 空着，是最费用户时间的失败方式（他会以为是自己微信的问题）。
      console.log(chalk[ntReady ? 'cyan' : 'yellow'](
        ntReady ? '初始化完成! (4.x 模式)' : '初始化未完成：数据库密钥没有就绪'))
      console.log(chalk.cyan('=============================='))
      console.log(chalk.white(`数据目录: ${detected.path}`))
      console.log(chalk.white(`账号: ${selectedWxid.wxid}${selectedWxid.nickname ? ` (${selectedWxid.nickname})` : ''}`))
      console.log(chalk.white(`密钥: ${ntReady ? '已安全保存' : '未就绪（配置里的旧密钥未必能解开这个库）'}`))
      const ntDbPath = configService.get('ntDbPath')
      if (ntDbPath) {
        console.log(chalk.white(`NT 数据库: ${ntDbPath}`))
      }
      if (!ntReady) {
        console.log(chalk.yellow('\n现在 sessions / messages 会读不到数据。按顺序做这三步：'))
        console.log(chalk.yellow('  1) 在这个终端里运行 `python --version`，要能打出版本号'))
        console.log(chalk.yellow('     （Windows 上最常见的问题是只装了商店的 python 占位程序）'))
        console.log(chalk.yellow('  2) `pip install sqlcipher3`'))
        console.log(chalk.yellow('  3) `weflow-cli config forget-keys`，然后重新 `weflow-cli init`'))
        // 这三步是"最常见的原因"，不是诊断结论。真卡住时让用户拿到一份**已经判定过**的事实，
        // 而不是再让他把现象口头描述一遍（那正是 issue #3/#9/#10 每次都要重来一遍的原因）。
        console.log(chalk.yellow('\n想先看清到底卡在哪一步，运行：'))
        console.log(chalk.cyan('  weflow-cli check --report'))
        console.log(chalk.gray('  它会给出结论（Python / sqlcipher3 / 密钥 / 数据目录），那段文字可以直接复制给 AI 或贴到 issue。'))
      }

      // 未就绪时说"现在可以使用"是骗人的：那几条命令都会返回空。
      console.log(chalk.gray(ntReady
        ? '\n现在可以使用以下命令:'
        : '\n修好上面那几步之后，这些命令才会返回数据:'))
      console.log(chalk.gray('  weflow-cli sessions        查看会话列表'))
      console.log(chalk.gray('  weflow-cli messages <talker> 查看消息'))
      console.log(chalk.gray('  weflow-cli contacts        查看联系人'))
      console.log(chalk.gray('  weflow-cli export <talker> <format> 导出聊天记录'))
    }
  })
}
