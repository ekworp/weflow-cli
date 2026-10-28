// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import { join } from 'path'
import { configService } from '../../services/configService.js'
import { chatService } from '../../services/chatService.js'
import { getPythonCommand } from '../../utils/python.js'
import { createPythonProcessEnv, safeSubprocessError } from '../../utils/pythonProcessEnv.js'
import { resolvePackageRoot, pythonProcessEnv, parseCliInteger } from '../context.js'

export function registerContacts(program: Command): void {

// ==================== ledger（资金流水：红包/转账，读 general.db） ====================
// 2026-10-26 NT 普查产物（docs/NT_DATABASES.md）。如实边界写在脚本头：红包表无
// 时间/金额列（在消息正文里，按 messageServerId 溯源是后续工作）；状态枚举语义
// 未逐值验证，原样输出不翻译。本地只读、不联网。
program
  .command('ledger')
  .description('资金流水：红包与转账（读 general.db；本地只读）')
  .option('--talker <contact>', '只看某个会话（id 或备注/昵称子串）')
  .option('--days <n>', '只看最近 N 天（按转账时间；红包无时间列不受此限）')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const script = join(resolvePackageRoot(), 'scripts', 'wechat_ledger.py')
    const args = [script, '--json']
    if (opts.days !== undefined) {
      const days = parseCliInteger(opts.days, 'days', 1, 36_500, opts.json)
      args.push('--days', String(days))
    }
    try {
      const { stdout } = await execFileAsync(getPythonCommand(), args, {
        timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
        // D-020：会话标识走环境变量，不进 argv
        env: createPythonProcessEnv(opts.talker ? { WEFLOW_TALKER: String(opts.talker) } : {}),
      })
      const payload = JSON.parse(stdout.slice(stdout.indexOf('{')))
      if (opts.json) { console.log(JSON.stringify(payload)); if (!payload.success) process.exit(1); return }
      if (!payload.success) { console.error(chalk.red(`✗ ${payload.error}`)); process.exit(1) }
      console.log(chalk.cyan(`
资金流水：红包 ${payload.redEnvelopes} 笔、转账 ${payload.transfers} 笔`))
      console.log(chalk.gray('  （红包无时间/金额列——在消息正文里，按 messageServerId 看先后；状态枚举原样，语义未验证）'))
      for (const r of payload.rows.slice(0, 40)) {
        const when = r.time ? new Date(r.time * 1000).toLocaleString('zh-CN', { hour12: false }) : '（无时间列）'
        const extra = r.kind === '红包'
          ? `status=${r.hbStatus}/${r.receiveStatus}`
          : `对方=${r.counterpartyDisplay || r.counterparty || '?'}${r.invalidTime ? ` invalid=${r.invalidTime}` : ''}`
        console.log(`  [${when}] ${r.kind} · ${r.sessionDisplay} · ${r.direction} · ${extra}`)
      }
      if (payload.rows.length > 40) console.log(chalk.gray(`  …共 ${payload.rows.length} 行（--json 看全表）`))
      console.log('')
    } catch (e: any) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'LEDGER_FAILED', error: safeSubprocessError(e) })); process.exit(1) }
      console.error(chalk.red(`✗ ${safeSubprocessError(e)}`))
      process.exit(1)
    }
  })

// ==================== avatar（联系人头像，读 head_image.db） ====================
// 2026-10-26 NT 数据库普查的直接产物（docs/NT_DATABASES.md）：头像本体内嵌在
// head_image.db 里（JPEG/PNG 完整字节，按 username 键控，一人多行=变更历史），
// 比文件缓存可靠（清理不丢）。本地只读、不联网。
program
  .command('avatar [contact]')
  .description('导出联系人头像（读 head_image.db；--list 看谁有头像，--all 批量导出最新头像）')
  .option('--list', '只列出有头像的 username 与头像数')
  .option('--all', '导出所有 username 的最新头像到 --out 目录')
  .option('--out <path>', '输出文件（单联系人）或目录（--all），默认 output/avatars/')
  .option('--json', '输出 JSON 格式')
  .action(async (contact: string | undefined, opts) => {
    if (!contact && !opts.list && !opts.all) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', error: '要给联系人，或用 --list / --all' })); process.exit(1) }
      console.error(chalk.red('✗ 要给联系人，或用 --list / --all'))
      process.exit(1)
    }
    if (contact && (opts.list || opts.all)) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', error: '联系人与 --list/--all 互斥' })); process.exit(1) }
      console.error(chalk.red('✗ 联系人与 --list/--all 互斥'))
      process.exit(1)
    }
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const script = join(resolvePackageRoot(), 'scripts', 'wechat_avatar.py')
    const args = [script, ...(opts.list ? ['--list'] : opts.all ? ['--all'] : []), '--json']
    // D-020：联系人标识走环境变量，不进 argv；输出路径同理（脚本 --out 缺省读它）
    const env = {
      ...(contact ? { WEFLOW_TALKER: String(contact) } : {}),
      ...(opts.out ? { WEFLOW_AVATAR_OUT: String(opts.out) } : {}),
    }
    try {
      const { stdout } = await execFileAsync(getPythonCommand(), args, {
        timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
        env: createPythonProcessEnv(env),
      })
      const payload = JSON.parse(stdout.slice(stdout.indexOf('{')))
      if (opts.json) { console.log(JSON.stringify(payload)); if (!payload.success) process.exit(1); return }
      if (!payload.success) { console.error(chalk.red(`✗ ${payload.error}`)); process.exit(1) }
      if (payload.action === 'avatar.export') {
        console.log(chalk.green(`✓ 已导出「${payload.username}」的最新头像（${payload.bytes} 字节，历史 ${payload.historyCount} 张）→ ${payload.out}`))
      } else if (payload.action === 'avatar.export-all') {
        console.log(chalk.green(`✓ 已导出 ${payload.written} 个最新头像 → ${payload.dir}`))
      } else {
        console.log(payload.error || `共 ${payload.users?.length ?? '?'} 个 username 有头像（用 --json 看全表）`)
      }
    } catch (e: any) {
      if (opts.json) { console.log(JSON.stringify({ success: false, code: 'AVATAR_FAILED', error: safeSubprocessError(e) })); process.exit(1) }
      console.error(chalk.red(`✗ ${safeSubprocessError(e)}`))
      process.exit(1)
    }
  })

