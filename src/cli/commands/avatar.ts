// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import { join } from 'path'
import { getPythonCommand } from '../../utils/python.js'
import { createPythonProcessEnv, safeSubprocessError } from '../../utils/pythonProcessEnv.js'
import { resolvePackageRoot } from '../context.js'

export function registerAvatar(program: Command): void {

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
}
