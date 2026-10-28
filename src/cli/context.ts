// 由 bin/weflow-cli.ts 拆分而来：跨命令组共用的 CLI 辅助函数。
import chalk from 'chalk'
import inquirer from 'inquirer'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { getPythonCommand } from '../utils/python.js'
import { createPythonProcessEnv, safeSubprocessError } from '../utils/pythonProcessEnv.js'
import { DateRangeError, parseLocalDateOrIso } from '../utils/dateRange.js'
import { resolvePackageRoot as resolvePackageRootFrom } from '../utils/packageRoot.js'

export function resolvePackageRoot(): string {
  return resolvePackageRootFrom(import.meta.url)
}

/**
 * Version reported by `--version` and `capabilities`.
 *
 * Read from package.json instead of written here. A literal has to be updated
 * by hand on every release, and when that is forgotten `--version` lies about
 * what is installed - which is exactly what happened: the 1.6.0 package
 * shipped a hardcoded `1.5.1`, so a user's bug report could not be told apart
 * from a stale install, and diagnosing it needed a clean install to disprove.
 */
export function resolveCliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(resolvePackageRoot(), 'package.json'), 'utf8'))
    return String(pkg.version || '0.0.0')
  } catch {
    return '0.0.0'
  }
}

export const CLI_VERSION = resolveCliVersion()

export function pythonProcessEnv(apiKey?: string, variable = 'DEEPSEEK_API_KEY'): NodeJS.ProcessEnv {
  return createPythonProcessEnv(apiKey ? { [variable]: apiKey } : {})
}

export function parseCliInteger(value: unknown, field: string, minimum: number, maximum: number, json = false): number {
  const parsed = Number(value)
  if (Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum) return parsed
  const error = `${field} 必须是 ${minimum}-${maximum} 的整数`
  if (json) console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', field, error }))
  else console.log(chalk.red(error))
  process.exit(1)
}

/** 校验一个"只能是这几个值之一"的参数。与 `parseCliInteger` / `requireCliDate` 同一约定：
 * `--json` 时错误也得是一份 JSON —— 否则机器调用方在 stdout 上拿到的是彩色散文，解析不了。
 *
 * 抽成一个是有理由的：`--line` 的校验原本在四个命令里各写了一遍，其中三处只打散文（`vault rag`、
 * 顶层 `search`、`chat`）—— 同一份判断写四遍，就有三遍漏掉了 `--json` 分支。
 * 错误文案由 choices 生成，保证与原来逐字一致（'line 必须是 wiki、chat 或 all'）。
 */
export function requireCliChoice(value: unknown, choices: readonly string[], field: string, json = false): string {
  const text = String(value)
  if (choices.includes(text)) return text
  const error = `${field} 必须是 ${choices.slice(0, -1).join('、')} 或 ${choices[choices.length - 1]}`
  if (json) console.log(JSON.stringify({ success: false, code: 'INVALID_ARGUMENT', field, error }))
  else console.log(chalk.red(error))
  process.exit(1)
}

export function requireCliDate(value: string, json = false): string {
  try {
    parseLocalDateOrIso(value)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DateRangeError('INVALID_DATE', '日期无效')
    return value
  } catch {
    if (json) console.log(JSON.stringify({ success: false, code: 'INVALID_DATE', field: 'date' }))
    else console.log(chalk.red('date 必须是有效的 YYYY-MM-DD 日期'))
    process.exit(1)
  }
}

export async function runConfirmedPythonMutation(options: {
  action: string
  script: string
  args: string[]
  cliOptions: { dryRun?: boolean; yes?: boolean; json?: boolean }
  preview: Record<string, unknown>
  confirmationMessage: string
  apiKey?: string
  apiKeyVariable?: string
  timeout?: number
}): Promise<void> {
  const preview = { success: true, dryRun: true, action: options.action, ...options.preview }
  if (options.cliOptions.dryRun) {
    if (options.cliOptions.json) console.log(JSON.stringify(preview))
    else console.log(chalk.cyan(options.confirmationMessage.replace(/^确认/, '预览：')))
    return
  }
  if (!options.cliOptions.yes) {
    if (options.cliOptions.json) {
      console.log(JSON.stringify({ ...preview, success: false, dryRun: false, code: 'CONFIRMATION_REQUIRED' }))
      process.exit(1)
    }
    const { confirmed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmed',
      message: options.confirmationMessage,
      default: false,
    }])
    if (!confirmed) {
      console.log(chalk.gray('已取消'))
      return
    }
  }

  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  try {
    const { stdout } = await promisify(execFile)(getPythonCommand(), [options.script, ...options.args], {
      timeout: options.timeout || 120_000,
      maxBuffer: 50 * 1024 * 1024,
      env: pythonProcessEnv(options.apiKey, options.apiKeyVariable || 'DEEPSEEK_API_KEY'),
    })
    if (options.cliOptions.json) console.log(JSON.stringify({ success: true, action: options.action }))
    else console.log(stdout)
  } catch (error) {
    if (options.cliOptions.json) {
      console.log(JSON.stringify({ success: false, code: 'PYTHON_MUTATION_FAILED', action: options.action, error: safeSubprocessError(error) }))
    } else {
      console.error(chalk.red(`\n✗ ${safeSubprocessError(error)}`))
    }
    process.exit(1)
  }
}

