// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { join } from 'path'
import { chatService } from '../../services/chatService.js'
import { whitelistService } from '../../services/whitelistService.js'
import { resolveTalker } from '../talker.js'

export function registerPrivacy(program: Command): void {

// ==================== whitelist ====================
const whitelistCmd = program
  .command('whitelist')
  .description('白名单管理 (不传参数显示列表)')

whitelistCmd
  .action(() => {
    const entries = whitelistService.getWhitelistEntries()
    if (entries.length === 0) {
      console.log(chalk.gray('白名单为空'))
      console.log(chalk.gray('使用 weflow-cli whitelist add <昵称> 添加'))
      return
    }
    console.log(chalk.cyan(`白名单 (${entries.length}):\n`))
    console.log(chalk.gray('序号  wxid                          昵称              添加时间'))
    console.log(chalk.gray('─'.repeat(80)))
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      const num = String(i + 1).padStart(2)
      const id = (e.wxid || '').padEnd(28)
      const name = (e.displayName || '').slice(0, 16).padEnd(16)
      const ts = e.addedAt ? new Date(e.addedAt).toLocaleString('zh-CN') : '-'
      console.log(`${num}  ${id} ${name} ${ts}`)
    }
  })

whitelistCmd
  .command('add <target>')
  .description('添加白名单 (支持 wxid/昵称/备注名/序号)')
  .option('--dry-run', '仅预览，不修改白名单')
  .option('--yes', '确认执行')
  .option('--json', '输出 JSON 格式')
  .action(async (target: string, opts) => {
    // 解析目标
    let wxid: string
    let displayName = target
    if (target.startsWith('wxid_') || target.includes('@chatroom') || target.includes('@openim')) {
      wxid = target
    } else {
      try {
        wxid = await resolveTalker(target, !!opts.json, !!opts.json)
        const sessions = await chatService.listSessions(undefined, 50)
        const match = sessions.find(s => s.username === wxid)
        if (match) displayName = match.displayName || target
      } catch (e: any) {
        if (opts.json) console.log(JSON.stringify({ success: false, code: 'TALKER_RESOLUTION_FAILED', error: e.message }))
        else console.log(chalk.red(`✗ ${e.message}`))
        if (opts.json) process.exit(1)
        return
      }
    }

    // 检查是否已在名单中
    if (whitelistService.isAllowed(wxid)) {
      if (opts.json) console.log(JSON.stringify({ success: true, action: 'whitelist.add', changed: false, target: { wxid, displayName } }))
      else console.log(chalk.yellow(`"${displayName}" (${wxid}) 已在白名单中`))
      return
    }

    // 黑名单中的目标禁止加入白名单
    if (whitelistService.isBlocked(wxid)) {
      if (opts.json) {
        console.log(JSON.stringify({ success: false, code: 'TARGET_BLOCKED', error: '目标位于黑名单中', target: { wxid, displayName } }))
        process.exit(1)
      }
      console.log(chalk.red(`\n❌ "${displayName}" (${wxid}) 在黑名单中, 禁止加入白名单`))
      console.log(chalk.gray(`  先解除: weflow-cli blacklist rm ${wxid}\n`))
      return
    }

    const preview = { action: 'whitelist.add', target: { wxid, displayName } }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify({ success: true, dryRun: true, ...preview }))
      else console.log(chalk.cyan(`将添加 "${displayName}" (${wxid}) 到白名单`))
      return
    }
    if (opts.json && !opts.yes) {
      console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认添加白名单', ...preview }))
      process.exit(1)
    }

    // 三重确认
    if (!opts.yes) {
      console.log(chalk.cyan(`\n⚠️  即将添加以下联系人到白名单:`))
      console.log(chalk.white(`  昵称: ${displayName}`))
      console.log(chalk.gray(`  wxid: ${wxid}`))
      console.log(chalk.yellow(`  添加后，该联系人可向你收发消息\n`))

      const { q1 } = await inquirer.prompt([{
        type: 'confirm',
        name: 'q1',
        message: `确认添加 "${displayName}" 到白名单？`,
        default: false,
      }])
      if (!q1) { console.log(chalk.gray('已取消')); return }

      const { q2 } = await inquirer.prompt([{
        type: 'input',
        name: 'q2',
        message: `请输入 "确认" 以继续:`,
      }])
      if (q2 !== '确认') { console.log(chalk.gray('已取消')); return }
    }

    whitelistService.addDirect(wxid, displayName)
    if (opts.json) console.log(JSON.stringify({ success: true, changed: true, ...preview }))
    else console.log(chalk.green(`\n✓ 已添加 "${displayName}" (${wxid}) 到白名单`))
  })

