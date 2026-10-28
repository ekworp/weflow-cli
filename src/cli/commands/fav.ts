// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import { join } from 'path'
import { writeFileSync } from 'fs'
import { configService } from '../../services/configService.js'
import { chatService } from '../../services/chatService.js'
import { detectFavDbPath } from '../../services/initKeyService.js'
import { parseCliInteger } from '../context.js'

export function registerFav(program: Command): void {

// ==================== fav (微信收藏) ====================

const FAV_TYPE_IDS: Record<string, number> = {
  text: 1, image: 2, video: 4, article: 5, chatrecord: 14,
}

const FAV_TYPE_LABELS: Record<string, string> = {
  text: '文字', image: '图片', video: '视频', article: '文章', chatrecord: '聊天记录',
}

const favCmd = program
  .command('fav')
  .description('微信收藏内容查询 (4.x NT 连接)')

favCmd
  .command('list')
  .description('列出收藏内容')
  .option('-t, --type <type>', '类型过滤: text|image|video|article|chatrecord')
  .option('-k, --keyword <kw>', '关键词搜索')
  .option('-n, --limit <number>', '最大数量', '20')
  .option('-o, --offset <number>', '偏移量', '0')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const limit = parseCliInteger(opts.limit, 'limit', 1, 5000, !!opts.json)
    const offset = parseCliInteger(opts.offset, 'offset', 0, 1_000_000, !!opts.json)
    if (!configService.isConfigured()) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'NOT_INITIALIZED', error: '未完成初始化' }))
      else console.log(chalk.red('\n❌ 还没配置\n  运行: weflow-cli init\n'))
      process.exit(1)
    }

    // 自动发现 favorite.db
    if (!configService.get('favDbPath')) {
      const favPath = detectFavDbPath()
      if (favPath) {
        configService.set('favDbPath', favPath)
        if (!opts.json) console.log(chalk.green(`✓ 自动发现收藏数据库: ${favPath}\n`))
      }
    }

    const conn = await chatService.connect()
    if (!conn.success) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'DATABASE_CONNECTION_FAILED', error: '数据库连接失败' }))
      else console.log(chalk.red(`\n❌ 数据库连接失败: ${conn.error}\n`))
      process.exit(1)
    }
    const favReason = chatService.favUnavailableReason()
    if (favReason) {
      const detail = {
        channel: '当前数据通道不支持收藏查询 (需 4.x NT 连接)',
        path: '未找到收藏数据库 (favorite.db)，请确认微信已登录并产生过收藏',
        key: '收藏数据库已找到，但缺少密钥',
      }[favReason]
      if (opts.json) {
        console.log(JSON.stringify({ success: false, code: 'FAVORITES_UNAVAILABLE', reason: favReason, error: detail }))
        process.exit(1)
      }
      console.log(chalk.red(`\n❌ ${detail}`))
      if (favReason === 'key') {
        console.log(chalk.gray('  请先配置收藏密钥: weflow-cli fav set-key <64位hex密钥>'))
        console.log(chalk.gray('  或设置全库 passphrase: weflow-cli fav set-key --passphrase <64位hex>'))
      }
      if (favReason === 'path') {
        console.log(chalk.gray('  可手动指定: weflow-cli config set favDbPath <favorite.db 路径>'))
      }
      console.log('')
      process.exit(1)
    }

    let favType: number | undefined
    if (opts.type) {
      favType = FAV_TYPE_IDS[opts.type.toLowerCase()]
      if (!favType) {
        if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_FAVORITE_TYPE', error: '收藏类型无效' }))
        else {
          console.log(chalk.red(`❌ 未知类型: ${opts.type}`))
          console.log(chalk.gray('  可选: text image video article chatrecord'))
        }
        process.exit(1)
      }
    }

    const result = await chatService.getFavorites({
      limit,
      offset,
      keyword: opts.keyword,
      favType,
    })

    if (!result.success || !result.favorites || result.favorites.length === 0) {
      if (opts.json) {
        console.log(JSON.stringify({ success: result.success, favorites: [], total: result.total || 0, error: result.error || null }))
        if (!result.success) process.exit(1)
      } else console.log(chalk.gray(`未找到收藏内容${result.error ? `: ${result.error}` : ''}`))
      return
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    const total = result.total ?? result.favorites.length
    console.log(chalk.cyan(`收藏列表 (共 ${total} 条, 显示 ${result.favorites.length} 条):\n`))
    for (const item of result.favorites) {
      const time = item.update_time
        ? new Date(Number(item.update_time) * 1000).toLocaleString('zh-CN')
        : '未知时间'
      const typeLabel = FAV_TYPE_LABELS[item.type_name] || item.type_name
      const title = (item.title || '(无标题)').replace(/\n/g, ' ').slice(0, 60)
      console.log(chalk.gray(`[${time}]`) + ` ${chalk.blue(`[${typeLabel}]`)} ${title}`)
      if (item.source_name) console.log(chalk.gray(`    来源: ${item.source_name}`))
      if (item.link) console.log(chalk.gray(`    ${item.link.slice(0, 90)}`))
    }
  })

