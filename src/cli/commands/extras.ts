// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import { createPythonProcessEnv } from '../../utils/pythonProcessEnv.js'
import { runPythonScript } from '../context.js'

export function registerExtras(program: Command): void {

// ==================== extras（NT 库里其余那些还没人读过的东西） ====================
// 2026-10-27 普查的第二个产物（docs/NT_DATABASES.md）：`avatar`/`media`/`ledger` 之后
// 还剩 general/session/emoticon/solitaire/bizchat 没人读。
//
// 三条取舍写在这里，因为它们看起来都像"该帮忙翻译一下"：
//   · 未验证的枚举**原样给数字**，结果里带 `unverifiedEnums`。`SessionTable.type`
//     在本机是常量 0（710/710），拿它当分类维度会得到"全中/全空"两种假象。
//   · 空表**如实报 0**。`chatbot_message.db` 四张表全 0 行、`revoke` 的 revokemessage
//     0 行——"有表无记录"不等于"没这个功能"。
//   · `emoticon.db` 的 `aes_key` **解不开**图片（带正对照验证过），所以只给元数据。
const EXTRAS_KINDS = ['overview', 'search-history', 'sessions', 'emoticons', 'fmessages',
  'solitaire', 'biz-subscribe', 'revoke', 'bizchat', 'all'] as const

program
  .command('extras [kind]')
  .description('NT 库里其余那些还没人读过的东西（general/session/emoticon/solitaire/bizchat；本地只读、不联网）')
  .option('--db <path>', 'message_0.db 路径（默认取配置 ntDbPath）')
  .option('--unread', 'sessions 额外带上未读明细（本机 2.6 万行）')
  .option('--json', '输出 JSON 格式')
  .action(async (kind: string | undefined, opts) => {
    const kindsList = EXTRAS_KINDS.join('、')
    if (!kind) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', error: `要给一个 kind：${kindsList}` })); process.exit(1) }
      console.error(chalk.red(`✗ 要给一个 kind：${kindsList}`))
      console.error(chalk.gray('  例：weflow-cli extras search-history'))
      process.exit(1)
    }
    if (!(EXTRAS_KINDS as readonly string[]).includes(kind)) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', field: 'kind', error: `kind 必须是 ${kindsList}` })); process.exit(1) }
      console.error(chalk.red(`✗ kind 必须是 ${kindsList}`))
      process.exit(1)
    }
    const args = [kind, ...(opts.unread ? ['--unread'] : [])]
    const stdout = await runPythonScript('scripts/wechat_extras.py', args, {
      json: opts.json, code: 'EXTRAS_FAILED', prefix: '✗ ',
      timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
      // 库路径走环境变量（D-020 的规矩：不给 argv）
      env: createPythonProcessEnv(opts.db ? { WEFLOW_EXTRAS_DB: String(opts.db) } : {}),
    })
    const payload = JSON.parse(stdout.slice(stdout.indexOf('{')))
    if (opts.json) { console.log(JSON.stringify(payload)); if (!payload.success) process.exit(1); return }
    if (!payload.success && !Object.keys(payload.results || {}).length) {
      console.error(chalk.red(`✗ ${Object.values(payload.errors || {}).join('；') || '读取失败'}`))
      process.exit(1)
    }
    for (const [name, data] of Object.entries<any>(payload.results || {})) {
      printExtrasBlock(name, data)
    }
    for (const [name, error] of Object.entries<any>(payload.errors || {})) {
      console.error(chalk.yellow(`⚠ ${name}: ${error}`))
    }
  })