whitelistCmd
  .command('rm <wxid>')
  .description('移除白名单中的 wxid')
  .option('--dry-run', '仅预览，不修改白名单')
  .option('--yes', '确认执行')
  .option('--json', '输出 JSON 格式')
  .action(async (wxid: string, opts) => {
    const name = whitelistService.lookupName(wxid)
    const exists = whitelistService.isAllowed(wxid)
    const preview = { action: 'whitelist.remove', target: { wxid, displayName: name } }
    if (!exists) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'NOT_FOUND', error: '目标不在白名单中', ...preview }))
      else console.log(chalk.yellow(`未找到: ${wxid}`))
      if (opts.json) process.exit(1)
      return
    }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify({ success: true, dryRun: true, ...preview }))
      else console.log(chalk.cyan(`将从白名单移除: ${name} (${wxid})`))
      return
    }
    if (opts.json && !opts.yes) {
      console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认移除白名单', ...preview }))
      process.exit(1)
    }
    if (!opts.yes) {
      const { confirmed } = await inquirer.prompt([{
        type: 'confirm', name: 'confirmed', message: `确认从白名单移除 "${name}"？`, default: false,
      }])
      if (!confirmed) { console.log(chalk.gray('已取消')); return }
    }
    if (whitelistService.remove(wxid)) {
      if (opts.json) console.log(JSON.stringify({ success: true, changed: true, ...preview }))
      else console.log(chalk.green(`✓ 已移除: ${name} (${wxid})`))
    }
  })

whitelistCmd
  .command('clear')
  .description('清空白名单')
  .option('--dry-run', '仅预览，不清空白名单')
  .option('--yes', '确认清空白名单')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    if (opts.dryRun) {
      const preview = { success: true, dryRun: true, action: 'whitelist.clear', entryCount: whitelistService.getWhitelistEntries().length }
      if (opts.json) console.log(JSON.stringify(preview))
      else console.log(chalk.cyan(`白名单清空预览：将移除 ${preview.entryCount} 项。`))
      return
    }
    if (!opts.yes) {
      if (opts.json) {
        console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认清空白名单' }))
        process.exit(1)
      }
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: '确定要清空所有白名单吗？',
        default: false,
      }])
      if (!confirm) return
    }
    whitelistService.clear()
    if (opts.json) console.log(JSON.stringify({ success: true, action: 'whitelist.clear' }))
    else console.log(chalk.green('✓ 白名单已清空'))
  })

whitelistCmd
  .command('list')
  .description('以机器可读格式显示白名单')
  .option('--json', '输出 JSON 格式，包含本地敏感标识')
  .action((opts) => {
    const entries = whitelistService.getWhitelistEntries()
    if (opts.json) console.log(JSON.stringify({ success: true, entries }, null, 2))
    else console.log(entries.map(entry => `${entry.wxid}\t${entry.displayName || ''}`).join('\n'))
  })

// ==================== blacklist ====================
const blacklistCmd = program
  .command('blacklist')
  .description('黑名单管理 (绝对禁止收发, 优先级高于白名单; 不传参数显示列表)')

blacklistCmd
  .action(() => {
    const entries = whitelistService.getBlacklistEntries()
    if (entries.length === 0) {
      console.log(chalk.gray('黑名单为空'))
      console.log(chalk.gray('使用 weflow-cli blacklist add <昵称/wxid> 添加'))
      return
    }
    console.log(chalk.red(`黑名单 (${entries.length}):\n`))
    console.log(chalk.gray('序号  wxid                          昵称              添加时间'))
    console.log(chalk.gray('─'.repeat(80)))
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      const num = String(i + 1).padStart(2)
      const id = (e.wxid || '').padEnd(28)
      const name = (e.displayName || '').slice(0, 16).padEnd(16)
      const ts = e.addedAt ? new Date(e.addedAt).toLocaleString('zh-CN') : '-'
      console.log(`${num}  ${id} ${name} ${ts}`)
    }
  })