export async function openLocalUrl(url: string): Promise<void> {
  const { spawn } = await import('child_process')
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

export async function getDailyReaderStatus(port: number): Promise<{ running: boolean; date: string | null }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(500) })
    const status = await response.json() as { ok?: boolean; service?: string; date?: string }
    const running = response.ok && status.ok === true && status.service === 'weflow-daily-reader'
    return { running, date: running && status.date ? status.date : null }
  } catch {
    return { running: false, date: null }
  }
}

export async function startDetachedDailyReader(script: string, date: string, port: number): Promise<{
  success: boolean
  started: boolean
  alreadyRunning?: boolean
  code?: string
}> {
  const existing = await getDailyReaderStatus(port)
  if (existing.running) {
    if (existing.date === date) return { success: true, started: false, alreadyRunning: true }
    return { success: false, started: false, code: 'DAILY_READER_PORT_IN_USE' }
  }

  const dateDir = join(resolvePackageRoot(), 'output', 'biz-daily', date)
  if (!existsSync(dateDir)) return { success: false, started: false, code: 'DAILY_READER_DATE_NOT_FOUND' }

  const { spawn } = await import('child_process')
  const child = spawn(getPythonCommand(), [script, '--date', date, '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: pythonProcessEnv(),
  })
  let spawnFailed = false
  child.once('error', () => { spawnFailed = true })

  for (let attempt = 0; attempt < 30; attempt++) {
    if (spawnFailed || child.exitCode !== null) break
    const status = await getDailyReaderStatus(port)
    if (status.running && status.date === date) {
      child.unref()
      return { success: true, started: true }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  if (child.exitCode === null && !child.killed) child.kill()
  return { success: false, started: false, code: 'DAILY_READER_START_FAILED' }
}

/**
 * 尝试从 WeFlow 桌面版配置中读取已保存的密钥
 */
export function tryReadWeFlowKey(): string | null {
  const candidates = [
    join(homedir(), 'AppData', 'Roaming', 'WeFlow', 'WeFlow-config.json'),
    join(homedir(), 'AppData', 'Roaming', 'weflow', 'WeFlow-config.json'),
    join(homedir(), '.weflow', 'config.json'),
  ]

  for (const configPath of candidates) {
    try {
      if (!existsSync(configPath)) continue
      const raw = readFileSync(configPath, 'utf8')
      const config = JSON.parse(raw)

      // WeFlow 使用 electron-store，decryptKey 可能是明文或加密的
      let key = config.decryptKey || ''
      // 如果是 lock: 前缀，说明是加密的，无法直接使用
      if (typeof key === 'string' && key.startsWith('lock:')) {
        continue
      }
      // 如果是 safe: 前缀，说明是 safeStorage 加密的，也无法直接使用
      if (typeof key === 'string' && key.startsWith('safe:')) {
        continue
      }
      // 明文 key
      if (typeof key === 'string' && key.length === 64) {
        return key
      }

      // 检查 wxidConfigs 中的 key
      const wxidConfigs = config.wxidConfigs || {}
      for (const [_wxid, cfg] of Object.entries(wxidConfigs) as [string, any][]) {
        const cfgKey = cfg.decryptKey || ''
        if (typeof cfgKey === 'string' && cfgKey.length === 64 && !cfgKey.startsWith('lock:') && !cfgKey.startsWith('safe:')) {
          return cfgKey
        }
      }
    } catch {
      continue
    }
  }
  return null
}

  // 辅助函数
  export async function runPythonCmd(script: string, args: string[], apiKey?: string, apiKeyVariable = 'DEEPSEEK_API_KEY') {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    try {
      const { stdout } = await execFileAsync(getPythonCommand(), [script, ...args], {
        timeout: 120_000, maxBuffer: 5 * 1024 * 1024,
        env: pythonProcessEnv(apiKey, apiKeyVariable),
      })
      console.log(stdout)
    } catch (e: any) {
      console.error(chalk.red(`\n✗ ${safeSubprocessError(e)}`))
      process.exit(1)
    }
  }

  // Helper: run a Python script
  export async function runPython(script: string, args: string[], apiKey?: string): Promise<void> {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const pkgRoot = resolvePackageRoot()
    const pyArgs = [join(pkgRoot, script), ...args]
    try {
      const { stdout } = await execFileAsync(getPythonCommand(), pyArgs, {
        timeout: 120_000, maxBuffer: 5 * 1024 * 1024,
        env: pythonProcessEnv(apiKey),
      })
      console.log(stdout)
    } catch (e: any) {
      console.error(chalk.red(`\n✗ ${safeSubprocessError(e)}`))
      process.exit(1)
    }
  }

export const defaultDailyDate = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
