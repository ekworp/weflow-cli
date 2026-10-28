// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import { join } from 'path'
import { configService } from '../../services/configService.js'
import { parseCliInteger } from '../context.js'

export function registerWeread(program: Command): void {

  // ==================== weread ====================

  /** 微信读书服务失败时的统一出口。
   *
   * 9 个调用点（shelf / stats / notes×2 / search / book / review / discover / profile）原来都是一行式
   * 分支：把彩色散文打在 stdout 上再 `process.exit(1)`，**没有** json 支，而各命令的 `if (opts.json)`
   * 分支在它后面 ⇒ `weread shelf --json` 失败时 stdout 上只有一行 `✗ …`，调用方解析不了，也不知道
   * 是哪个命令失败了。全库其余同类出口都是"机器支发 JSON + exit"。
   *
   * （这里刻意**不**把那行旧代码原样抄出来：`test/json-error-surface.test.ts` 有一条绊线在扫那个形状，
   * 而注释里留一份字面量会让判据读到它 —— 今晚已经在另一条判据上踩过这个坑。）
   *
   * 人看的那一支保持原样（`console.log`，不动它的落点）：把 CLI 的**错误**统一改走 stderr 是另一件事，
   * 现在库里两种都有（多数 `console.error`、少数 `console.log`），不在这条修复里顺手改。
   */
  function failWeread(res: { error?: string }, json = false): never {
    if (json) console.log(JSON.stringify({ success: false, code: 'WEREAD_FAILED', error: res.error }))
    else console.log(chalk.red(`✗ ${res.error}`))
    process.exit(1)
  }

  const wereadCmd = program
    .command('weread')
    .description('微信读书助手 — 书架、统计、笔记、搜索、书评、推荐')

  wereadCmd
    .command('shelf')
    .description('查看书架')
    .option('--json', 'JSON 输出')
    .action(async (opts) => {
      const weread = await getWereadService()
      const res = await weread.shelf()
      if (!res.ok) failWeread(res, !!opts.json)
      const d = res.data!
      if (opts.json) { console.log(JSON.stringify(d, null, 2)); return }

      const total = d.books.length + d.albums.length + (d.mp ? 1 : 0)
      console.log(chalk.cyan(`📚 书架 (${total} 条目):\n`))
      console.log(chalk.gray(`  电子书: ${d.books.length} 本 | 有声书: ${d.albums.length} 个 | 文章收藏: ${d.mp ? '有' : '无'}`))
      if (d.archive.length) {
        console.log(chalk.gray(`  书单: ${d.archive.map((a: any) => a.name).join(', ')}`))
      }
      console.log()
      const books = d.books.sort((a: any, b: any) => b.readUpdateTime - a.readUpdateTime)
      for (let i = 0; i < Math.min(books.length, 30); i++) {
        const b = books[i]
        const num = String(i + 1).padStart(3)
        const done = b.finishReading === 1 ? chalk.green('✓') : ' '
        console.log(`${num}. ${done} ${b.title}  ${chalk.gray(b.author)}`)
      }
      if (d.books.length > 30) console.log(chalk.gray(`  ... 共 ${d.books.length} 本`))
    })

  wereadCmd
    .command('stats')
    .description('阅读统计')
    .option('--mode <mode>', 'weekly | monthly | annually | overall', 'monthly')
    .option('--json', 'JSON 输出')
    .action(async (opts) => {
      const weread = await getWereadService()
      const res = await weread.readData(opts.mode)
      if (!res.ok) failWeread(res, !!opts.json)
      const d = res.data!
      if (opts.json) { console.log(JSON.stringify(d, null, 2)); return }

      const h = (d.totalReadTime || 0) / 3600
      console.log(chalk.cyan(`📊 阅读统计 (${opts.mode}):\n`))
      console.log(`  总时长: ${chalk.white(h.toFixed(1) + ' 小时')}`)
      console.log(`  有效天数: ${chalk.white(String(d.readDays))}`)
      if (d.dayAverageReadTime) {
        console.log(`  日均: ${chalk.white(Math.round(d.dayAverageReadTime / 60) + ' 分钟')}`)
      }
      if (d.readStat?.length) {
        console.log(`  ${d.readStat.map((s: any) => `${s.stat}: ${chalk.white(s.counts)}`).join(' | ')}`)
      }
      if (d.preferCategoryWord) console.log(`  偏好: ${chalk.white(d.preferCategoryWord)}`)
      if (d.preferTimeWord) console.log(`  时段: ${chalk.white(d.preferTimeWord)}`)

      // 偏好分类
      if (d.preferCategory?.length) {
        console.log(chalk.cyan('\n  偏好分类:'))
        for (const c of d.preferCategory.slice(0, 5)) {
          const hh = (c.readingTime / 3600).toFixed(1)
          console.log(`    ${c.categoryTitle}: ${chalk.white(hh + 'h')} (${c.readingCount}本)`)
        }
      }

      // Read longest
      if (d.readLongest?.length) {
        console.log(chalk.cyan('\n  读最久的书:'))
        for (const item of d.readLongest.slice(0, 5)) {
          const b = item.book || item.albumInfo || {}
          const hh = (item.readTime / 3600).toFixed(1)
          console.log(`    ${b.title || '(未知)'}: ${chalk.white(hh + 'h')}  ${chalk.gray(b.author || '')}`)
        }
      }
    })

  wereadCmd
    .command('notes')
    .description('笔记划线')
    .option('--book-id <id>', '指定书籍 ID')
    .option('-n, --limit <n>', '数量', '20')
    .option('--json', 'JSON 输出')
    .action(async (opts) => {
      const weread = await getWereadService()
      const limit = parseCliInteger(opts.limit, 'limit', 1, 100, opts.json)
      if (opts.bookId) {
        const res = await weread.bookmarks(opts.bookId, limit)
        if (!res.ok) failWeread(res, !!opts.json)
        const d = res.data!
        if (opts.json) { console.log(JSON.stringify(d, null, 2)); return }
        console.log(chalk.cyan(`📝 划线笔记 (${d.updated?.length || 0} 条):\n`))
        for (let i = 0; i < Math.min((d.updated || []).length, limit); i++) {
          const n = d.updated[i]
          const icon = n.type === 1 ? '💬' : '📌'
          console.log(`${chalk.gray(`  [${i + 1}]`)} ${icon} ${n.markText?.slice(0, 60) || ''}`)
          if (n.content) console.log(`${chalk.cyan('      想法:')} ${n.content.slice(0, 100)}`)
          console.log()
        }
      } else {
        const res = await weread.notebooks(50)
        if (!res.ok) failWeread(res, !!opts.json)
        const d = res.data!
        if (opts.json) { console.log(JSON.stringify(d, null, 2)); return }
        console.log(chalk.cyan(`📝 笔记本 (${d.books?.length || 0} 本有笔记):\n`))
        for (let i = 0; i < Math.min((d.books || []).length, 30); i++) {
          const b: any = d.books[i]
          const bookInfo = b.book || b
          const num = String(i + 1).padStart(3)
          console.log(`${num}. ${bookInfo.title || '(未知)'}  ${chalk.gray(`划线:${b.highlightCount || b.noteCount || 0} 想法:${b.reviewCount || 0} 书签:${b.bookmarkCount || 0}`)}`)
        }
      }
    })

  wereadCmd
    .command('search')
    .description('搜索书籍')
    .argument('<keyword>', '搜索关键词')
    .option('-n, --limit <n>', '数量', '10')
    .option('--json', 'JSON 输出')
    .action(async (keyword, opts) => {
      const weread = await getWereadService()
      const limit = parseCliInteger(opts.limit, 'limit', 1, 100, opts.json)
      const res = await weread.search(keyword, limit)
      if (!res.ok) failWeread(res, !!opts.json)
      const d = res.data!
      if (opts.json) { console.log(JSON.stringify(d, null, 2)); return }
      console.log(chalk.cyan(`🔍 搜索: "${keyword}" (${d.books?.length || 0} 条):\n`))
      for (let i = 0; i < (d.books || []).length; i++) {
        const b = d.books[i]
        const num = String(i + 1).padStart(2)
        const star = b.rating ? ` ⭐${b.rating}` : ''
        console.log(`  ${num}. ${b.title}  ${chalk.gray(b.author)}${star}`)
        if (b.intro) console.log(`     ${chalk.gray(b.intro.slice(0, 80))}`)
      }
    })

  wereadCmd
    .command('book')
    .description('书籍详情')
    .argument('<bookId>', '书籍 ID')
    .option('--json', 'JSON 输出')
    .action(async (bookId, opts) => {
      const weread = await getWereadService()
      const [infoRes, progressRes] = await Promise.all([
        weread.bookInfo(bookId),
        weread.getProgress(bookId),
      ])
      if (!infoRes.ok) failWeread(infoRes, !!opts.json)
      const b = infoRes.data!
      if (opts.json) { console.log(JSON.stringify(b, null, 2)); return }

      console.log(chalk.cyan(`📖 ${b.title}`))
      if (b.author) console.log(`  作者: ${chalk.white(b.author)}`)
      if (b.rating) console.log(`  评分: ${chalk.white('⭐' + b.rating + ' (' + (b as any).ratingCount + '评)')}`)
      if (b.category) console.log(`  分类: ${chalk.gray(b.category)}`)
      if (b.wordCount) console.log(`  字数: ${chalk.gray(b.wordCount)}`)
      if (b.publisher) console.log(`  出版: ${chalk.gray(b.publisher)}`)
      if (b.intro) console.log(`\n  ${b.intro.slice(0, 200)}`)
      if (progressRes.ok && progressRes.data) {
        console.log(`\n  📍 进度: ${chalk.white(progressRes.data.chapterTitle || '未开始')}`)
      }
    })

  wereadCmd
    .command('review')
    .description('书籍点评')
    .argument('<bookId>', '书籍 ID')
    .option('-n, --limit <n>', '数量', '10')
    .option('--json', 'JSON 输出')
    .action(async (bookId, opts) => {
      const weread = await getWereadService()
      const limit = parseCliInteger(opts.limit, 'limit', 1, 100, opts.json)
      const res = await weread.reviews(bookId, limit)
      if (!res.ok) failWeread(res, !!opts.json)
      const d = res.data!
      if (opts.json) { console.log(JSON.stringify(d, null, 2)); return }
      console.log(chalk.cyan(`💬 书评 (${d.reviews?.length || 0} 条):\n`))
      for (let i = 0; i < (d.reviews || []).length; i++) {
        const r = d.reviews[i]
        const num = String(i + 1).padStart(2)
        const star = r.rating ? ` ⭐${r.rating}` : ''
        console.log(`  ${num}. ${r.user?.name || '匿名'}${star}  ${chalk.gray(`👍${r.likeCount || 0}`)}`)
        if (r.content) console.log(`     ${r.content.slice(0, 120)}`)
        console.log()
      }
    })

  wereadCmd
    .command('discover')
    .description('推荐好书')
    .option('--book-id <id>', '基于某本书的相似推荐')
    .option('-n, --limit <n>', '数量', '10')
    .option('--json', 'JSON 输出')
    .action(async (opts) => {
      const weread = await getWereadService()
      const limit = parseCliInteger(opts.limit, 'limit', 1, 100, opts.json)
      const res = opts.bookId
        ? await weread.similar(opts.bookId, limit)
        : await weread.recommend(limit)
      if (!res.ok) failWeread(res, !!opts.json)
      const d = res.data!
      if (opts.json) { console.log(JSON.stringify(d, null, 2)); return }
      const label = opts.bookId ? '相似推荐' : '个性化推荐'
      console.log(chalk.cyan(`🎯 ${label}:\n`))
      for (let i = 0; i < (d.books || []).length; i++) {
        const b = d.books[i]
        const num = String(i + 1).padStart(2)
        const star = b.rating ? ` ⭐${b.rating}` : ''
        console.log(`  ${num}. ${b.title}  ${chalk.gray(b.author)}${star}`)
        if (b.intro) console.log(`     ${chalk.gray(b.intro.slice(0, 80))}`)
      }
    })

  wereadCmd
    .command('profile')
    .description('个人阅读概览')
    .option('--json', 'JSON 输出')
    .action(async (opts) => {
      const weread = await getWereadService()
      const res = await weread.profile()
      if (!res.ok) failWeread(res, !!opts.json)
      const p = res.data!
      if (opts.json) { console.log(JSON.stringify(p, null, 2)); return }

      const totalH = (p.totalReadTime / 3600).toFixed(1)
      console.log(chalk.cyan('📖 个人阅读概览:\n'))
      console.log(`  总时长:  ${chalk.white(totalH + ' 小时')}`)
      console.log(`  阅读天数: ${chalk.white(String(p.totalReadDays) + ' 天')}`)
      console.log(`  书架:    ${chalk.white(String(p.totalBooks) + ' 本')}`)
      console.log(`  读完:    ${chalk.white(String(p.totalFinished) + ' 本')}`)
    })

  async function getWereadService() {
    // key 的两个来源与优先级见 `resolveWereadApiKey`（抽出去是为了能被测到 ——
    // 只读环境变量那版害得用户配好配置项之后 `weread shelf` 仍然报"未设置"）。
    const mod = await import('../../services/wereadService.js')
    const key = mod.resolveWereadApiKey(process.env.WEREAD_API_KEY, configService.get('wereadApiKey'))
    return new mod.WereadService(key)
  }
}