blacklistCmd
  .command('add <target>')
  .description('添加到黑名单 (自动从白名单移除)')
  .option('-r, --reason <text>', '拉黑原因 (可选)')
  .option('--dry-run', '仅预览，不修改黑名单')
  .option('--yes', '确认执行')
  .option('--json', '输出 JSON 格式')
  .action(async (target: string, opts) => {
    let wxid: string
    let displayName = target
    if (target.startsWith('wxid_') || target.includes('@chatroom') || target.includes('@openim')) {
      wxid = target
    } else {
      try {
        wxid = await resolveTalker(target, !!opts.json, !!opts.json)
        const sessions = await chatService.listSessions(undefined, 50)
        const match = sessions.find(s => s.username === wxid)
        if (match) displayName = match.displayName || target
      } catch (e: any) {
        if (opts.json) console.log(JSON.stringify({ success: false, code: 'TALKER_RESOLUTION_FAILED', error: e.message }))
        else console.log(chalk.red(`✗ ${e.message}`))
        if (opts.json) process.exit(1)
        return
      }
    }

    if (whitelistService.isBlocked(wxid)) {
      if (opts.json) console.log(JSON.stringify({ success: true, action: 'blacklist.add', changed: false, target: { wxid, displayName } }))
      else console.log(chalk.yellow(`"${displayName}" (${wxid}) 已在黑名单中`))
      return
    }

    const preview = { action: 'blacklist.add', target: { wxid, displayName }, reason: opts.reason || null }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify({ success: true, dryRun: true, ...preview }))
      else console.log(chalk.cyan(`将添加 "${displayName}" (${wxid}) 到黑名单`))
      return
    }
    if (opts.json && !opts.yes) {
      console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认添加黑名单', ...preview }))
      process.exit(1)
    }

    if (!opts.yes) {
      console.log(chalk.cyan(`\n⚠️  即将拉黑以下联系人:`))
      console.log(chalk.white(`  昵称: ${displayName}`))
      console.log(chalk.gray(`  wxid: ${wxid}`))
      if (opts.reason) console.log(chalk.gray(`  原因: ${opts.reason}`))
      console.log(chalk.yellow(`  拉黑后, 该联系人绝对禁止收发消息 (即使误加白名单也拦截)\n`))

      const { q1 } = await inquirer.prompt([{
        type: 'confirm',
        name: 'q1',
        message: `确认拉黑 "${displayName}"？`,
        default: false,
      }])
      if (!q1) { console.log(chalk.gray('已取消')); return }
    }

    whitelistService.blockDirect(wxid, displayName, opts.reason)
    if (opts.json) console.log(JSON.stringify({ success: true, changed: true, ...preview }))
    else console.log(chalk.green(`\n✓ 已拉黑 "${displayName}" (${wxid})`))
  })

blacklistCmd
  .command('rm <wxid>')
  .description('从黑名单移除')
  .option('--dry-run', '仅预览，不修改黑名单')
  .option('--yes', '确认执行')
  .option('--json', '输出 JSON 格式')
  .action(async (wxid: string, opts) => {
    const name = whitelistService.lookupName(wxid)
    const exists = whitelistService.isBlocked(wxid)
    const preview = { action: 'blacklist.remove', target: { wxid, displayName: name } }
    if (!exists) {
      if (opts.json) console.log(JSON.stringify({ success: false, code: 'NOT_FOUND', error: '目标不在黑名单中', ...preview }))
      else console.log(chalk.yellow(`未在黑名单中找到: ${wxid}`))
      if (opts.json) process.exit(1)
      return
    }
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify({ success: true, dryRun: true, ...preview }))
      else console.log(chalk.cyan(`将从黑名单移除: ${name} (${wxid})`))
      return
    }
    if (opts.json && !opts.yes) {
      console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认移除黑名单', ...preview }))
      process.exit(1)
    }
    if (!opts.yes) {
      const { confirmed } = await inquirer.prompt([{
        type: 'confirm', name: 'confirmed', message: `确认从黑名单移除 "${name}"？`, default: false,
      }])
      if (!confirmed) { console.log(chalk.gray('已取消')); return }
    }
    if (whitelistService.unblock(wxid)) {
      if (opts.json) console.log(JSON.stringify({ success: true, changed: true, ...preview }))
      else console.log(chalk.green(`✓ 已从黑名单移除: ${name} (${wxid})`))
    }
  })

blacklistCmd
  .command('clear')
  .description('清空黑名单')
  .option('--dry-run', '仅预览，不清空黑名单')
  .option('--yes', '确认清空黑名单')
  .option('--json', '输出 JSON 格式')
  .action(async (opts) => {
    if (opts.dryRun) {
      const preview = { success: true, dryRun: true, action: 'blacklist.clear', entryCount: whitelistService.getBlacklistEntries().length }
      if (opts.json) console.log(JSON.stringify(preview))
      else console.log(chalk.cyan(`黑名单清空预览：将移除 ${preview.entryCount} 项。`))
      return
    }
    if (!opts.yes) {
      if (opts.json) {
        console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', error: '使用 --yes 确认清空黑名单' }))
        process.exit(1)
      }
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: '确定要清空所有黑名单吗？',
        default: false,
      }])
      if (!confirm) return
    }
    whitelistService.clearBlacklist()
    if (opts.json) console.log(JSON.stringify({ success: true, action: 'blacklist.clear' }))
    else console.log(chalk.green('✓ 黑名单已清空'))
  })

blacklistCmd
  .command('list')
  .description('以机器可读格式显示黑名单')
  .option('--json', '输出 JSON 格式，包含本地敏感标识')
  .action((opts) => {
    const entries = whitelistService.getBlacklistEntries()
    if (opts.json) console.log(JSON.stringify({ success: true, entries }, null, 2))
    else console.log(entries.map(entry => `${entry.wxid}\t${entry.displayName || ''}`).join('\n'))
  })
}
