// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { SYNC_SCHEMA, SYNC_SOURCE, syncStateStore } from '../../services/syncState.js'
import { SyncRangeRequiredError, runSync } from '../../services/syncService.js'
import { probeCursorReadiness } from '../../services/cursorProbe.js'
import { configService } from '../../services/configService.js'
import { chatService } from '../../services/chatService.js'
import { resolveTalker as resolveTalkerCore } from '../../utils/talkerUtils.js'
import { DateRangeError, parseLocalDateOrIso } from '../../utils/dateRange.js'
import { parseCliInteger } from '../context.js'

export function registerSync(program: Command): void {

// ==================== sync ====================
// 增量同步检查点。契约见 docs/SYNC_CONTRACT.md, 边界见 D-029。
// 不宣称「稳定游标」: D-027 要求它在所有后端支持前不得对外宣称,
// 这里只做重叠时间窗 + 本地去重。
const syncCmd = program.command('sync').description('本地消息同步检查点（重叠窗口读取与覆盖报告）')

syncCmd
  .command('run <talker>')
  .description('执行一次同步并写入检查点')
  .option('--since <date>', '起始日期或 ISO 时间（首次运行需要）')
  .option('--full', '读取全部历史（首次运行需要；耗时可能较长）')
  .option('--overlap <seconds>', '重叠窗口秒数', '300')
  .option('-n, --limit <number>', '本次最多读取条数（0=不限）', '0')
  .option('--dry-run', '仅预览，不读取消息、不写状态')
  .option('--yes', '确认执行')
  .option('--json', '输出机器可读结果')
  .option('--non-interactive', '禁止交互确认')
  .action(async (talker: string, opts) => {
    const overlap = parseCliInteger(opts.overlap, 'overlap', 0, 86400, !!opts.json)
    const limit = parseCliInteger(opts.limit, 'limit', 0, 1_000_000, !!opts.json)

    let since: number | undefined
    if (opts.since) {
      try {
        since = parseLocalDateOrIso(opts.since)
      } catch (error) {
        const message = error instanceof DateRangeError ? error.message : '日期格式无效'
        if (opts.json) { console.log(JSON.stringify({ success: false, code: 'INVALID_DATE', error: message })); process.exit(1) }
        console.error(chalk.red(`✗ ${message}`))
        process.exit(1)
      }
    }
    if (opts.full && since !== undefined) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', error: '--since 与 --full 不能同时使用' })); process.exit(1) }
      console.error(chalk.red('✗ --since 与 --full 不能同时使用'))
      process.exit(1)
    }

    // Preview deliberately does not resolve the talker: that reads the
    // database, and a preview must not touch local data (D-025).
    const prior = (() => {
      try { return syncStateStore.read(SYNC_SOURCE, talker) } catch { return null }
    })()
    const preview = {
      success: true,
      dryRun: true,
      action: 'sync.run',
      schema: SYNC_SCHEMA,
      source: SYNC_SOURCE,
      talkerResolved: false,
      hasCheckpoint: !!prior,
      window: {
        from: since ?? prior?.checkpoint.newestCreateTime ?? null,
        overlapSeconds: overlap,
        full: !!opts.full,
      },
      estimatedRecords: prior?.recordsRead ?? null,
      readsLocalChat: true,
      writesLocalState: true,
      stableCursor: false,
    }

    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify(preview))
      else {
        console.log(chalk.cyan('\n同步预览'))
        console.log(chalk.gray(`  范围: ${opts.full ? '全部历史' : since ? new Date(since * 1000).toLocaleString() : '上次检查点'}`))
        console.log(chalk.gray(`  重叠窗口: ${overlap} 秒`))
        console.log(chalk.gray('  将读取本地聊天记录并写入同步检查点，不调用 AI。\n'))
      }
      return
    }

    if (!opts.yes) {
      if (opts.json) {
        console.log(JSON.stringify({ ...preview, success: false, dryRun: false, code: 'CONFIRMATION_REQUIRED' }))
        process.exit(1)
      }
      if (opts.nonInteractive) {
        console.error(chalk.red('✗ 非交互模式需要 --yes'))
        process.exit(1)
      }
      const { confirmed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmed',
        message: opts.full
          ? '将读取该会话的全部历史消息，可能耗时数分钟。继续吗？'
          : '将读取指定范围内的消息并写入本地同步检查点。继续吗？',
        default: false,
      }])
      if (!confirmed) {
        console.log(chalk.gray('已取消'))
        return
      }
    }

    if (!configService.isConfigured()) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'NOT_INITIALIZED', error: '未完成初始化' })); process.exit(1) }
      console.error(chalk.red('✗ 未完成初始化，请先运行 weflow-cli init'))
      process.exit(1)
    }

    let resolvedTalker = ''
    try {
      resolvedTalker = await resolveTalkerCore(talker, { interactive: !opts.nonInteractive })
    } catch {
      resolvedTalker = ''
    }
    if (!resolvedTalker) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', error: '未找到该会话' })); process.exit(1) }
      console.error(chalk.red('✗ 未找到该会话'))
      process.exit(1)
    }
    // A display name is nicety only; the state is keyed by the resolved id.
    let displayName = resolvedTalker
    try {
      const match = (await chatService.listSessions()).find(s => s.username === resolvedTalker)
      if (match?.displayName && match.displayName !== resolvedTalker) displayName = match.displayName
    } catch { /* keep the id */ }

    try {
      const result = await runSync(resolvedTalker, {
        since, full: !!opts.full, overlapSeconds: overlap, limit,
        scope: displayName,
        read: (who, howMany, from) => chatService.getMessagesWithShards(who, howMany, 0, from),
      })
      if (opts.json) {
        console.log(JSON.stringify({
          success: result.success,
          ...(result.code ? { code: result.code } : {}),
          action: result.action,
          schema: SYNC_SCHEMA,
          source: SYNC_SOURCE,
          scope: result.scope,
          talker: resolvedTalker,
          window: result.window,
          recordsRead: result.recordsRead,
          recordsDeduplicated: result.recordsDeduplicated,
          recordsReturned: result.recordsReturned,
          shards: result.shards,
          coverage: result.coverage,
          mayHaveMore: result.mayHaveMore,
          partial: result.partial,
          warnings: result.warnings,
          jobId: result.jobId,
        }))
        if (!result.success) process.exit(1)
        return
      }
      const mark = result.coverage === 'complete' ? '✓' : result.coverage === 'unverified' ? '!' : '✗'
      console.log(chalk.green(`\n${mark} 同步完成: ${result.recordsReturned}/${result.recordsRead} 条（去重 ${result.recordsDeduplicated}）`))
      console.log(chalk.gray(`  覆盖: ${result.coverage}  ·  分片: ${result.shards?.opened ?? '?'} 读 / ${result.shards?.failed ?? 0} 失败`))
      for (const warning of result.warnings) console.log(chalk.yellow(`  ⚠ ${warning}`))
      if (result.partial) {
        console.log(chalk.yellow('  本次为部分完成，未推进成功时间；用 sync status 查看详情。'))
      }
      console.log('')
      if (!result.success) process.exit(1)
    } catch (error: any) {
      if (error instanceof SyncRangeRequiredError) {
        if (opts.json) { console.log(JSON.stringify({ success: false, code: 'SYNC_RANGE_REQUIRED', error: error.message })); process.exit(1) }
        console.error(chalk.red(`✗ ${error.message}`))
        process.exit(1)
      }
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'SYNC_FAILED', error: '同步失败' })); process.exit(1) }
      console.error(chalk.red(`✗ 同步失败: ${error?.message || error}`))
      process.exit(1)
    }
  })