/** `extras` 的人类可读摘要。JSON 才是完整数据，这里只给"有多少、长什么样"。 */
function printExtrasBlock(name: string, data: any): void {
  console.log(chalk.cyan(`\n=== ${name} ===`))
  if (data.db) console.log(chalk.gray(`  ${data.db} · ${data.dbPath}`))
  const counts = data.counts
  if (counts) {
    console.log('  ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '))
  }
  if (name === 'overview') {
    for (const lib of data.libraries || []) {
      if (!lib.exists) { console.log(chalk.gray(`  ${lib.db.padEnd(16)} 不存在`)); continue }
      const empty = (lib.tables || []).filter((t: any) => !t.rows).map((t: any) => t.name)
      const unread = (lib.tables || []).filter((t: any) => t.rows === null).length
      console.log(`  ${lib.db.padEnd(16)} tables=${String((lib.tables || []).length).padEnd(3)}`
        + ` 空表=${empty.length}${unread ? ` 读不出=${unread}` : ''}`)
    }
    console.log(chalk.gray(`  共 ${data.tableCount} 张表，其中 ${data.nonEmptyTableCount} 张有数据`))
  } else if (name === 'search-history') {
    for (const row of (data.rows || []).slice(0, 12)) {
      const when = row.time ? new Date(row.time * 1000).toLocaleString('zh-CN', { hour12: false }) : '?'
      const scene = row.scene === undefined ? '' : chalk.gray(` scene=${row.scene}`)
      console.log(`  [${when}] ${row.source.padEnd(13)} ${row.keyword || row.username || ''}${scene}`)
    }
    console.log(chalk.gray(`  ${data.note || ''}`))
  } else if (name === 'sessions') {
    for (const row of (data.sessions || []).slice(0, 10)) {
      const when = row.lastTimestamp ? new Date(row.lastTimestamp * 1000).toLocaleString('zh-CN', { hour12: false }) : '?'
      const badge = row.unreadCount ? chalk.yellow(`未读${row.unreadCount}`) : chalk.gray('已读')
      const hidden = row.isHidden ? chalk.gray(' [隐藏]') : ''
      console.log(`  [${when}] ${badge} ${row.username}${hidden}  ${row.summary || ''}`.slice(0, 120))
    }
    if ((data.deleted || []).length) {
      console.log(chalk.gray('  删过的会话（只剩这张表有痕迹）：'))
      for (const row of data.deleted) {
        const when = row.deleteTime ? new Date(row.deleteTime * 1000).toLocaleString('zh-CN', { hour12: false }) : '?'
        console.log(chalk.gray(`    [${when}] ${row.username}`))
      }
    }
    if (data.unreadJoin) {
      console.log(chalk.gray(`  未读明细：${data.unreadJoin.resolved} 条解出会话、`
        + `${data.unreadJoin.unresolved} 条解不到`))
    }
    console.log(chalk.gray(`  ${data.note || ''}`))
  } else if (name === 'emoticons') {
    for (const pkg of (data.packages || []).slice(0, 8)) {
      console.log(`  表情包 ${pkg.name || pkg.packageId}  作者=${pkg.author || '?'}`)
    }
    for (const item of (data.custom || []).slice(0, 6)) {
      console.log(`  自定义 ${item.md5.slice(0, 10)}…  ${item.caption || ''}`)
    }
    if (data.notDecryptable) {
      console.log(chalk.yellow(`  ⚠ ${data.notDecryptable.what} 拿不到：${data.notDecryptable.why}`))
    }
  } else if (name === 'fmessages') {
    for (const row of (data.rows || []).slice(0, 10)) {
      const when = row.time ? new Date(row.time * 1000).toLocaleString('zh-CN', { hour12: false }) : '?'
      console.log(`  [${when}] ${row.isSender ? '我发' : '收到'} ${row.username}  ${row.content || ''}`)
    }
  } else if (name === 'solitaire') {
    for (const g of (data.groups || [])) {
      console.log(`  ${g.session || g.sessionMd5 + '（未解出会话）'}  `
        + `主体=${g.main.length} 有效=${g.valid.length} 折叠=${g.folded.length}`)
    }
    console.log(chalk.gray(`  ${data.note || ''}`))
  } else if (name === 'revoke') {
    for (const row of (data.revokedBatches || []).slice(0, 10)) {
      const when = row.msgCreateTime ? new Date(row.msgCreateTime * 1000).toLocaleString('zh-CN', { hour12: false }) : '?'
      console.log(`  批量撤回 [${when}] ${row.session}`)
    }
    console.log(chalk.gray(`  ${data.note || ''}`))
  } else if (name === 'biz-subscribe') {
    if (data.joins) {
      console.log(chalk.gray(`  订阅 ∩ 小程序资料卡：${data.joins.subscribedWithMiniProgramCard} 有卡、`
        + `${data.joins.subscribedWithoutCard} 无卡；另 ${data.joins.miniProgrammingNotSubscribed} 个有卡未订阅`))
    }
    for (const w of (data.miniPrograms || []).filter((x: any) => x.name).slice(0, 10)) {
      console.log(`  ${w.name}  ${chalk.gray(w.englishId || '')}  ${(w.description || '').slice(0, 24)}`)
    }
    console.log(chalk.gray(`  ${data.note || ''}`))
  } else if (name === 'bizchat') {
    // counts 已经打过了，没有更细的摘要可给
  }
  if (data.readErrors) {
    for (const err of data.readErrors) {
      console.error(chalk.yellow(`  ⚠ 读失败 ${err.what}：${err.error}`))
    }
  }
  if (data.unverifiedEnums) {
    console.log(chalk.gray('  未验证的枚举（原样给数字）：'
      + Object.entries(data.unverifiedEnums).map(([k, v]) => `${k}（${v}）`).join('；')))
  }
}
}
