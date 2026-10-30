// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import { configService } from '../../services/configService.js'
import { chatService } from '../../services/chatService.js'
import { capturePythonScript, parseCliInteger } from '../context.js'

export function registerContacts(program: Command): void {

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
    const limit = parseCliInteger(opts.limit, 'limit', 1, 100000, !!opts.json)
    const args = ['--limit', String(limit),
                  ...(opts.room ? ['--room', opts.room] : []),
                  ...(opts.contacts ? ['--contacts'] : []),
                  ...(opts.json ? ['--json'] : [])]
    const { stdout, stderr } = await capturePythonScript('scripts/contact_schema.py', args, {
      json: opts.json,
      code: 'CONTACT_SCHEMA_FAILED',
      action: 'contact-schema',
      timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
    })
    process.stdout.write(stdout)
    if (stderr && !opts.json) process.stderr.write(stderr)
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