syncCmd
  .command('status [talker]')
  .description('查看同步检查点与最近任务')
  .option('--json', '输出 JSON 格式')
  .action(async (talker: string | undefined, opts) => {
    // No database access: this has to work while the database is locked.
    let states: any[] = []
    try { states = syncStateStore.list() } catch { states = [] }
    const lastJob = syncStateStore.recentJobs(1)[0] ?? null

    if (talker) {
      const match = states.find(s => s.talker === talker || s.scope === talker)
      if (!match) {
        if (opts.json) { console.log(JSON.stringify({ success: false, code: 'SYNC_STATE_NOT_FOUND', error: '没有该会话的同步记录' })); process.exit(1) }
        console.error(chalk.red('✗ 没有该会话的同步记录'))
        process.exit(1)
      }
      if (opts.json) { console.log(JSON.stringify({ success: true, schema: SYNC_SCHEMA, state: match, lastJob })); return }
      console.log(chalk.cyan(`\n同步记录 — ${match.scope}`))
      console.log(chalk.gray(`  覆盖: ${match.coveredFrom || '—'} ~ ${match.coveredTo || '—'}`))
      console.log(chalk.gray(`  可信度: ${match.coverage}  ·  分片 ${match.shardsRead} 读 / ${match.shardsFailed} 失败`))
      console.log(chalk.gray(`  上次成功: ${match.lastSuccessfulRun || '—'}  ·  上次尝试: ${match.lastAttempt || '—'}\n`))
      return
    }

    if (opts.json) {
      console.log(JSON.stringify({
        success: true,
        schema: SYNC_SCHEMA,
        stableCursor: false,
        scopes: states.map(s => ({
          source: s.source, scope: s.scope, talker: s.talker,
          lastSuccessfulRun: s.lastSuccessfulRun, lastAttempt: s.lastAttempt,
          coveredFrom: s.coveredFrom, coveredTo: s.coveredTo,
          recordsRead: s.recordsRead, recordsDeduplicated: s.recordsDeduplicated,
          coverage: s.coverage, shardsRead: s.shardsRead, shardsFailed: s.shardsFailed,
          mayHaveMore: s.mayHaveMore, warnings: s.warnings,
        })),
        lastJob,
      }))
      return
    }
    if (!states.length) {
      console.log(chalk.gray('\n还没有任何同步记录。首次运行: weflow-cli sync run <会话> --since <日期>\n'))
      return
    }
    console.log(chalk.cyan(`\n同步记录 (${states.length} 个会话):\n`))
    for (const s of states) {
      const mark = s.coverage === 'complete' ? '✓' : s.coverage === 'unverified' ? '!' : '✗'
      console.log(`  ${mark} ${s.scope}  ${chalk.gray(`${s.coveredFrom || '—'} ~ ${s.coveredTo || '—'}  分片 ${s.shardsRead}/${s.shardsFailed} 失败`)}`)
    }
    console.log('')
  })