favCmd
  .command('export <format>')
  .description('导出收藏内容 (markdown|json)')
  .option('-t, --type <type>', '类型过滤: text|image|video|article|chatrecord')
  .option('-k, --keyword <kw>', '关键词搜索')
  .option('-n, --limit <number>', '最大数量', '1000')
  .option('-o, --output <file>', '输出文件路径')
  .option('--json-result', '输出机器可读的导出结果，不改变文件格式')
  .action(async (format: string, opts) => {
    if (format !== 'markdown' && format !== 'json') {
      if (opts.jsonResult) console.log(JSON.stringify({ success: false, code: 'INVALID_FORMAT', error: '格式仅支持 markdown 或 json' }))
      else console.log(chalk.red('❌ 格式仅支持: markdown | json'))
      process.exit(1)
    }
    const limit = parseCliInteger(opts.limit, 'limit', 0, 1_000_000, !!opts.jsonResult)
    if (!configService.isConfigured()) {
      if (opts.jsonResult) console.log(JSON.stringify({ success: false, code: 'NOT_INITIALIZED', error: '未完成初始化' }))
      else console.log(chalk.red('\n❌ 还没配置\n  运行: weflow-cli init\n'))
      process.exit(1)
    }

    if (!configService.get('favDbPath')) {
      const favPath = detectFavDbPath()
      if (favPath) configService.set('favDbPath', favPath)
    }

    const conn = await chatService.connect()
    if (!conn.success) {
      if (opts.jsonResult) console.log(JSON.stringify({ success: false, code: 'DATABASE_CONNECTION_FAILED', error: '数据库连接失败' }))
      else console.log(chalk.red(`\n❌ 数据库连接失败: ${conn.error}\n`))
      process.exit(1)
    }
    if (!chatService.isFavSupported()) {
      if (opts.jsonResult) console.log(JSON.stringify({ success: false, code: 'FAVORITES_UNAVAILABLE', error: '当前数据通道不支持收藏查询' }))
      else {
        console.log(chalk.red('\n❌ 当前数据通道不支持收藏查询 (需 4.x NT 连接)'))
        console.log(chalk.gray('  请先配置收藏密钥: weflow-cli fav set-key <64位hex密钥>\n'))
      }
      process.exit(1)
    }

    let favType: number | undefined
    if (opts.type) {
      favType = FAV_TYPE_IDS[opts.type.toLowerCase()]
      if (!favType) {
        if (opts.jsonResult) console.log(JSON.stringify({ success: false, code: 'INVALID_FAVORITE_TYPE', error: '收藏类型无效' }))
        else console.log(chalk.red(`❌ 未知类型: ${opts.type}`))
        process.exit(1)
      }
    }

    // 全量导出: limit 为 0 时取全部
    const result = await chatService.getFavorites({
      limit,
      offset: 0,
      keyword: opts.keyword,
      favType,
    })
    if (!result.success || !result.favorites) {
      if (opts.jsonResult) console.log(JSON.stringify({ success: false, code: 'EXPORT_FAILED', error: result.error || '无内容' }))
      else console.log(chalk.red(`导出失败: ${result.error || '无内容'}`))
      process.exit(1)
    }

    const items = result.favorites
    let content: string
    if (format === 'json') {
      content = JSON.stringify(items, null, 2)
    } else {
      const lines: string[] = ['# 微信收藏导出', '', `> 共 ${items.length} 条 · 导出时间 ${new Date().toLocaleString('zh-CN')}`, '']
      for (const item of items) {
        const time = item.update_time
          ? new Date(Number(item.update_time) * 1000).toLocaleString('zh-CN')
          : '未知时间'
        const typeLabel = FAV_TYPE_LABELS[item.type_name] || item.type_name
        lines.push(`## ${item.title || '(无标题)'}`)
        lines.push('')
        lines.push(`- 类型: ${typeLabel}`)
        lines.push(`- 时间: ${time}`)
        if (item.source_name) lines.push(`- 来源: ${item.source_name}`)
        if (item.link) lines.push(`- 链接: <${item.link}>`)
        if (item.desc) lines.push(`- 摘要: ${item.desc}`)
        lines.push('')
      }
      content = lines.join('\n')
    }

    const outPath = opts.output || `favorites_${Date.now()}.${format === 'json' ? 'json' : 'md'}`
    writeFileSync(outPath, content, 'utf8')
    if (opts.jsonResult) console.log(JSON.stringify({ success: true, format, path: outPath, count: items.length }, null, 2))
    else console.log(chalk.green(`✓ 已导出 ${items.length} 条收藏到 ${outPath}`))
  })

