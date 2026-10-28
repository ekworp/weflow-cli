// 由 bin/weflow-cli.ts 拆分而来：装配 commander 程序。
import { Command } from 'commander'
import { CLI_VERSION } from './context.js'
import { registerCapabilities } from './commands/capabilities.js'
import { registerSetup } from './commands/setup.js'
import { registerInit } from './commands/init.js'
import { registerConfig } from './commands/config.js'
import { registerChat } from './commands/chat.js'
import { registerSync } from './commands/sync.js'
import { registerLedger } from './commands/ledger.js'
import { registerCache } from './commands/cache.js'
import { registerAvatar } from './commands/avatar.js'
import { registerExtras } from './commands/extras.js'
import { registerContacts } from './commands/contacts.js'
import { registerExport } from './commands/export.js'
import { registerWechatDb } from './commands/wechat-db.js'
import { registerPrivacy } from './commands/privacy.js'
import { registerAudit } from './commands/audit.js'
import { registerSns } from './commands/sns.js'
import { registerFav } from './commands/fav.js'
import { registerMessaging } from './commands/messaging.js'
import { registerReport } from './commands/report.js'
import { registerKnowledge } from './commands/knowledge.js'
import { registerInsights } from './commands/insights.js'
import { registerWeread } from './commands/weread.js'
import { registerSearch } from './commands/search.js'
import { registerAnnualReport } from './commands/annual-report.js'
import { registerAssistant } from './commands/assistant.js'
import { registerNotes } from './commands/notes.js'
import { registerPdfNotes } from './commands/pdf-notes.js'
import { registerTodos } from './commands/todos.js'
import { registerDaily } from './commands/daily.js'
import { registerSkill } from './commands/skill.js'
import { registerScene } from './commands/scene.js'
import { registerAssistantDaemon } from './commands/assistant-daemon.js'
import { registerPanel } from './commands/panel.js'
import { registerPersonal } from './commands/personal.js'
import { registerDailyServer } from './commands/daily-server.js'
import { registerMcpConfig } from './commands/mcp-config.js'
import { registerCheck } from './commands/check.js'

export function buildProgram(): Command {
  const program = new Command()

  program
    .name('weflow-cli')
    .description('WeFlow CLI - 微信聊天记录命令行查询与导出工具')
    .version(CLI_VERSION)

  registerCapabilities(program)
  registerSetup(program)
  registerInit(program)
  registerConfig(program)
  registerChat(program)
  registerSync(program)
  registerLedger(program)
  registerCache(program)
  registerAvatar(program)
  registerExtras(program)
  registerContacts(program)
  registerExport(program)
  registerWechatDb(program)
  registerPrivacy(program)
  registerAudit(program)
  registerSns(program)
  registerFav(program)
  registerMessaging(program)
  registerReport(program)
  registerKnowledge(program)
  registerInsights(program)
  registerWeread(program)
  registerSearch(program)
  registerAnnualReport(program)
  registerAssistant(program)
  registerNotes(program)
  registerPdfNotes(program)
  registerTodos(program)
  registerDaily(program)
  registerSkill(program)
  registerScene(program)
  registerAssistantDaemon(program)
  registerPanel(program)
  registerPersonal(program)
  registerDailyServer(program)
  registerMcpConfig(program)
  registerCheck(program)

  return program
}
