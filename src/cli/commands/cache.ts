// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import { runPythonScript, parseCliInteger } from '../context.js'

export function registerCache(program: Command): void {

// ==================== cache（数据库缓存管理） ====================
// 2026-10-27：解密数据库缓存（首次全量导出明文，后续查询无解密开销）。
// 环境变量控制：WEFLOW_CACHE_ENABLED=1 开启，未设置或其他值则关闭（默认关闭）。
// 安全警告：缓存目录包含完全明文的数据库，仅在本地开发环境使用。
const cacheProgram = program
  .command('cache')
  .description('数据库缓存管理（环境变量 WEFLOW_CACHE_ENABLED=1 开启）')

cacheProgram
  .command('status')
  .description('查看缓存状态')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const stdout = await runPythonScript('scripts/manage_cache.py', ['status', ...(opts.json ? ['--json'] : [])], {
      json: opts.json, prefix: '✗ ',
      timeout: 30_000, maxBuffer: 1024 * 1024,
    })
    if (opts.json) {
      const result = JSON.parse(stdout)
      console.log(JSON.stringify(result))
    } else {
      console.log(stdout.trim())
    }
  })

cacheProgram
  .command('enable')
  .description('开启缓存（显示安全警告与环境变量设置方法）')
  .action(async () => {
    console.log(chalk.yellow(`
⚠️  数据库缓存安全警告

开启缓存后，解密后的聊天记录会以明文形式存储在：
  %TEMP%\\weflow-cli-cache\\databases\\
  
任何能读取该目录的进程都能看到聊天内容。

建议：
  ✅ 仅在本地开发环境使用
  ❌ 不要把缓存目录同步到云盘（OneDrive / iCloud 等）
  🔒 定期清理缓存（weflow-cli cache clear）
  🔒 离开电脑时锁屏

开启方法（设置环境变量）：

  PowerShell:
    $env:WEFLOW_CACHE_ENABLED = '1'
    
  CMD:
    set WEFLOW_CACHE_ENABLED=1
    
  持久化（Windows 系统环境变量）：
    setx WEFLOW_CACHE_ENABLED 1
    
验证：
    weflow-cli cache status
`))
  })

cacheProgram
  .command('disable')
  .description('关闭缓存（显示环境变量清理方法）')
  .action(async () => {
    console.log(chalk.cyan(`
关闭缓存（清除环境变量）：

  PowerShell（当前会话）:
    $env:WEFLOW_CACHE_ENABLED = ''
    
  CMD（当前会话）:
    set WEFLOW_CACHE_ENABLED=
    
  持久化（Windows 系统环境变量）：
    reg delete HKCU\\Environment /v WEFLOW_CACHE_ENABLED /f
    
验证：
    weflow-cli cache status

注意：关闭后不会自动删除已有缓存，需要手动清理：
    weflow-cli cache clear
`))
  })

cacheProgram
  .command('clear')
  .description('清空所有缓存')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const stdout = await runPythonScript('scripts/manage_cache.py', ['clear', ...(opts.json ? ['--json'] : [])], {
      json: opts.json, prefix: '✗ ',
      timeout: 30_000, maxBuffer: 1024 * 1024,
    })
    if (opts.json) {
      const result = JSON.parse(stdout)
      console.log(JSON.stringify(result))
    } else {
      console.log(stdout.trim())
    }
  })

cacheProgram
  .command('list')
  .description('列出所有缓存文件')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    const stdout = await runPythonScript('scripts/manage_cache.py', ['list', ...(opts.json ? ['--json'] : [])], {
      json: opts.json, prefix: '✗ ',
      timeout: 30_000, maxBuffer: 1024 * 1024,
    })
    console.log(stdout.trim())
  })

cacheProgram
  .command('prune <days>')
  .description('删除超过指定天数未访问的缓存')
  .option('--json', '输出 JSON 格式')
  .action(async (days: string, opts) => {
    const daysNum = parseCliInteger(days, 'days', 1, 36_500, opts.json)
    const stdout = await runPythonScript('scripts/manage_cache.py', ['prune', String(daysNum), ...(opts.json ? ['--json'] : [])], {
      json: opts.json, prefix: '✗ ',
      timeout: 30_000, maxBuffer: 1024 * 1024,
    })
    if (opts.json) {
      const result = JSON.parse(stdout)
      console.log(JSON.stringify(result))
    } else {
      console.log(stdout.trim())
    }
  })
}