syncCmd
  .command('verify <talker>')
  .description('核对检查点与当前数据的边界')
  .option('--json', '输出 JSON 格式')
  .action(async (talker: string, opts) => {
    // Read-only: it writes nothing, so it needs no confirmation - the same
    // posture as `messages`.
    if (!configService.isConfigured()) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'NOT_INITIALIZED', error: '未完成初始化' })); process.exit(1) }
      console.error(chalk.red('✗ 未完成初始化'))
      process.exit(1)
    }
    let state: any = null
    try { state = syncStateStore.read(SYNC_SOURCE, talker) } catch { state = null }
    if (!state) state = syncStateStore.list().find(s => s.scope === talker) ?? null
    if (!state) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'SYNC_STATE_NOT_FOUND', error: '没有该会话的同步记录' })); process.exit(1) }
      console.error(chalk.red('✗ 没有该会话的同步记录'))
      process.exit(1)
    }

    const checks: Array<Record<string, unknown>> = [{ name: 'checkpoint-present', ok: true }]

    // Re-read and compare. This is the count summary of §4.4 in the absence
    // of a local index.
    const read = await chatService.getMessagesWithShards(state.talker, 0, 0)
    const fromSeconds = state.coveredFrom ? Math.floor(Date.parse(state.coveredFrom) / 1000) : null
    const inWindow = fromSeconds === null
      ? read.messages
      : read.messages.filter(m => Number(m.createTime) >= fromSeconds)
    checks.push({ name: 'window-re-readable', ok: inWindow.length > 0, returned: inWindow.length })

    const newest = read.messages.length
      ? Math.max(...read.messages.map(m => Number(m.createTime) || 0))
      : null
    checks.push({
      name: 'newest-message-present',
      ok: newest !== null && newest >= (state.checkpoint?.newestCreateTime ?? 0),
      recorded: state.checkpoint?.newestCreateTime ?? null,
      observed: newest,
    })

    if (read.shards) {
      checks.push({ name: 'shards-readable', ok: read.shards.failed === 0,
                    scanned: read.shards.scanned, failed: read.shards.failed })
    } else {
      // Neither a pass nor a failure: this backend simply cannot say.
      checks.push({ name: 'shards-readable', ok: true, skipped: true,
                    reason: 'backend-does-not-report-shards' })
    }

    const success = checks.every(c => c.ok || c.skipped)
    if (opts.json) {
      console.log(JSON.stringify({ success, schema: SYNC_SCHEMA, scope: state.scope, coverage: state.coverage, checks }))
      if (!success) process.exit(1)
      return
    }
    console.log(chalk.cyan(`\n核对 — ${state.scope}\n`))
    for (const check of checks) {
      const mark = check.skipped ? '–' : check.ok ? '✓' : '✗'
      console.log(`  ${mark} ${check.name}${check.skipped ? chalk.gray(` (跳过: ${check.reason})`) : ''}`)
    }
    console.log('')
    if (!success) process.exit(1)
  })

