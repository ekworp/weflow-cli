// 由 bin/weflow-cli.ts 拆分而来：联系人/群聊解析。
import chalk from 'chalk'
import { chatService } from '../services/chatService.js'
import { resolveTalker as resolveTalkerCore } from '../utils/talkerUtils.js'

/**
 * CLI 包装的 talker 解析 (wxid / 昵称 / 备注名 / 序号)。
 * 委托给 src/utils/talkerUtils 的核心实现，外加 chalk 友好输出。
 */
export async function resolveTalker(input: string, quiet = false, nonInteractive = false): Promise<string> {
  try {
    const result = await resolveTalkerCore(input, { interactive: !nonInteractive })
    // 显示解析结果（已知格式跳过打印）
    if (!quiet && !input.startsWith('wxid_') && !input.includes('@chatroom') && !input.includes('@openim')) {
      const isNum = /^\[?\d+\]?$/.test(input)
      const sessions = await chatService.listSessions(undefined, 50)
      const match = sessions.find(s => s.username === result)
      if (match) {
        const prefix = isNum ? `序号[${input.replace(/[\[\]]/g, '')}] ` : ''
        console.log(chalk.gray(`  → ${prefix}${match.displayName} (${match.username})`))
      }
    }
    return result
  } catch (e: any) {
    if (quiet) {
      console.log(JSON.stringify({ success: false, code: 'TALKER_RESOLUTION_FAILED', error: e.message }))
      process.exit(1)
    }
    console.log(chalk.red(`\n❌ ${e.message}\n`))
    process.exit(1)
  }
}