favCmd
  .command('set-key [key]')
  .description('设置收藏数据库密钥 (默认 raw key; --passphrase 表示全库共用 passphrase)')
  .option('--passphrase', '输入的是全库共用 passphrase (自动派生 favorite.db 密钥)')
  .option('--from-env <name>', '从环境变量读取密钥，避免密钥出现在命令参数中', 'WEFLOW_FAV_KEY')
  .option('--dry-run', '仅验证输入并预览，不修改配置')
  .option('--yes', '确认执行')
  .option('--json', '输出 JSON 格式，不返回密钥或数据库路径')
  .action(async (key: string | undefined, opts) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.fromEnv)) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_ENVIRONMENT_NAME', error: '环境变量名称无效' }))
      else console.log(chalk.red('环境变量名称无效'))
      process.exit(1)
    }
    const resolvedKey = key || process.env[opts.fromEnv]
    if (!resolvedKey) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'KEY_MISSING', error: `环境变量 ${opts.fromEnv} 未设置且未提供密钥` }))
      else console.log(chalk.red(`✗ 未提供密钥；请设置环境变量 ${opts.fromEnv} 或传入 key`))
      process.exit(1)
    }
    if (!/^[0-9a-fA-F]{64}$/.test(resolvedKey)) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_KEY_FORMAT', error: '密钥必须是 64 位十六进制字符串' }))
      else console.log(chalk.red('❌ 密钥格式错误: 需要 64 位十六进制字符串'))
      process.exit(1)
    }
    const preview = {
      action: 'favorites.set-key',
      mode: opts.passphrase ? 'passphrase' : 'raw-key',
      source: key ? 'argument' : 'environment',
      environment: key ? null : opts.fromEnv,
    }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify({ success: true, dryRun: true, ...preview }))
      else console.log(chalk.cyan(`将保存收藏数据库${opts.passphrase ? '全库 passphrase' : '密钥'}`))
      return
    }
    if (opts.json && !opts.yes) {
      console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认保存收藏数据库密钥', ...preview }))
      process.exit(1)
    }
    if (opts.passphrase) {
      configService.set('favPassphrase', resolvedKey)
      configService.set('favKey', '') // 清空旧 raw key, 下次查询时重新派生
      if (!opts.json) console.log(chalk.green('✓ 已保存全库 passphrase'))
    } else {
      configService.set('favKey', resolvedKey)
      if (!opts.json) console.log(chalk.green('✓ 已保存 favorite.db raw key'))
    }
    let databaseDetected = !!configService.get('favDbPath')
    if (!configService.get('favDbPath')) {
      const favPath = detectFavDbPath()
      if (favPath) {
        configService.set('favDbPath', favPath)
        databaseDetected = true
        if (!opts.json) console.log(chalk.green(`✓ 自动发现收藏数据库: ${favPath}`))
      } else if (!opts.json) {
        console.log(chalk.yellow('⚠ 未自动发现 favorite.db, 请手动设置: weflow-cli config set favDbPath <path>'))
      }
    }
    if (opts.json) {
      console.log(JSON.stringify({ success: true, changed: true, databaseDetected, ...preview }))
      return
    }
    console.log(chalk.cyan('\n现在可以使用收藏功能:'))
    console.log(chalk.gray('  weflow-cli fav list'))
    console.log(chalk.gray('  weflow-cli fav export markdown'))
  })
}
