/** 导出与主题列表。 */
import { existsSync } from 'fs'
import { basename, dirname, join } from 'path'
import { exportService } from '../exportService.js'
import { PKG_ROOT } from './paths.js'
import { boundedToolInteger, resolveTalker } from './runtime.js'
import type { ToolContext } from './types.js'

export async function handleExportChat(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  // **写操作**，边界写死：只往 output/exports/ 下**新建**目录（名字带时间戳），绝不覆盖；
  // 路径由这里拼，模型给不了任意路径。用户是在对话里明确要求的，这就是那次确认。
  const contact = String(args.contact || '').trim()
  if (!contact) return '(缺少 contact 参数)'
  const limit = boundedToolInteger(args.limit, 500, 5000, 'limit')
  const format = String(args.format || 'html').toLowerCase()
  if (!['html', 'txt', 'json', 'excel'].includes(format)) {
    return `(参数错误: format 只能是 html/txt/json/excel，收到 ${format.slice(0, 12)})`
  }
  const talker = await resolveTalker(contact)

  const safeName = contact.replace(/[\/:*?"<>|]/g, '_').slice(0, 20) || 'chat'
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
  // 导出根目录可用环境变量改（测试用临时目录；也方便自定义）。默认在仓库的 output/exports 下。
  const exportRoot = process.env.WEFLOW_ASSISTANT_EXPORT_ROOT || join(PKG_ROOT, 'output', 'exports')
  // HTML 自己会建 `<联系人>_<时间戳>/` 这个目录（D-133），所以它直接落在导出根下。
  // 再替它包一层只会得到 `甲-20261027/甲_20261027/index.html` —— 用户要的是**一层**目录，
  // 而且嵌套之后"报出导到哪"也不得不拼接两级，读的人得自己猜哪一级才是导出物。
  // 其它格式没有自己的目录，仍由这里建（时间戳到秒，撞名往后加序号，绝不覆盖）。
  let outDir = exportRoot
  if (format !== 'html') {
    let candidate = join(exportRoot, `${safeName}-${stamp}`)
    for (let n = 2; existsSync(candidate) && n < 100; n++) {
      candidate = join(exportRoot, `${safeName}-${stamp}-${n}`)
    }
    outDir = candidate
  }
  const result = format === 'txt' ? await exportService.exportTxt(talker, outDir, limit)
    : format === 'json' ? await exportService.exportJson(talker, outDir, limit)
      : format === 'excel' ? await exportService.exportExcel(talker, outDir, limit)
        : await exportService.exportHtml(talker, outDir, limit, '', undefined, undefined, true)
  if (!result.success) return `(导出失败: ${String(result.error || '未知').slice(0, 100)})`
  const suffix = format === 'html' ? '，含图片' : ''
  // 报**真的写到了哪**：HTML 的 `path` 是 `<导出目录>/index.html`，导出目录就是它的父目录；
  // 其它格式的产物在 `outDir` 里。事前拼的名字不能用 —— 撞名时实际目录带 `-2`，
  // 两次导出会报成同一个（2026-09-23 验收：第二次明明是 `…-2`，消息里却是基础名）。
  const writtenDir = format === 'html' && result.path ? dirname(result.path) : outDir
  // 根目录是默认值时按仓库相对路径报（用户照着找得到）；自定义根时只报目录名——
  // **不把绝对路径发进聊天**，那是本机路径，没必要出境。
  const shown = exportRoot === join(PKG_ROOT, 'output', 'exports')
    ? `output/exports/${basename(writtenDir)}`
    : basename(writtenDir)
  return `已导出 ${result.count ?? 0} 条消息到 ${shown}/（${format}${suffix}）`
}

export async function handleListThemes(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const { listThemes } = await import('../wechat-formatter.js')
  const themes = listThemes()
  if (!themes.length) return '(没有可用主题)'
  return `可用主题 ${themes.length} 个:\n`
    + themes.map(t => `· ${t.id} — ${t.name}: ${t.description}`).join('\n')
}
