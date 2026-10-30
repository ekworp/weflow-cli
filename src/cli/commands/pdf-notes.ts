// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { runPythonScript, parseCliInteger } from '../context.js'

export function registerPdfNotes(program: Command): void {

// pdf-notes：PDF → 本机 OCR → 摘要与概念，喂给 wiki compile
program
  .command('pdf-notes')
  .description('把 PDF 变知识卡（本机 OCR 转文字，再问摘要与概念）—— **只写本地文件，不发送**')
  .option('--pdf <file>', '单个 PDF 路径')
  .option('--dir <dir>', 'PDF 目录（递归找 *.pdf）')
  .option('--from-chat', '从聊天记录里找别人发过的 PDF（读微信 hardlink.db，按文件时间倒序）')
  .option('--ocr-root <dir>', '本机 OCR 引擎目录（Unlimited-OCR-2）',
          'D:\\github_project\\ZhaoWen_GitHub维护\\ocr2')
  .option('--ocr <mode>', 'auto=本地在就用本地、不在就上云端、都没有才抽内嵌文本；local/cloud 强制；none 只抽内嵌文本', 'auto')
  .option('--ocr-model <name>', '云端 OCR 模型（默认 qwen3.5-ocr）')
  .option('--pages <range>', '只处理这些页（例 1-50）')
  .option('--dpi <n>', 'OCR 渲染精度（默认 200）', '200')
  .option('--window <n>', 'OCR 一次喂几页（默认 10）', '10')
  .option('--limit <n>', '最多处理几个 PDF', '5')
  .option('--dry-run', '仅预览：几个 PDF、会不会调用本机 OCR（只读本地，零出境）')
  .option('--refresh', '已有卡的也重做（默认增量：只做还没卡的）')
  .option('--no-reuse-ocr', '不复用缓存的 OCR 文字（默认复用：PDF 没改过就不重做识别，实测 30.9s → 2.3s）')
  .option('--ocr-only', '只做识别、只写文字（不调用模型、不花钱、不需要 --yes 与 API key）—— 可挂着过夜跑完，白天再出卡')
  .option('--yes', '确认把 PDF 文字发给生成模型')
  .option('--json', '输出机器可读结果；执行仍需 --yes')
  .action(async (opts) => {
    const limit = parseCliInteger(opts.limit, 'limit', 1, 5000, opts.json)
    // 与其它几条线同一条纪律：**"确认过了"只用一个变量**，参数在确认之后才拼。
    // 这条线多一句提示：PDF 的**文字**会出境（PDF 本身不出境，本机 OCR）。
    let confirmed = !!opts.yes
    // `--ocr-only` 零出境、零花费，不该弹确认框（确认框是给"要发出去"那一步的）
    if (!opts.dryRun && !opts.ocrOnly && !confirmed) {
      const preview = {
        success: false, dryRun: false, action: 'pdf-notes',
        code: 'CONFIRMATION_REQUIRED', pdf: opts.pdf, dir: opts.dir, limit,
        readsLocalData: true, invokesAI: true, writesLocalFiles: true, sendsNothing: true,
        note: 'PDF 在本机 OCR（不出网）；只有 OCR 后的文字会发给模型',
      }
      if (opts.json) {
        console.log(JSON.stringify(preview))
        process.exit(1)
      }
      const answer = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmed',
        message: '确认把这些 PDF 的文字（OCR 后）发给生成模型吗？（PDF 本身在本机 OCR，不出境）',
        default: false,
      }])
      confirmed = !!answer.confirmed
      if (!confirmed) {
        console.log(chalk.gray('已取消'))
        return
      }
    }
    const args = [...(opts.pdf ? ['--pdf', String(opts.pdf)] : []),
                  ...(opts.dir ? ['--dir', String(opts.dir)] : []),
                  ...(opts.fromChat ? ['--from-chat'] : []),
                  '--ocr-root', String(opts.ocrRoot),
                  '--ocr', String(opts.ocr),
                  ...(opts.ocrModel ? ['--ocr-model', String(opts.ocrModel)] : []),
                  ...(opts.pages ? ['--pages', String(opts.pages)] : []),
                  '--dpi', String(opts.dpi),
                  '--window', String(opts.window),
                  '--limit', String(limit),
                  ...(opts.refresh ? ['--refresh'] : []),
                  ...(opts.reuseOcr === false ? ['--no-reuse-ocr'] : []),
                  ...(opts.ocrOnly ? ['--ocr-only'] : []),
                  ...(confirmed ? ['--yes'] : []),
                  ...(opts.json ? ['--json'] : []),
                  ...(opts.dryRun ? ['--dry-run'] : [])]
    // 脚本自己在 `--json` 下会打印一条**结构化**错误（没找到 PDF、OCR 引擎缺失…）。
    // 直接透出它，比一句"子进程执行失败"有用得多——那正是这个命令最需要说清的两件事。
    const parseFailurePayload = (error: unknown): { success?: boolean; error?: string } | null => {
      const raw = String((error as { stdout?: unknown }).stdout ?? '').trim()
      if (!raw) return null
      try { return JSON.parse(raw) as { success?: boolean; error?: string } } catch { return null }
    }
    const stdout = await runPythonScript('scripts/pdf_notes.py', args, {
      json: opts.json,
      code: 'PDF_NOTES_FAILED',
      action: 'pdf-notes',
      jsonExtra: (error) => parseFailurePayload(error) ?? {},
      timeout: 7_200_000, maxBuffer: 50 * 1024 * 1024,
    })
    process.stdout.write(stdout)
  })
}
