// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { join } from 'path'
import { writeFileSync } from 'fs'
import { configService } from '../../services/configService.js'
import { chatService } from '../../services/chatService.js'
import { exportService } from '../../services/exportService.js'
import type { ExportResult } from '../../services/exportService.js'
import { writeEvidencePackage } from '../../services/evidenceService.js'
import { DateRangeError, resolveExportDateRange } from '../../utils/dateRange.js'
import { parseCliInteger } from '../context.js'
import { resolveTalker } from '../talker.js'

export function registerExport(program: Command): void {

// ==================== export ====================
program
  .command('export <talker> <format>')
  .description('导出聊天记录 (支持 wxid / 昵称 / 备注 / 序号)')
  .option('-o, --output <dir>', '输出目录', './output')
  .option('-n, --limit <number>', '最大数量（0=全量导出）', '0')
  .option('-d, --date <YYYY-MM-DD>', '仅导出指定日期的消息（本地时间）')
  .option('--from <date>', '起始日期或 ISO 时间')
  .option('--to <date>', '结束日期或 ISO 时间')
  .option('--contract <name>', 'JSON 数据契约：raw 或 weflow-v1', 'raw')
  .option('--json', '输出机器可读的导出结果，不改变导出文件格式')
  .option('--non-interactive', '禁止交互选择；匹配不唯一时返回错误')
  .option('--full-images', '使用原图而非微信缓存缩略图（更清晰，但导出慢数倍）')
  .option('--save-originals', 'html 导出时把原图存到 <输出>/<联系人>_<时间戳>/assets/originals/，聊天里仍是缩略图，点击后打开原图')
  .option('--media', 'json/txt/excel 导出时一并抽出图片与文档（落盘到 <输出>/<会话>_assets，并在导出物里给出相对路径）')
  .action(async (talkerInput: string, format: string, opts) => {
    const validFormats = ['json', 'txt', 'html', 'md', 'excel']
    if (!validFormats.includes(format)) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_FORMAT', error: '导出格式无效', supported: validFormats }))
      else {
        console.log(chalk.red(`无效格式: ${format}`))
        console.log(chalk.gray(`可用: ${validFormats.join(', ')}`))
      }
      process.exit(1)
    }
    const limit = parseCliInteger(opts.limit, 'limit', 0, 1_000_000, !!opts.json)
    if (!configService.isConfigured()) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'NOT_INITIALIZED', error: '未完成初始化' }))
      else {
        console.log(chalk.red('\n❌ 还没配置'))
        console.log(chalk.gray('  运行: weflow-cli init\n'))
      }
      process.exit(1)
    }

    const talker = await resolveTalker(talkerInput, !!opts.json, opts.nonInteractive || opts.json)

    if (!opts.json) console.log(chalk.cyan(`正在导出 ${talker} 的聊天记录 (${format})...\n`))

    let result
    let from: number | undefined
    let to: number | undefined
    try {
      const range = resolveExportDateRange({
        date: opts.date,
        from: opts.from,
        to: opts.to,
        preserveDateForRichHtml: format === 'html',
      })
      from = range.from
      to = range.to
    } catch (error) {
      const dateError = error instanceof DateRangeError ? error : new DateRangeError('INVALID_DATE', '导出日期无效')
      if (opts.json) console.log(JSON.stringify({ success: false, code: dateError.code, error: dateError.message }))
      else console.log(chalk.red(dateError.message))
      process.exit(1)
    }
    if (!['raw', 'weflow-v1'].includes(opts.contract)) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'INVALID_CONTRACT', error: '数据契约无效', supported: ['raw', 'weflow-v1'] }))
      else {
        console.log(chalk.red(`不支持的数据契约: ${opts.contract}`))
        console.log(chalk.gray('可用: raw, weflow-v1'))
      }
      process.exit(1)
    }
    // 图片要靠 Python 那条路匹配（缓存缩略图、资源 md5、原图那档）。`--media` 就是"先抽一次"，
    // 抽完 json/txt/excel 各自消费同一份清单 —— 匹配只跑一遍，也不会在 TS 里重写一遍。
    // 抽取那一步的媒体摘要留在这里：`--media` 的调用者（机器调用）应当能从结果里直接读到
    // "各状态多少条、报告叫什么"，而不必去翻 Python 的 stdout。
    let extracted: ExportResult | undefined
    if (opts.media && (format === 'json' || format === 'txt' || format === 'excel')) {
      const media = await exportService.extractMedia(talker, opts.output, !!opts.json, { fullImages: opts.fullImages === true }, limit, opts.date || '')
      extracted = media
      if (!media.success) {
        if (opts.json) console.log(JSON.stringify({ success: false, code: 'MEDIA_EXPORT_FAILED', error: media.error || '媒体抽取失败' }))
        else console.log(chalk.red(`✗ 媒体抽取失败: ${media.error}`))
        process.exit(1)
      }
    } else if (opts.media && format === 'html') {
      // HTML 的产物是页面 + 图片，文档本体不在它的契约里（要文档请用 md 或 json|txt|excel --media）。
      // 静默忽略这个开关会让人以为它生效了 —— 明说一句，并给出该用哪个格式。
      if (!opts.json) {
        console.error(chalk.gray('  提示：HTML 导出不含文档本体，--media 对它不生效；'))
        console.error(chalk.gray('        要连文档一起导出请用 md，或 json|txt|excel --media。'))
      }
    }
    // `--save-originals` 只有 HTML 那条路会消费。md 本来就把图片写到 assets/，
    // json/txt/excel 要图片得用 --media —— 静默忽略会让人以为原图已经存下来了。
    if (opts.saveOriginals && format !== 'html' && !opts.json) {
      console.error(chalk.gray(`  提示：--save-originals 只用于 html 导出，对 ${format} 不生效；`))
      console.error(chalk.gray('        md 的图片本来就会落盘，json|txt|excel 请用 --media。'))
    }
    switch (format) {
      case 'json':
        result = await exportService.exportJson(talker, opts.output, limit, from, to, opts.contract)
        break
      case 'txt':
        result = await exportService.exportTxt(talker, opts.output, limit, from, to)
        break
      case 'html':
        result = await exportService.exportHtml(talker, opts.output, limit, opts.date || '', from, to, !!opts.json, {
          fullImages: opts.fullImages === true,
          saveOriginals: opts.saveOriginals === true,
        })
        break
      case 'md':
        // markdown + 图片落盘（`<输出>/<talker>_assets/`）；json/txt/excel 之后会自动带上那些图。
        result = await exportService.exportMarkdown(talker, opts.output, limit, opts.date || '', from, to, !!opts.json, { fullImages: opts.fullImages === true })
        break
      case 'excel':
        result = await exportService.exportExcel(talker, opts.output, limit, from, to)
        break
    }

    if (result?.success) {
      if (opts.json) console.log(JSON.stringify({
        success: true,
        format,
        contract: format === 'json' ? opts.contract : null,
        path: result.path,
        count: result.count ?? null,
        // 媒体摘要：html/md 那条由导出自己产出（Python 的 media_json_summary），
        // json/txt/excel 的 `--media` 则由上面那次抽取产出 —— 两条都是同一份词汇。
        media: result.media ?? extracted?.media ?? null,
        // 只有 `--save-originals` 的 HTML 导出会带这一项（`saved`/`reused`/`failed`）。
        originals: result.originals ?? null,
      }, null, 2))
      else console.log(chalk.green(`✓ 导出成功: ${result.path}`))
    } else {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'EXPORT_FAILED', error: result?.error || '导出失败' }))
      else console.log(chalk.red(`✗ 导出失败: ${result?.error}`))
      process.exit(1)
    }
  })

