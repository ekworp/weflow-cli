// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import { WECHAT_VERIFIED } from '../../services/wechatCompat.js'
import { CLI_VERSION } from '../context.js'

export function registerCapabilities(program: Command): void {

program
  .command('capabilities')
  .description('输出 AI 可调用的功能能力清单')
  .option('--json', '输出 JSON 格式')
  .action((opts) => {
    const data = {
      schema: 'weflow-capabilities/v1',
      version: CLI_VERSION,
      // D-130：本包最后用真实数据验证过的微信版本（单一事实源 wechatCompat.ts）。
      // check 的判定也从同一处读；发布清单要求 CHANGELOG 每版记录（来源就是这里）。
      compatibility: {
        wechat: {
          verifiedVersion: WECHAT_VERIFIED.version,
          verifiedAt: WECHAT_VERIFIED.verifiedAt,
        },
      },
      read: {
        sessions: { cli: 'sessions --json', mcp: 'wechat.list_sessions' },
        messages: { cli: 'messages <talker> --json', mcp: 'wechat.export_messages' },
        contacts: { cli: 'contacts --json', mcp: 'wechat.list_contacts', localIdentifiersInModelContext: false },
        exports: {
          cli: 'export <talker> <json|txt|html|excel>',
          mcp: 'wechat.export_messages',
          versionedContract: 'weflow-message/v1',
          rawContractPreserved: true,
          coverage: ['requestedFrom', 'requestedTo', 'requestedLimit', 'returned', 'mayHaveMore', 'oldestCreateTime', 'newestCreateTime'],
          incrementalRead: {
            mode: 'overlapping-time-window',
            stableCursor: false,
            // D-027 的另一半：光写 false 是句结论，这里把 false → true 的**路径**
            // 摊开。probe 指向的那条命令会实测 NT 数据侧判据（采样有界、结果里
            // 自带 exhaustive=false）；backends 里的字段是代码事实，改读取器时同步改。
            cursorReadiness: {
              probe: 'sync cursor-probe --json',
              criteria: [
                'stable-identity: 每条消息都有非零且不重复的 server_id（缺失时身份退化为按分片的 localId+createTime，不能跨分片续读）',
                'globally-comparable-order: 跨分片合并的顺序键可比（现在是 createTime+localId，localId 不跨分片可比）',
                'window-pushdown: 时间窗下推进读取（现在只有 NT 后端）',
                'coverage-report: 后端能报告本次读取是否完整（现在只有 NT 的分片报告）',
                'every-backend: 上述各项在所有消息后端同时成立（D-027 的总门）',
              ],
              backends: {
                'nt': { identity: 'server_id（退化为 localId+createTime）', windowPushdown: true, coverageReport: true, liveProbe: true },
                'raw-sqlite-4x': { identity: 'MsgSvrID 列被读取、覆盖率未实测', windowPushdown: false, coverageReport: false, liveProbe: false },
                'wcdb-4x': { identity: 'server_id 随原生 API 返回、未实测', windowPushdown: false, coverageReport: false, liveProbe: false },
                'legacy-3x': { identity: 'MsgSvrID 列被读取、覆盖率未实测', windowPushdown: false, coverageReport: false, liveProbe: false },
              },
              advertisedWhen: 'every backend reports true on every criterion above',
            },
          },
        },
        favorites: {
          cli: 'fav list --json',
          export: 'fav export <markdown|json> --json-result --output <local-file>',
          mcp: 'wechat.search_favorites',
        },
        configuration: { cli: 'config show --json', secretsIncluded: false },
        accessControl: {
          whitelist: 'whitelist list --json',
          blacklist: 'blacklist list --json',
          sensitiveLocalIdentifiers: true,
        },
        moments: {
          timeline: 'sns timeline --json',
          users: 'sns users --json',
          stats: 'sns stats --json',
        },
        daily: {
          preview: 'daily --no-ai --dry-run --json',
          execute: 'daily --no-ai --yes --json',
          confirmationRequired: true,
          logs: 'stderr',
          result: 'stdout',
        },
        dailyReader: { cli: 'daily-server --status --json' },
        dailyStats: { cli: 'daily-stats --json' },
        // 只读、纯本地、不调模型。**故意没有 mcp 那一栏**（D-062）：它给的是关于第三方的推断
        // ——谁在被冷落、你会失去谁 —— 所以不进助手、不进 MCP、不喂模型。
        bonds: { cli: 'bonds --json', mcp: null, leavesTheMachine: false },
        // `check --report` 是同一份事实的**给人版**（已脱敏、可直接贴给 AI 或 issue），
        // 所以它跟 `--json` 并列在这里：外部程序按这条能力去找"怎么拿诊断"，不该只知道 JSON 那条。
        diagnostics: { cli: 'check --json', report: 'check --report', leavesTheMachine: false },
        todos: { cli: 'todos list --json' },
        // 2026-09-29 三个界面对齐时新开的读取能力（D-058）。逐个写清它会不会出境，
        // 因为其中两个会——`fetch_article` 白名单 + 逐跳复检，`search_public` 没有任何守卫。
        review: { cli: 'review ...', mcp: 'wechat.get_review', writesReport: true },
        concepts: { cli: 'wiki ...', mcp: 'wechat.get_concepts' },
        articleFetch: {
          cli: null,   // 没有对应的 CLI 命令：它本来就是为模型准备的读取能力
          mcp: 'wechat.fetch_article',
          network: true,
          allowlist: 'https only, host must be exactly mp.weixin.qq.com',
          redirectsReValidatedPerHop: true,
          confirmationRequired: false,
        },
        publicArticleSearch: {
          mcp: 'wechat.search_public',
          network: true,
          // **这条是如实的**：搜索词由模型决定、发到第三方搜索页，没有白名单也没有预览。
          // 它在该项目的边界内是被明确接受的残余风险（D-058），这里不能写成"无出境"。
          allowlist: null,
          modelAuthoredQueryLeavesTheMachine: true,
          confirmationRequired: false,
        },
        articleFormatting: { mcp: 'wechat.format_article', cli: null, writesNothing: true, network: false },
        themes: { mcp: 'wechat.list_themes', writesNothing: true },
        wikiLint: { cli: 'wiki lint --json', mcp: 'wechat.lint_wiki', readsLocalChat: false, writesNothing: true },
        skillCheck: { cli: 'skill check --json', mcp: 'wechat.check_skills', writesNothing: true },
        awaiting: {
          cli: 'awaiting --yes',
          preview: 'awaiting --dry-run --json',
          readsLocalChat: true,
          invokesAI: true,
          writesNothing: true,
          confirmationRequired: true,
        },
        draft: {
          cli: 'draft <会话> --yes --json',
          preview: 'draft <会话> --dry-run --json',
          readsLocalChat: true,
          invokesAI: true,
          // **它不发送任何东西**：只产出候选文本，回不回由人决定。
          // 这条要能被机器读到——`sendsNothing` 比 `writesNothing` 更要紧。
          writesNothing: true,
          sendsNothing: true,
          confirmationRequired: true,
        },
        knowledge: { cli: 'search <query> --yes --json', preview: 'search <query> --dry-run --json', output: 'json', mcp: 'wechat.search_articles' },
      },
      primitives: {
        decide: {
          cli: 'decide --request <file> --yes | decide --over <glob> --ask <text> --yes',
          preview: 'decide --dry-run',
          // 两条路的读法**不一样**，所以不能只写一个 false：
          // --request 完全由调用方给，--over 会读匹配到的本地文件。
          readsLocalData: { request: false, over: true },
          invokesAI: true,
          sendsCallerProvidedState: true,
          confirmationRequired: true,
          mcpExposed: false,
          whyNotMcp: 'an MCP client must not be able to drive local outbound calls',
        },
      },
      workflows: {
        initialization: {
          preview: 'init --dry-run --json',
          execute: 'init',
          interactiveRequired: true,
          machineExecutionAllowed: false,
          previewExposesPaths: false,
        },
        evidencePackage: { cli: 'evidence <talker> --json --non-interactive', localOnly: true },
        sync: {
          preview: 'sync run <talker> --dry-run --json',
          execute: 'sync run <talker> --yes --json',
          status: 'sync status [<talker>] --json',
          verify: 'sync verify <talker> --json',
          confirmationRequired: true,
          readsLocalData: true,
          invokesAI: false,
          sideEffects: ['local-checkpoint-file'],
          stateSchema: 'weflow-sync/v1',
          jobSchema: 'weflow-job/v1',
          stateLocation: 'local-user-config-dir',
          previewResolvesTalker: false,
          previewExposesLocalPaths: false,
          // D-027: a stable cursor must be backed by every database backend
          // before it is advertised. This exposes overlapping windows only.
          stableCursor: false,
          coverageValues: ['complete', 'unverified', 'partial'],
          partialCompletesSuccessfully: false,
        },
        aiAnalysis: {
          preview: 'evidence-review <talker> --dry-run --json',
          execute: 'evidence-review <talker> --yes --json',
          explicitOptIn: true,
          cloudRequiresAllowCloud: true,
          confirmationRequired: true,
        },
        messaging: {
          preview: 'send <target> <message> --dry-run --json',
          execute: 'send <target> <message> --yes --json',
          confirmationRequired: true,
          channel: 'official-bot-existing-conversation',
        },
        todoMutations: {
          preview: 'todos <done|undone|rm> <id> --dry-run --json',
          execute: 'todos <done|undone|rm> <id> --yes --json',
          confirmationRequired: true,
        },
        skills: {
          list: 'skill list [--query <q>] --json',
          show: 'skill show <id> --json',
          check: 'skill check --json',
          readOnly: true,
          // 技能是**资料**，不是插件：助手只把它当提示词/正文读，不执行里面的脚本，
          // 也不因为装了技能就多出任何工具（P4 验收标准：扩展读不到配置与数据库）。
          installsAnything: false,
          executesSkillCode: false,
          grantsTools: false,
          directories: 'skillDirs config (default: ~/.claude/skills, ~/.weflow-cli/skills)',
          disable: 'config set skillDisabled <id,...>（技能自己也能写 enabled: false）',
        },
        scenes: {
          list: 'scene list --json',
          show: 'scene show <id> --json',
          preview: 'scene <add|remove|enable|disable|bind|unbind> … --dry-run --json',
          execute: 'scene <add|remove|enable|disable|bind|unbind> … --yes --json',
          confirmationRequired: true,
          // 场景只改**本机提示词预设**，不发消息、不读聊天、不调模型
          readsLocalChat: false,
          invokesAI: false,
          sendsNothing: true,
          stateLocation: 'local-user-config-dir',
          stateSchema: 'weflow-scenes/v1',
          modelWritable: false,
        },
        accessControlMutations: {
          preview: '<whitelist|blacklist> <add|rm> <target> --dry-run --json',
          execute: '<whitelist|blacklist> <add|rm> <target> --yes --json',
          confirmationRequired: true,
          sensitiveLocalIdentifiers: true,
        },
        secretConfiguration: {
          preview: 'config set-env <key> <environment> --dry-run --json',
          execute: 'config set-env <key> <environment> --yes --json',
          favoriteKeyPreview: 'fav set-key --from-env <environment> --dry-run --json',
          favoriteKeyExecute: 'fav set-key --from-env <environment> --yes --json',
          valuesInArguments: false,
          confirmationRequired: true,
        },
        databaseKeyReset: {
          preview: 'config forget-keys --dry-run --json',
          cli: 'config forget-keys --yes --json',
          confirmationRequired: true,
        },
        assistantDaemon: {
          status: 'assistant status --json',
          preview: 'assistant <start|stop> --dry-run --json',
          execute: 'assistant <start|stop> --yes --json',
          confirmationRequired: true,
        },
        localPanel: {
          status: 'panel --status --json',
          ask: 'panel --ask "<text>" --yes --json',
          preview: 'panel --dry-run --json',
          execute: 'panel --yes --json',
          confirmationRequired: true,
          opensLocalWindow: true,
          loopbackOnly: true,
          // 关掉窗口**不会**停掉助手——这件事必须能被机器读到，别让调用方以为退出即结束
          keepsAssistantRunningAfterClose: true,
        },
        messageChannelAuthentication: {
          loginPreview: 'login-wechat --dry-run --json',
          loginExecute: 'login-wechat --yes',
          loginInteractiveRequired: true,
          logoutPreview: 'logout-wechat --dry-run --json',
          logoutExecute: 'logout-wechat --yes --json',
          confirmationRequired: true,
        },
        interactiveKeyCapture: {
          previews: ['dbkey --dry-run --json', 'sns capture-key --dry-run --json'],
          executes: ['dbkey --yes', 'sns capture-key --yes'],
          interactiveRequired: true,
          machineExecutionAllowed: false,
        },
        foregroundMessageProcesses: {
          previews: ['listen --dry-run --json', 'assistant run --dry-run --json'],
          executes: ['listen --yes', 'assistant run --yes'],
          interactiveRequired: true,
          machineExecutionAllowed: false,
        },
        vaultSync: {
          preview: 'vault sync --dry-run --json',
          execute: 'vault sync --yes --json',
          confirmationRequired: true,
          previewExposesFileNames: false,
          resultExposesRemote: false,
        },
        vaultInitialization: {
          preview: 'vault init --path <local-directory> --dry-run --json',
          execute: 'vault init --path <local-directory> --yes --json',
          confirmationRequired: true,
          previewExposesPaths: false,
          overwritesManagedFiles: true,
        },
        semanticIndex: {
          preview: 'search-index --dry-run --json',
          execute: 'search-index --yes --json',
          fullRebuild: 'search-index --full --yes --json',
          confirmationRequired: true,
          sendsTextToEmbeddingProvider: true,
        },
        knowledgePipeline: {
          preview: 'pipeline run --no-ai --dry-run --json',
          execute: 'pipeline run --no-ai --yes --json',
          confirmationRequired: true,
          supportsSourceFilter: true,
          aiCanBeDisabled: true,
        },
        vaultContentMutations: {
          commands: ['vault enrich', 'vault notes', 'vault tag', 'vault sync-weread', 'vault promote ideas', 'vault promote all', 'wiki compile'],
          previewFlag: '--dry-run --json',
          executeFlag: '--yes --json',
          confirmationRequired: true,
          aiRequiresExplicitOptIn: true,
        },
        dailyFavoriteMutations: {
          commands: ['daily favorites sync', 'daily favorites add', 'daily favorites remove'],
          previewFlag: '--dry-run --json',
          executeFlag: '--yes --json',
          confirmationRequired: true,
          previewExposesArticleNames: false,
        },
        dailyReader: {
          status: 'daily-server --status --json',
          previewStart: 'daily-server --dry-run --json',
          executeStart: 'daily-server --yes --json',
          confirmationRequired: true,
          loopbackOnly: true,
        },
        reportGeneration: {
          commands: ['report', 'review', 'annual-report', 'chat-stats'],
          previewFlag: '--dry-run --json',
          executeFlag: '--yes --json',
          confirmationRequired: true,
          resultExposesContent: false,
        },
        todoExtraction: {
          preview: 'todos extract --days <n> --dry-run --json',
          execute: 'todos extract --days <n> --yes --json',
          confirmationRequired: true,
          sendsSelectedChatToAi: true,
          resultExposesTodoText: false,
        },
        vaultRag: {
          preview: 'vault rag <question> --dry-run --json',
          execute: 'vault rag <question> --yes --json',
          confirmationRequired: true,
          sendsSelectedKnowledgeToAi: true,
          questionInProcessArguments: false,
        },
        semanticQuery: {
          preview: 'search <query> --dry-run --json',
          execute: 'search <query> --yes --json',
          confirmationRequired: true,
          mayUseCloudEmbedding: true,
          queryInProcessArguments: false,
        },
        ragChat: {
          preview: 'chat <question> --dry-run --json',
          execute: 'chat <question> --yes --json',
          confirmationRequired: true,
          sendsSelectedKnowledgeToAi: true,
          questionInProcessArguments: false,
          interactiveModeMachineExecutionAllowed: false,
        },
        diagnostics: {
          accountScan: 'scan --json',
          assistantLogStatus: 'assistant log --json',
          sensitiveValuesInStatus: false,
        },
        mcpConfiguration: {
          read: 'mcp-config',
          previewWrite: 'mcp-config --output <file> --dry-run --json-result',
          executeWrite: 'mcp-config --output <file> --yes --json-result',
          confirmationRequired: true,
        },
        destructiveClear: {
          commands: ['config clear', 'whitelist clear', 'blacklist clear', 'audit clear'],
          previewFlag: '--dry-run --json',
          confirmationFlag: '--yes',
          confirmationRequired: true,
          previewExposesEntries: false,
        },
      },
      safety: {
        localByDefault: true,
        aiDisabledByDefaultForExport: true,
        unknownMessageTypesPreserved: true,
        nonInteractiveTalkerResolution: true,
        // **这个名字曾经是假的**：MCP 那张表不是手写的只读清单，而是**助手工具表减去
        // save_memory**，所以里面早就有写文件的 `export_chat` 和会把图片交给模型的
        // `look_at_image`。如实改成 false，并把真正有出境的几样单独列出来（下面这个对象）。
        // 读这一位的调用方按 false 走保守分支即可。
        mcpDefaultReadOnly: false,
        mcpSurface: {
          // 这句话**手工补过两回**：先是只写 save_memory，后来补上 `look_at_image`，第三次加
          // `set_todo_status` 时又漏了 —— 每次都是"表变了、这句话没变"，而且没有任何东西会红。
          // 现在名字**逐个与 `MCP_EXCLUDED` 对齐**，并由 `test/assistant-tools.test.ts` 从源码里核：
          // 那张表再加一项而这里没跟，测试就红（同下面 requiresConfirm 的处理方式）。
          derivedFrom: 'assistant tools minus save_memory, look_at_image and set_todo_status',
          writesFiles: ['export_chat'],
          // 逐个核实过（脚本里确实调云端模型的那些）：
          // who_owes_reply/search_chats → Jev；search_semantic → 阿里云百炼嵌入 + Jev 重排；draft_reply → Jev + DeepSeek。
          // `look_at_image` **不在这里**：它靠侧信道把图交给助手自己的模型，而 MCP 只取工具返回的文本，
          // 图没人接、回话却写着"你能看到它了"——所以它已经从 MCP 那张表里排除了（见 MCP_TOOL_DEFS）。
          callsCloudModels: ['who_owes_reply', 'search_chats', 'search_semantic', 'draft_reply'],
          // 机器调用**默认只给预览**、必须显式 confirm 才出境的那些（MCP 独有的边界）。
          // **这里是四个，不是"只有 draft_reply"**：逐个读 handler 才发现那四个工具里
          // 写的是同一句 `if (ctx.requiresConfirm && args.confirm !== true)`（1010/1041/1094/1170）。
          // 原先只列了 draft_reply，而测试是照着这个字段的值抄的，于是两处一起错、谁都没红。
          // 现在测试改成**从源码里数**（见 test/assistant-tools.test.ts），改一处不同步就会红。
          requiresConfirm: ['search_chats', 'who_owes_reply', 'draft_reply', 'search_semantic'],
        },
        mcpMessageLimit: { default: 100, max: 1000 },
      },
    }
    console.log(JSON.stringify(data, null, 2))
  })
}
