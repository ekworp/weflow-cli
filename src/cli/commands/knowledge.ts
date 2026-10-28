// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { join } from 'path'
import { existsSync, writeFileSync } from 'fs'
import { configService } from '../../services/configService.js'
import { getPythonCommand } from '../../utils/python.js'
import { safeSubprocessError } from '../../utils/pythonProcessEnv.js'
import { DateRangeError, parseLocalDateOrIso } from '../../utils/dateRange.js'
import { resolvePackageRoot, pythonProcessEnv, parseCliInteger, requireCliChoice, requireCliDate, runConfirmedPythonMutation, runPythonCmd } from '../context.js'

export function registerKnowledge(program: Command): void {

  // vault init
  program
    .command('vault')
    .description('Obsidian Vault 管理')
    .addCommand(
      new Command('init')
        .description('初始化 Obsidian Vault 目录结构')
        .option('-p, --path <dir>', 'Vault 路径', './output/wechat-vault')
        .option('--dry-run', '仅预览将创建或覆盖的项目，不修改文件')
        .option('--yes', '确认创建目录并写入模板文件')
        .option('--json', '输出 JSON 格式，不返回本地路径或文件名')
        .action(async (opts) => {
          const { mkdirSync, writeFileSync } = await import('fs')
          const { join } = await import('path')

          const vaultPath = opts.path
          const dirs = [
            '.obsidian',
            'Templates',
            'Sources/WeChat',
            '000_Inbox',
            '001_Daily',
            '002_Literature/WeChat',
            '002_Literature/WeRead',
            '003_Ideas',
            '004_Permanent',
            '005_Reference/Tools',
            '005_Reference/Methods',
            '006_Projects',
            // 这里原先还有 `007_Wiki/Concepts`：概念页实际写在下面的顶层 `Wiki/Concepts`
            // （`compile_wiki` 的 OUTPUT_ROOT）。两个都列，就建出一个永远空着的目录。
            '008_MOC',
            '999_Archive',
            '_attachments',
            // `Wiki/Concepts` 是唯一真的有人写的 Wiki 子目录（`compile_wiki` 的
            // OUTPUT_ROOT）。这里曾经还列着 `Wiki/Entities` 与 `Wiki/Topics`——没有任何
            // 代码写它们，README 里那张表却把它们当成已有的介绍给用户。**声明了就要有东西
            // 往里写**，否则就是又一个"永远空着的目录"（同 `007_Wiki`）。
            // 两个知识库各一个目录：`Wiki/Concepts` 是公众号文章线的，`Chat/Concepts` 是聊天线的
            'Wiki/Concepts',
            'Chat/Concepts',
          ]
          const files = [
            {
              relativePath: join('.obsidian', 'app.json'),
              content: JSON.stringify({
                newFileLocation: 'folder',
                newFileFolderPath: 'Sources',
                // **`_attachments`，不是 `Assets`**：布局里建的就是 `_attachments`（这个
                // 字面量以前只在这里出现一次，是个孤例），而 init 从不建 `Assets`——
                // 于是附件会被 Obsidian 放进一个不存在的目录。
                attachmentFolderPath: '_attachments',
                showInlineTitle: false,
              }, null, 2),
            },
            {
              relativePath: join('Templates', 'article.md'),
              content: [
                '---',
                'title: "{{title}}"',
                'source: ""',
                'date: {{date}}',
                'topic: AI',
                'tags: []',
                'created: {{date}}',
                '---',
                '',
                '# {{title}}',
                '',
                '> 来源：  ',
                '> 时间：{{date}}  ',
                '',
                '---',
                '',
                '## AI 摘要',
                '',
                '',
                '## 相关概念',
                '',
                '',
                '---',
                '',
                '## 正文',
                '',
              ].join('\n'),
            },
            {
              relativePath: 'README.md',
              content: [
                '# WeChat Knowledge Vault',
                '',
                '> 由 weflow-cli 自动生成，兼容 Obsidian。',
                '',
                '## 目录结构',
                '',
                '| 目录 | 说明 |',
                '|------|------|',
                '| `Sources/WeChat/<日期>/` | 原始文章（`daily` 与回填写入，连同正文图片） |',
                '| `001_Daily/<日期>.md` | 每天一页日记 |',
                '| `002_Literature/WeChat/<日期>/` | 阅读笔记（由 `Sources` 生成） |',
                // **两个知识库各写一行**：文章线（`Wiki/`）与聊天线（`Chat/`）是分开的两套，
                // 只列文章那套的话，用户在库里看到的说明与他实际拥有的东西对不上。
                '| `Wiki/Concepts/`、`Wiki/00-Overview.md` | **文章知识库**的概念页与索引（`wiki compile` 生成） |',
                '| `Chat/Concepts/`、`Chat/00-Overview.md` | **聊天知识库**的概念页与索引（`wiki compile --source output/chat-notes` 生成） |',
                '| `Sources/Chat/会话-<名字>.md` | 每个会话一张知识卡（`chat` 生成：聊了什么、有哪些人、欠着什么） |',
                '| `Templates/` | 模板文件 |',
                '| `_attachments/` | Obsidian 附件（`.obsidian/app.json` 的 `attachmentFolderPath` 指向这里） |',
                '| `000_Inbox` `003_Ideas` `004_Permanent` `005_Reference` `006_Projects` `008_MOC` `999_Archive` | **给你自己写笔记用的层**：`vault promote` 才会往里放东西，空着是设计而不是没做完 |',
                '',
                '> 阅读笔记与日记里各有一段 `dataview` 查询，所以这个 Vault 需要 **Dataview 社区插件**',
                '> （社区插件不进仓库，换机器要自己装一次）。',
                '',
                '## 快速查询',
                '',
                '使用 Obsidian Dataview 插件：',
                '',
                '```dataview',
                'TABLE date, topic, tags',
                'FROM "Sources/WeChat"',
                'WHERE topic = "AI"',
                'SORT date DESC',
                '```',
                '',
                '```dataview',
                'TABLE length(rows) as "篇数"',
                'FROM "Sources/WeChat"',
                'GROUP BY topic',
                'SORT rows.length DESC',
                '```',
                '',
                '## 每日更新',
                '',
                '```bash',
                '# 生成今日日报',
                'python scripts/biz_daily.py --api-key <key>',
                '',
                '# 后处理（广告清洗+深度摘要）',
                'python scripts/classify_daily.py --api-key <key> --interest AI',
                '',
                '# 同步到 GitHub',
                '# (见 OPERATIONS.md)',
                '```',
                '',
                '---',
                '',
                '*由 weflow-cli vault init 生成*',
              ].join('\n'),
            },
            {
              relativePath: '.gitignore',
              content: [
                '.obsidian/workspace*.json',
                '.obsidian/hotkeys.json',
                '.trash/',
                '.DS_Store',
              ].join('\n'),
            },
          ]
          const directoryCreateCount = dirs.filter(dir => !existsSync(join(vaultPath, dir))).length
          const fileCreateCount = files.filter(file => !existsSync(join(vaultPath, file.relativePath))).length
          const overwriteCount = files.length - fileCreateCount
          const preview = {
            success: true,
            dryRun: true,
            action: 'vault.init',
            directoryCreateCount,
            fileCreateCount,
            overwriteCount,
          }

          if (opts.dryRun) {
            if (opts.json) console.log(JSON.stringify(preview))
            else {
              console.log(chalk.cyan(`Vault 初始化预览：新建 ${directoryCreateCount} 个目录、${fileCreateCount} 个文件，覆盖 ${overwriteCount} 个文件`))
            }
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
              message: `确认初始化 Vault？将新建 ${directoryCreateCount} 个目录、${fileCreateCount} 个文件，并覆盖 ${overwriteCount} 个已有文件。`,
              default: false,
            }])
            if (!confirmed) {
              console.log(chalk.gray('已取消'))
              return
            }
          }

          if (!opts.json) console.log(chalk.cyan(`\n🔧 初始化 Obsidian Vault: ${vaultPath}\n`))
          for (const dir of dirs) {
            mkdirSync(join(vaultPath, dir), { recursive: true })
            if (!opts.json) console.log(`  ✓ ${dir}/`)
          }
          for (const file of files) {
            writeFileSync(join(vaultPath, file.relativePath), file.content, 'utf8')
          }

          if (opts.json) {
            console.log(JSON.stringify({
              success: true,
              action: 'vault.init',
              directoryCreateCount,
              fileCreateCount,
              overwriteCount,
            }))
          } else {
            console.log(chalk.green(`\n✓ Vault 创建完成!`))
            console.log(`  用 Obsidian 打开: File → Open Vault → ${vaultPath}`)
          }
        })
    )

  // wiki compile
  program
    .command('wiki')
    .description('概念图谱管理')
    .addCommand(
      new Command('compile')
        .description('扫描文章 [[Wikilinks]] 聚合生成概念页')
        .option('-l, --limit <n>', '最多生成概念数', '20')
        .option('--min-refs <n>', '至少被几篇材料提到才建页（2 能滤掉新闻里的一次性实体）', '1')
        .option('--source <dir>', '材料目录（**必须含 [[概念]] — 说明 形状的链接**，否则聚合不出任何概念）', './output/biz-daily')
        .option('-o, --output <dir>', '概念页输出目录', './output/wechat-vault/Wiki/Concepts')
        .option('--api-key <key>', 'DeepSeek API key')
        .option('--refresh-sources',
                '只把已有概念页的"来源"段补齐成当前全部来源（本地重写，**不调用模型**）')
        .option('--qualify-links',
                '把跨线同名的概念链接改成带路径的形式（本地重写，**不调用模型**）')
        .option('--cards <dir...>', '产卡目录，可写多个；默认所有 output/*-notes（与索引的引用数同一口径）')
        .option('--dry-run', '仅预览，不读取文章、调用 AI 或写入概念页')
        .option('--yes', '确认调用 AI 并生成概念页')
        .option('--json', '输出机器可读结果，不返回概念或本地路径')
        .action(async (opts) => {
          const pkgRoot = resolvePackageRoot()
          const script = join(pkgRoot, 'scripts', 'compile_wiki.py')

          if (opts.refreshSources) {
            // 本地补来源：**不调模型**，所以不传 apiKey、preview 里也不说"调用 AI"。
            // 但它会把已有页重写一遍（实测会动 358 张），照样走"先预览、再确认"那两步。
            await runConfirmedPythonMutation({
              action: 'wiki.refreshSources',
              script,
              args: ['--refresh-sources', '--output', opts.output,
                     ...(opts.cards ?? []).flatMap((c: string) => ['--cards', c])],
              cliOptions: opts,
              preview: { readsLocalCards: true, rewritesExistingPages: true, usesAi: false },
              confirmationMessage: `确认把 ${opts.output} 里已有概念页的"来源"段补齐？（本地重写，不调用 AI）`,
              apiKey: opts.apiKey,
              timeout: 300_000,
            })
            return
          }

          if (opts.qualifyLinks) {
            // 本地消歧：两条线同名的那些链接按名字带路径（`Chat/Concepts/DeepSeek|DeepSeek`），
            // 免得 Obsidian 里那条裸链接命中另一条线的那张。**不调模型**，重跑幂等。
            await runConfirmedPythonMutation({
              action: 'wiki.qualifyLinks',
              script,
              args: ['--qualify-links', '--output', opts.output],
              cliOptions: opts,
              preview: { readsLocalKnowledge: true, rewritesExistingPages: true, usesAi: false },
              confirmationMessage: `确认把 ${opts.output} 里跨线同名的概念链接改成带路径的形式？`
                + '（本地重写，不调用 AI）',
              apiKey: opts.apiKey,
              timeout: 300_000,
            })
            return
          }
          const limit = parseCliInteger(opts.limit, 'limit', 1, 1000, opts.json)
          const minRefs = parseCliInteger(opts.minRefs ?? '1', 'min-refs', 1, 50, opts.json)
          await runConfirmedPythonMutation({
            action: 'wiki.compile',
            script,
            args: ['--limit', String(limit), '--source', opts.source, '--output', opts.output,
                   '--min-refs', String(minRefs)],
            cliOptions: opts,
            preview: { limit, minRefs, readsLocalArticles: true, usesAi: true, writesConceptPages: true },
            confirmationMessage: `确认调用 AI 并生成最多 ${limit} 个概念页？`,
            apiKey: opts.apiKey,
            timeout: 300_000,
          })
        })
    )

  // pipeline run
  program
    .command('pipeline')
    .description('端到端自动化流水线')
    .addCommand(
      new Command('run')
        .description('一键运行 biz_daily → classify → wiki compile')
        .option('--date <YYYY-MM-DD>', '日期')
        .option('--api-key <key>', 'DeepSeek API key')
        .option('--engine <name>', 'AI 引擎: deepseek / claude / ollama / local', 'deepseek')
        .option('--interest <topic>', '兴趣主题', 'AI')
        .option('--wiki-limit <n>', '概念编译数', '20')
        .option('--source <name>', '仅处理指定公众号，可重复使用', (value: string, previous: string[]) => [...previous, value], [] as string[])
        .option('--skip-classify', '跳过 AI 后处理')
        // 这两个**默认不做**：Obsidian 自带的图谱视图是实时的，写一次 vault 图谱就重画一次。
        .option('--with-wiki', '把概念页写进 Obsidian Vault（默认不写：图谱只在你说了才变）')
        .option('--with-vault', '把当天内容副本同步进 Obsidian Vault（默认不写）')
        .option('--skip-html', '跳过 HTML 阅读器生成')
        .option('--skip-ai-report', '跳过 AI 深度阅读报告')
        .option('--no-ai', '关闭全部 AI 调用，保留抓取和本地输出')
  .option('--no-summary', '只判断不生成：biz_daily 不调 LLM 写摘要/标签/简报（判断仍走 Jev）')
        .option('--ai-report-range <n>', 'AI 报告覆盖最近 N 天', '1')
        .option('--dry-run', '仅预览步骤，不读取聊天数据、调用网络或写入文件')
        .option('--yes', '确认运行流水线')
        .option('--json', '输出机器可读结果，不返回本地路径')
        .action(async (opts) => {
          const allowedEngines = new Set(['deepseek', 'claude', 'ollama', 'local'])
          if (!allowedEngines.has(opts.engine)) {
            if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', field: 'engine' }))
            else console.log(chalk.red('engine 必须是 deepseek、claude、ollama 或 local'))
            process.exit(1)
          }
          if (opts.date) {
            try {
              parseLocalDateOrIso(opts.date)
              if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new DateRangeError('INVALID_DATE', '日期无效')
            } catch {
              if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_DATE', field: 'date' }))
              else console.log(chalk.red('date 必须是有效的 YYYY-MM-DD 日期'))
              process.exit(1)
            }
          }
          const wikiLimit = parseCliInteger(opts.wikiLimit, 'wiki-limit', 1, 1000, opts.json)
          const aiReportRange = parseCliInteger(opts.aiReportRange, 'ai-report-range', 1, 365, opts.json)
          const sources = opts.source as string[]
          const noAi = opts.ai === false
          const preview = {
            success: true,
            dryRun: true,
            action: 'pipeline.run',
            dateSpecified: !!opts.date,
            sourceCount: sources.length,
            engine: opts.engine,
            aiEnabled: !noAi,
            cloudAiEnabled: !noAi && ['deepseek', 'claude'].includes(opts.engine),
            vaultSyncEnabled: !opts.skipVault,
            htmlEnabled: !opts.skipHtml,
            wikiEnabled: !opts.skipWiki && !noAi,
            classifyEnabled: !opts.skipClassify && !noAi,
            aiReportEnabled: !opts.skipAiReport && !noAi,
          }
          if (opts.dryRun) {
            if (opts.json) console.log(JSON.stringify(preview))
            else console.log(chalk.cyan(`流水线预览：${sources.length || '全部'} 个指定来源，AI ${noAi ? '关闭' : '开启'}，Vault 同步 ${opts.skipVault ? '关闭' : '开启'}`))
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
              message: `确认运行流水线？将抓取内容并写入本地输出${opts.skipVault ? '' : '，同时替换当天 Vault 副本'}。`,
              default: false,
            }])
            if (!confirmed) {
              console.log(chalk.gray('已取消'))
              return
            }
          }
          const { execFile } = await import('child_process')
          const { promisify } = await import('util')
          const execFileAsync = promisify(execFile)
          const pkgRoot = resolvePackageRoot()
          const script = join(pkgRoot, 'scripts', 'pipeline.py')

          const args: string[] = [
            script,
            '--engine', opts.engine,
            '--interest', opts.interest,
            '--wiki-limit', String(wikiLimit),
            '--ai-report-range', String(aiReportRange),
          ]
          if (opts.date) args.push('--date', opts.date)
          for (const source of sources) args.push('--source', source)
          if (opts.skipClassify) args.push('--skip-classify')
          if (opts.withWiki) args.push('--with-wiki')
          if (opts.withVault) args.push('--with-vault')
          if (opts.skipHtml) args.push('--skip-html')
          if (opts.skipAiReport) args.push('--skip-ai-report')
          if (noAi) args.push('--no-ai')
          if (opts.noSummary && !noAi) args.push('--no-summary')

          try {
            if (!opts.json) console.log(chalk.cyan('\n启动端到端流水线...\n'))
            const { stdout } = await execFileAsync(getPythonCommand(), args, {
              timeout: 600_000,
              maxBuffer: 50 * 1024 * 1024,
              env: pythonProcessEnv(opts.apiKey),
            })
            if (opts.json) console.log(JSON.stringify({ success: true, action: 'pipeline.run' }))
            else console.log(stdout)
          } catch (e: any) {
            if (opts.json) console.log(JSON.stringify({ success: false, code: 'PIPELINE_FAILED', error: safeSubprocessError(e, '流水线失败') }))
            else console.error(chalk.red(`\n✗ ${safeSubprocessError(e, '流水线失败')}`))
            process.exit(1)
          }
        })
    )

  // vault sync — add to existing vault command
  program.commands
    .find(c => c.name() === 'vault')
    ?.addCommand(
      new Command('sync')
        .description('增量提交 Vault 并推送到远端仓库')
        .option('-r, --repo <url>', '远端 Git 仓库地址')
        .option('-b, --branch <name>', '分支名', 'main')
        .option('--dry-run', '仅预览变更数量，不提交或推送')
        .option('--yes', '确认提交并推送')
        .option('--json', '输出 JSON 格式，不返回远端地址或文件名')
        .action(async (opts) => {
          const { execFile } = await import('child_process')
          const { promisify } = await import('util')
          const execFileAsync = promisify(execFile)
          const vaultPath = join(process.cwd(), 'output', 'wechat-vault')

          const repo = opts.repo || configService.get('vaultRepo')
          if (!repo) {
            if (opts.json) {
              console.log(JSON.stringify({ success: false, code: 'VAULT_REMOTE_REQUIRED' }))
              process.exit(1)
            }
            console.error(chalk.red('\n❌ 未指定远端仓库。运行: weflow-cli config set vaultRepo <url> 或使用 --repo 参数\n'))
            process.exit(1)
          }

          try {
            const gitDir = join(vaultPath, '.git')
            const { existsSync, readdirSync } = await import('fs')
            if (!existsSync(vaultPath)) {
              if (opts.json) console.log(JSON.stringify({ success: false, code: 'VAULT_NOT_FOUND' }))
              else console.error(chalk.red('Vault 不存在，请先运行 weflow-cli vault init'))
              process.exit(1)
            }

            const initialized = existsSync(gitDir)
            const countFiles = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
              if (entry.name === '.git') return total
              return total + (entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1)
            }, 0)
            const status = initialized
              ? (await execFileAsync('git', ['status', '--porcelain'], { cwd: vaultPath })).stdout
              : ''
            const changeCount = initialized
              ? status.split(/\r?\n/).filter(Boolean).length
              : countFiles(vaultPath)
            const preview = {
              success: true,
              dryRun: true,
              action: 'vault.sync',
              branch: opts.branch,
              initialized,
              changeCount,
            }

            if (opts.dryRun) {
              if (opts.json) console.log(JSON.stringify(preview))
              else console.log(chalk.cyan(`Vault 同步预览：${changeCount} 个文件状态将被处理`))
              return
            }
            if (changeCount === 0) {
              if (opts.json) console.log(JSON.stringify({ success: true, action: 'vault.sync', changed: false, pushed: false }))
              else console.log(chalk.yellow('没有变更，跳过同步'))
              return
            }
            if (!opts.yes) {
              if (opts.json) {
                console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', action: 'vault.sync', changeCount }))
                process.exit(1)
              }
              const { confirmed } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirmed',
                message: `确认提交并推送 Vault 的 ${changeCount} 个文件状态？`,
                default: false,
              }])
              if (!confirmed) {
                console.log(chalk.gray('已取消'))
                return
              }
            }

            if (!existsSync(gitDir)) {
              if (!opts.json) console.log(chalk.cyan('初始化 Vault Git 仓库...'))
              await execFileAsync('git', ['init'], { cwd: vaultPath })
              await execFileAsync('git', ['remote', 'add', 'origin', repo], { cwd: vaultPath })
            } else {
              try {
                await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: vaultPath })
              } catch {
                await execFileAsync('git', ['remote', 'add', 'origin', repo], { cwd: vaultPath })
              }
            }

            const dateStr = new Date().toISOString().slice(0, 10)
            await execFileAsync('git', ['add', '-A'], { cwd: vaultPath })
            const { stdout: statOut } = await execFileAsync('git', ['diff', '--cached', '--stat'], { cwd: vaultPath })
            if (!opts.json) console.log(chalk.cyan('提交变更...'))
            await execFileAsync('git', ['commit', '-m', `vault sync: ${dateStr} | ${statOut.split('\n').length} files`], { cwd: vaultPath })

            if (!opts.json) console.log(chalk.cyan('推送到远端...'))
            await execFileAsync('git', ['push', '-u', 'origin', opts.branch], { cwd: vaultPath, timeout: 60_000 })

            if (opts.json) console.log(JSON.stringify({ success: true, action: 'vault.sync', changed: true, pushed: true, branch: opts.branch, changeCount }))
            else console.log(chalk.green(`\n✓ Vault 已同步 (${opts.branch})`))
          } catch (e: any) {
            if (opts.json) console.log(JSON.stringify({ success: false, code: 'VAULT_SYNC_FAILED', error: safeSubprocessError(e, '同步失败') }))
            else console.error(chalk.red(`\n✗ ${safeSubprocessError(e, '同步失败')}`))
            process.exit(1)
          }
        })
    )

  // vault enrich — bidirectional backlinks
  program.commands
    .find(c => c.name() === 'vault')
    ?.addCommand(
      new Command('enrich')
        .description('增强双向链接 — 为文章添加相关阅读段落')
        .option('--date <YYYY-MM-DD>', '日期（默认今天）')
        .option('--source <dir>', '文章目录', './output/biz-daily')
        .option('--dry-run', '仅预览，不读取或修改文章')
        .option('--yes', '确认修改文章')
        .option('--json', '输出机器可读结果，不返回本地路径')
        .action(async (opts) => {
          const pkgRoot = resolvePackageRoot()
          const script = join(pkgRoot, 'scripts', 'enrich_backlinks.py')
          if (!opts.date) {
            const now = new Date()
            opts.date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
          }
          requireCliDate(opts.date, opts.json)
          await runConfirmedPythonMutation({
            action: 'vault.enrich',
            script,
            args: ['--date', opts.date, '--source', opts.source],
            cliOptions: opts,
            preview: { dateSpecified: true, modifiesArticles: true, usesAi: false },
            confirmationMessage: '确认向当日文章写入相关阅读链接？',
          })
        })
    )

  // vault notes — create reading notes
  program.commands
    .find(c => c.name() === 'vault')
    ?.addCommand(
      new Command('notes')
        .description('创建阅读笔记 — 为文章生成 Vault 笔记页')
        .option('--date <YYYY-MM-DD>', '日期（默认今天）')
        .option('--source <dir>', '文章目录', './output/biz-daily')
        .option('--vault <path>', 'Vault 路径', './output/wechat-vault')
        .option('--dry-run', '仅预览，不读取文章或写入笔记')
        .option('--yes', '确认生成阅读笔记')
        .option('--json', '输出机器可读结果，不返回本地路径')
        .action(async (opts) => {
          const pkgRoot = resolvePackageRoot()
          const script = join(pkgRoot, 'scripts', 'create_reading_notes.py')
          if (!opts.date) {
            const now = new Date()
            opts.date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
          }
          requireCliDate(opts.date, opts.json)
          await runConfirmedPythonMutation({
            action: 'vault.notes',
            script,
            args: ['--date', opts.date, '--source', opts.source, '--vault', opts.vault],
            cliOptions: opts,
            preview: { dateSpecified: true, createsNotes: true, usesAi: false },
            confirmationMessage: '确认从当日文章生成 Vault 阅读笔记？',
          })
        })
    )

  // vault tag — auto tag
  program.commands
    .find(c => c.name() === 'vault')
    ?.addCommand(
      new Command('tag')
        .description('自动标签 — AI 为文章补充标签')
        .option('--date <YYYY-MM-DD>', '日期（默认今天）')
        .option('--source <dir>', '文章目录', './output/biz-daily')
        .option('--force', '覆盖已有标签')
        .option('--api-key <key>', 'DeepSeek API key')
        .option('--dry-run', '仅预览，不读取文章、调用 AI 或修改标签')
        .option('--yes', '确认调用 AI 并修改文章标签')
        .option('--json', '输出机器可读结果，不返回本地路径或文章名')
        .action(async (opts) => {
          const pkgRoot = resolvePackageRoot()
          const script = join(pkgRoot, 'scripts', 'auto_tag.py')
          if (!opts.date) { const n=new Date(); opts.date=`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}` }
          requireCliDate(opts.date, opts.json)
          await runConfirmedPythonMutation({
            action: 'vault.tag',
            script,
            args: ['--date', opts.date, '--source', opts.source, ...(opts.force ? ['--force'] : [])],
            cliOptions: opts,
            preview: { dateSpecified: true, force: !!opts.force, modifiesArticles: true, usesAi: true },
            confirmationMessage: `确认调用 AI 为当日文章生成标签${opts.force ? '并覆盖已有标签' : ''}？`,
            apiKey: opts.apiKey,
          })
        })
    )

  // vault search — search across Vault
  program.commands
    .find(c => c.name() === 'vault')
    ?.addCommand(
      new Command('search')
        .description('Vault 搜索 — 文章+概念+笔记')
        .argument('<query>', '搜索关键词')
        .option('--type <type>', 'all / article / concept / note', 'all')
        .option('--line <line>', 'wiki=文章线(默认) / chat=聊天线 / all=两条都搜', 'wiki')
        .option('--top-k <n>', '返回数量', '10')
        // `vault_search.py` 一直有 `--days`（它的 docstring 自己就举 `--days 30`），CLI 从来没接 ——
        // 于是"只搜最近一周"这件事在这条路上做不到，窗口被脚本默认值（90）钉死。与 `search-index --days`
        // 同形：窗口的运行值由 CLI 说了算，默认值与脚本一致。
        .option('--days <n>', '日报文章取最近多少天（默认 90）', '90')
        // 这条 `--json` 曾经**不存在，而 JSON 又是唯一的输出**：参数里硬编码着 `'--json'`，
        // 人类模式虽然脚本里写着（`vault_search.py` 不带 `--json` 时打印带相关度的可读列表）
        // 却没有任何入口能到达，用户显式敲 `--json` 还会拿到 `unknown option` —— 与
        // `docs/EXTENDING.md` 那条"脚本或 AI 会驱动的命令都有 `--json` 模式"正相反。
        // 现在按兄弟命令（`vault rag`、顶层 `search`）的形状来：默认人类可读，`--json` 才转发。
        .option('--json', '输出 JSON 格式（含本地路径与标题，供本机脚本/AI 使用）')
        .action(async (query, opts) => {
          const pkgRoot = resolvePackageRoot()
          const script = join(pkgRoot, 'scripts', 'vault_search.py')
          // 校验分支也要认 `--json`（`requireCliChoice` 里就带着这条约定）：
          // 否则 JSON 模式下 stdout 是一行彩色散文，脚本解析不了。
          requireCliChoice(opts.type, ['all', 'article', 'concept', 'note'], 'type', opts.json)
          requireCliChoice(opts.line, ['wiki', 'chat', 'all'], 'line', opts.json)
          const topK = parseCliInteger(opts.topK, 'top-k', 1, 100, opts.json)
          const days = parseCliInteger(opts.days, 'days', 1, 3650, opts.json)
          await runPythonCmd(script, [query, '--type', opts.type, '--line', opts.line,
                                      '--top-k', String(topK), '--days', String(days),
                                      ...(opts.json ? ['--json'] : [])])
        })
    )

  // vault rag — RAG dialog over Vault
  program.commands
    .find(c => c.name() === 'vault')
    ?.addCommand(
      new Command('rag')
        .description('Vault 问答 — 基于知识库的 AI 对话')
        .argument('<question>', '问题')
        .option('--top-k <n>', '检索条数', '8')
        .option('--line <line>', 'wiki=文章线(默认) / chat=聊天线 / all=两条都搜', 'wiki')
        .option('--api-key <key>', 'DeepSeek API key')
        .option('--dry-run', '仅预览，不读取知识库或调用 AI')
        .option('--yes', '确认读取本地知识并发送筛选后的上下文到 AI')
        .option('--json', '输出机器可读结果；执行仍需 --yes')
        .action(async (question, opts) => {
          const pkgRoot = resolvePackageRoot()
          const script = join(pkgRoot, 'scripts', 'vault_rag.py')
          const topK = parseCliInteger(opts.topK, 'top-k', 1, 100, opts.json)
          requireCliChoice(opts.line, ['wiki', 'chat', 'all'], 'line', opts.json)
          const preview = {
            success: true,
            dryRun: true,
            action: 'vault.rag',
            topK,
            line: opts.line,
            readsLocalKnowledge: true,
            usesAi: true,
            sendsSelectedContextToAi: true,
          }
          if (opts.dryRun) {
            if (opts.json) console.log(JSON.stringify(preview))
            else console.log(chalk.cyan('预览：将检索本地知识库，并把最多指定条数的相关上下文发送到已配置的 AI 服务。'))
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
              message: '确认读取本地知识库并将筛选后的上下文发送到 AI 服务吗？',
              default: false,
            }])
            if (!confirmed) {
              console.log(chalk.gray('已取消'))
              return
            }
          }
          const args = ['--top-k', String(topK), '--line', opts.line]
          if (opts.json) args.push('--json')
          const { execFile } = await import('child_process')
          const { promisify } = await import('util')
          try {
            const { stdout } = await promisify(execFile)(getPythonCommand(), [script, ...args], {
              timeout: 120_000,
              maxBuffer: 5 * 1024 * 1024,
              env: {
                ...pythonProcessEnv(opts.apiKey),
                WEFLOW_VAULT_QUESTION: question,
              },
            })
            console.log(stdout)
          } catch (error) {
            if (opts.json) console.log(JSON.stringify({ success: false, code: 'VAULT_RAG_FAILED', error: safeSubprocessError(error) }))
            else console.error(chalk.red(`\n✗ ${safeSubprocessError(error)}`))
            process.exit(1)
          }
        })
    )

  // vault sync-weread — sync WeRead to Vault
  program.commands
    .find(c => c.name() === 'vault')
    ?.addCommand(
      new Command('sync-weread')
        .description('微信读书同步到 Vault')
        .option('--type <type>', 'all / shelf / notes', 'all')
        .option('--vault <path>', 'Vault 路径', './output/wechat-vault')
        .option('--dry-run', '仅预览，不请求微信读书或写入 Vault')
        .option('--yes', '确认同步微信读书数据')
        .option('--json', '输出机器可读结果，不返回书籍或本地路径')
        .action(async (opts) => {
          if (!['all', 'shelf', 'notes'].includes(opts.type)) {
            if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', field: 'type' }))
            else console.log(chalk.red('type 必须是 all、shelf 或 notes'))
            process.exit(1)
          }
          const pkgRoot = resolvePackageRoot()
          const script = join(pkgRoot, 'scripts', 'sync_weread.py')
          await runConfirmedPythonMutation({
            action: 'vault.sync-weread',
            script,
            args: ['--type', opts.type, '--vault', opts.vault],
            cliOptions: opts,
            preview: { syncType: opts.type, readsWereadCloud: true, writesVault: true },
            confirmationMessage: '确认从微信读书服务读取数据并写入本地 Vault？',
            apiKeyVariable: 'WEREAD_API_KEY',
          })
        })
    )

  const vaultPromoteCmd = new Command('promote')
    .description('从 Vault 阅读笔记生成知识索引、想法和长期笔记')

  const runVaultPromotion = async (
    scriptName: string,
    action: string,
    opts: { vault: string, withAi?: boolean, apiKey?: string, dryRun?: boolean, yes?: boolean, json?: boolean },
  ) => {
    const pkgRoot = resolvePackageRoot()
    const args = ['--vault', opts.vault]
    const apiKey = opts.apiKey || process.env.DEEPSEEK_API_KEY
    if (opts.withAi && !opts.dryRun) {
      if (!apiKey) {
        if (opts.json) console.log(JSON.stringify({ success: false, code: 'AI_KEY_REQUIRED', action }))
        else console.error(chalk.red('启用 AI 升级需要 --api-key 或 DEEPSEEK_API_KEY。'))
        process.exit(1)
      }
    } else {
      args.push('--skip-ai')
    }
    await runConfirmedPythonMutation({
      action,
      script: join(pkgRoot, 'scripts', scriptName),
      args,
      cliOptions: opts,
      preview: { usesAi: !!opts.withAi, writesVault: true },
      confirmationMessage: `确认生成 Vault 知识提升内容？${opts.withAi ? '选定笔记内容将发送到已配置的 AI 服务。' : '仅执行本地确定性处理。'}`,
      apiKey: opts.withAi ? apiKey : undefined,
    })
  }

  vaultPromoteCmd
    .command('ideas')
    .description('生成主题导航和可选的研究想法')
    .option('--vault <path>', 'Vault 路径', './output/wechat-vault')
    .option('--with-ai', '允许 AI 生成研究想法')
    .option('--api-key <key>', 'AI API key，仅与 --with-ai 一起使用')
    .option('--dry-run', '仅预览，不读取笔记、调用 AI 或写入 Vault')
    .option('--yes', '确认生成知识提升内容')
    .option('--json', '输出机器可读结果，不返回笔记或本地路径')
    .action(async (opts) => {
      await runVaultPromotion('promote_ideas.py', 'vault.promote.ideas', opts)
    })

  vaultPromoteCmd
    .command('all')
    .description('生成参考索引和可选的永久笔记、项目提案')
    .option('--vault <path>', 'Vault 路径', './output/wechat-vault')
    .option('--with-ai', '允许 AI 生成永久笔记和项目提案')
    .option('--api-key <key>', 'AI API key，仅与 --with-ai 一起使用')
    .option('--dry-run', '仅预览，不读取笔记、调用 AI 或写入 Vault')
    .option('--yes', '确认生成知识提升内容')
    .option('--json', '输出机器可读结果，不返回笔记或本地路径')
    .action(async (opts) => {
      await runVaultPromotion('promote_all.py', 'vault.promote.all', opts)
    })

  program.commands.find(c => c.name() === 'vault')?.addCommand(vaultPromoteCmd)
}