// ==================== contacts ====================
// contact-schema：读 contact.db 里**群**的 ext_buffer（本地只读：不联网、不调模型）
//
// 只解**实测验证过**的那几个字段（成员 userName/displayName/status/inviter + `#5`）；
// `#5` 曾经叫"附加参与者 id"，实测是**成员 status 位 11 置位的那批 id**（本机 77/77 集合相等），
// 所以输出改用 `statusBit11Ids`、不再说"额外参与者"（见 D-070）。
// 顶层 `#3`/`#4` 的语义在本机被三次证伪（不是成员 id / 房间 id / 消息侧 id），所以脚本把它们
// 原样放进 `unrecognized`，**不猜名字** —— 拿猜出来的名字写逻辑，就是拿不确定当事实。
// 结构笔记见 `docs/CONTACT_DB_SCHEMA.md`，取舍见 D-067 / D-068 / D-070。
//
// `--contacts`（2026-10-07 加）：同一个命令改读**联系人**的 `contact.extra_buffer`，输出这一轮验证的
// 三个字段 —— `#5` 国家/地区码（ISO 3166-1 alpha-2）、`#13` = 该行 `biz_info.type`、`#41` = 资料最近更新时间。
// `#4`/`#9` 已定性为"账号自身资料文本的汇集"，是**内容**不是字段名，**故意不打印**（见 D-088）。
program
  .command('contact-schema')
  .description('读 contact.db 的 ext_buffer：默认读群（成员 + #5）；--contacts 读联系人（#5 地区码 / #13 服务类型 / #41 更新时间）—— 只解已验证字段，未识别的原样标注（本地、只读）')
  .option('-n, --limit <n>', '最多看几个（群 / 联系人）', '20')
  .option('--room <which>', '只看某个（群 / 联系人 的 username 或 id）')
  .option('--contacts', '改读联系人的 extra_buffer，而不是群')
  .option('--json', '输出机器可读结果')
  .action(async (opts) => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const script = join(resolvePackageRoot(), 'scripts', 'contact_schema.py')
    const limit = parseCliInteger(opts.limit, 'limit', 1, 100000, !!opts.json)
    const args = [script, '--limit', String(limit),
                  ...(opts.room ? ['--room', opts.room] : []),
                  ...(opts.contacts ? ['--contacts'] : []),
                  ...(opts.json ? ['--json'] : [])]
    try {
      const { stdout, stderr } = await execFileAsync(getPythonCommand(), args, {
        timeout: 300_000, maxBuffer: 64 * 1024 * 1024, env: pythonProcessEnv(),
      })
      process.stdout.write(stdout)
      if (stderr && !opts.json) process.stderr.write(stderr)
    } catch (error) {
      if (opts.json) {
        console.log(JSON.stringify({ success: false, code: 'CONTACT_SCHEMA_FAILED', action: 'contact-schema', error: safeSubprocessError(error) }))
      } else {
        console.error(chalk.red(`\n✗ ${safeSubprocessError(error)}`))
      }
      process.exit(1)
    }
  })

program
  .command('contacts')
  .description('查看联系人列表')
  .option('-k, --keyword <keyword>', '搜索关键词 (自动扩大搜索范围)')
  .option('-n, --limit <number>', '最大数量', '500')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const limit = parseCliInteger(opts.limit, 'limit', 1, 5000, !!opts.json)
    if (!configService.isConfigured()) {
      if (opts.json) { console.log(JSON.stringify({ success: false, error: '未完成初始化' })); process.exit(1) }
      console.log(chalk.red('请先运行 weflow-cli init'))
      process.exit(1)
    }

    const contacts = await chatService.listContacts(opts.keyword, limit)
    if (contacts.length === 0) {
      if (opts.json) { console.log(JSON.stringify({ success: true, contacts: [] })); return }
      console.log(chalk.gray('未找到联系人'))
      return
    }

    if (opts.json) {
      console.log(JSON.stringify({ success: true, contacts }, null, 2))
      return
    }
    console.log(chalk.cyan(`联系人列表 (${contacts.length} 条):\n`))
    console.log(chalk.gray('序号  用户ID                昵称/备注'))
    console.log(chalk.gray('─'.repeat(60)))

    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i]
      const num = String(i + 1).padStart(3)
      const id = (c.username || '').padEnd(20)
      const name = c.remark || c.displayName || c.nickname || ''
      console.log(`${num}  ${id} ${name}`)
    }
  })
}