// 稳定游标的"路径可见"探针（D-027）。只读、本地、无确认门——与 `check` 同一副姿态：
// 它是诊断，不是副作用。`stableCursor` 的结论**不会**因为它翻 true；它做的是把
// "还差什么"逐条摊开给下游（she-love-me、MCP 客户端）看。
syncCmd
  .command('cursor-probe')
  .description('探测当前消息后端离稳定增量游标还差什么（只读，NT 后端带实测采样）')
  .option('--json', '输出 JSON 格式')
  .option('--tables-per-shard <n>', '每分片采样的会话表数量（schema 检查始终全量）', '5')
  .option('--rows-per-table <n>', '每张表两端各采样的行数', '500')
  .action(async (opts) => {
    const parseBound = (raw: string, label: string): number | undefined => {
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 1 || n > 10_000) {
        if (opts.json) { console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', error: `${label} 必须是 1-10000 的整数` })); process.exit(1) }
        console.error(chalk.red(`✗ ${label} 必须是 1-10000 的整数`))
        process.exit(1)
      }
      return n
    }
    let report
    try {
      report = await probeCursorReadiness({
        tablesPerShard: parseBound(opts.tablesPerShard, '--tables-per-shard'),
        rowsPerTable: parseBound(opts.rowsPerTable, '--rows-per-table'),
      })
    } catch (error: any) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'CURSOR_PROBE_FAILED', error: error?.message || '探测失败' })); process.exit(1) }
      console.error(chalk.red(`✗ 探测失败: ${error?.message || error}`))
      process.exit(1)
    }
    if (opts.json) { console.log(JSON.stringify(report)); return }

    console.log(chalk.cyan('\n稳定游标探针（结论不变：stableCursor = false，D-027）'))
    console.log(chalk.gray(`  后端: ${report.backend ?? '（未配置）'} — ${report.backendNote}`))
    console.log(chalk.gray(`  实测: ${report.probedLive ? `已采样（exhaustive=false）` : '未运行（该后端无实测探针或未初始化）'}`))
    for (const c of report.criteria) {
      const mark = c.met === null ? '?' : c.met ? '✓' : '✗'
      console.log(`  ${mark} ${c.id}`)
      console.log(chalk.gray(`      ${c.detail}`))
    }
    if (report.sample) {
      const sm = report.sample
      console.log(chalk.gray(`  采样: ${sm.rowsSampled} 行 / ${sm.tablesSampled} 表（共 ${sm.tablesTotal} 表，每表两端各 ${sm.rowsPerTable} 行）`))
    }
    console.log('')
  })
}