// ==================== evidence ====================
program
  .command('evidence <talker>')
  .description('整理本地聊天证据包（原始消息、哈希与保全说明）')
  .option('-o, --output <dir>', '证据包输出目录', './output/evidence')
  .option('-n, --limit <number>', '最多包含消息数', '10000')
  .option('--case <note>', '案件或争议说明（仅保存在本地证据包）')
  .option('--json', '输出 JSON 格式')
  .option('--non-interactive', '禁止交互选择；匹配不唯一时返回错误')
  .action(async (talkerInput: string, opts) => {
    if (!configService.isConfigured()) {
      if (opts.json) {
        console.log(JSON.stringify({ success: false, code: 'NOT_INITIALIZED', error: '未完成初始化' }))
        process.exit(1)
      }
      console.log(chalk.red('\n❌ 还没配置'))
      console.log(chalk.gray('  运行: weflow-cli init\n'))
      process.exit(1)
    }
    const talker = await resolveTalker(talkerInput, opts.json, opts.nonInteractive || opts.json)
    const limit = parseCliInteger(opts.limit, 'limit', 1, 100000, opts.json)
    const messages = await chatService.getMessages(talker, limit)
    if (messages.length === 0) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'NO_MESSAGES', error: '未找到消息' })); return }
      console.log(chalk.gray('未找到消息，未创建证据包'))
      return
    }
    const result = writeEvidencePackage(opts.output, talker, messages, opts.case)
    if (opts.json) {
      console.log(JSON.stringify({ success: true, path: result.path, manifest: result.manifest }, null, 2))
      return
    }
    console.log(chalk.green(`✓ 证据包已创建: ${result.path}`))
    console.log(chalk.gray(`  消息: ${result.manifest.messageCount} 条`))
    console.log(chalk.gray(`  SHA-256: ${result.manifest.messagesSha256}`))
    console.log(chalk.yellow('  注意: 哈希用于证明文件未被改动，不等于证明内容真实或必然具有法律效力。'))
  })

