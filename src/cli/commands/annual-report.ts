// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { parseCliInteger, runPythonScript } from '../context.js'

export function registerAnnualReport(program: Command): void {

  // annual-report
  program
    .command('annual-report')
    .description('生成年度数字生活报告')
    .argument('[year]', '年份（默认今年）')
    .option('--share', '分享模式（紧凑卡片）')
    .option('--api-key <key>', 'DeepSeek API key')
    .option('--skip-ai', '跳过 AI 总结')
    .option('--output <file>', '输出文件')
    .option('--dry-run', '仅预览，不读取数据、调用 AI 或写入报告')
    .option('--yes', '确认生成年度报告')
    .option('--json', '输出机器可读结果，不返回本地路径')
    .action(async (year, opts) => {
      const reportYear = parseCliInteger(year || String(new Date().getFullYear()), 'year', 1970, 2100, opts.json)
      const preview = {
        success: true,
        dryRun: true,
        action: 'annual-report.generate',
        year: reportYear,
        shareMode: !!opts.share,
        aiEnabled: !opts.skipAi,
        readsLocalData: true,
      }
      if (opts.dryRun) {
        if (opts.json) console.log(JSON.stringify(preview))
        else console.log(chalk.cyan(`${reportYear} 年度报告预览：AI ${opts.skipAi ? '关闭' : '开启'}`))
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
          message: `确认生成 ${reportYear} 年度报告？${opts.skipAi ? '仅执行本地统计。' : '统计摘要可能发送到已配置的 AI 服务。'}`,
          default: false,
        }])
        if (!confirmed) {
          console.log(chalk.gray('已取消'))
          return
        }
      }
      const a = [String(reportYear)]
      if (opts.share) a.push('--share')
      if (opts.skipAi) a.push('--skip-ai')
      if (opts.output) a.push('--output', opts.output)
      const stdout = await runPythonScript('scripts/annual_report.py', a, {
        json: opts.json,
        code: 'ANNUAL_REPORT_FAILED',
        timeout: 120_000,
        maxBuffer: 5 * 1024 * 1024,
        apiKey: opts.apiKey,
      })
      if (opts.json) console.log(JSON.stringify({ success: true, action: 'annual-report.generate', year: reportYear }))
      else console.log(stdout)
    })
}