program
  .command('evidence-review <talker>')
  .description('用 AI 整理聊天中的法律争议线索（不提供法律结论）')
  .option('-o, --output <dir>', '分析结果输出目录', './output/evidence-review')
  .option('-n, --limit <number>', '最多分析消息数', '500')
  .option('--allow-cloud', '明确允许将按隐私模式处理后的内容发送到云端 AI')
  .option('--dry-run', '仅预览，不读取聊天、调用 AI 或写入分析结果')
  .option('--yes', '确认读取聊天并生成分析结果')
  .option('--json', '输出机器可读结果，不返回分析正文')
  .action(async (talkerInput: string, opts) => {
    const limit = parseCliInteger(opts.limit, 'limit', 1, 5000, !!opts.json)
    const preview = {
      success: true,
      dryRun: true,
      action: 'evidence-review',
      limit,
      readsLocalChat: true,
      usesAi: true,
      cloudAllowed: Boolean(opts.allowCloud),
      writesLocalResult: true,
    }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify(preview))
      else console.log(chalk.cyan(`预览：将读取最多 ${limit} 条指定会话消息，调用${opts.allowCloud ? '已授权的云端或本地' : '本地'}模型并写入分析结果。`))
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
        message: `确认读取指定会话并使用${opts.allowCloud ? '已授权的云端或本地' : '本地'}模型生成争议线索分析吗？`,
        default: false,
      }])
      if (!confirmed) {
        console.log(chalk.gray('已取消'))
        return
      }
    }
    if (!configService.isConfigured()) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'NOT_INITIALIZED', error: '未完成初始化' }))
      else {
        console.log(chalk.red('\n❌ 还没配置'))
        console.log(chalk.gray('  运行: weflow-cli init\n'))
      }
      process.exit(1)
    }
    const talker = await resolveTalker(talkerInput, !!opts.json, !!opts.json)
    const messages = await chatService.getMessages(talker, limit)
    if (messages.length === 0) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'NO_MESSAGES', error: '未找到消息，未创建分析结果' }))
      else console.log(chalk.gray('未找到消息，未创建分析结果'))
      return
    }
    const { AssistantService } = await import('../../services/assistantService.js')
    const result = await new AssistantService().reviewEvidence(talker, messages, Boolean(opts.allowCloud))
    const { mkdirSync } = await import('fs')
    mkdirSync(opts.output, { recursive: true })
    const outputPath = join(opts.output, `${Date.now()}-${talker.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60)}.md`)
    writeFileSync(outputPath, [
      '# 聊天法律争议线索整理', '',
      `- 会话：${talker}`,
      `- 消息数：${messages.length}`,
      `- 推理方式：${result.localInference ? '本地模型' : '云端模型（已按隐私模式处理）'}`,
      `- 脱敏次数：${result.redactions}`,
      '', result.text, '',
      '---', '',
      '本文件仅供线索整理，不是法律意见，不代表违法认定或法院必然采信。请保留原设备、原始数据和完整上下文，并咨询专业人士。',
    ].join('\n'), 'utf8')
    if (opts.json) {
      console.log(JSON.stringify({
        success: true,
        action: 'evidence-review',
        count: messages.length,
        outputCreated: true,
        localInference: result.localInference,
        redactions: result.redactions,
        cloudAllowed: Boolean(opts.allowCloud),
      }, null, 2))
      return
    }
    console.log(chalk.green(`✓ 分析结果已保存: ${outputPath}`))
    console.log(chalk.yellow(`  ${result.localInference ? '使用本地模型，聊天正文未离开本机' : '已使用云端模型，请确认隐私模式和授权范围'}`))
  })
}
