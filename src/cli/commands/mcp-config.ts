// 由 bin/weflow-cli.ts 拆分而来：命令注册逻辑，行为保持不变。
import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { existsSync, writeFileSync } from 'fs'

export function registerMcpConfig(program: Command): void {

// ==================== Interactive Menu (no arguments) ====================
program
  .command('mcp-config')
  .description('输出 MCP Server 配置，粘贴到 .mcp.json 即可让 AI 操作本工具')
  .option('-o, --output <file>', '写入文件', '')
  .option('--dry-run', '仅预览文件写入，不修改文件')
  .option('--yes', '确认写入配置文件')
  .option('--json-result', '写入模式输出 JSON 结果，不返回本地路径')
  .action(async (opts) => {
    const { writeFileSync } = await import('fs')
    const config = {
      mcpServers: {
        weflow: {
          command: 'npx',
          args: ['tsx', 'mcp-server/index.ts'],
          cwd: '${workspaceFolder}',
        },
      },
    }
    const json = JSON.stringify(config, null, 2)
    if (opts.output) {
      const preview = { success: true, dryRun: true, action: 'mcp-config.write', overwrite: existsSync(opts.output) }
      if (opts.dryRun) {
        if (opts.jsonResult) console.log(JSON.stringify(preview))
        else console.log(chalk.cyan(`MCP 配置写入预览：${preview.overwrite ? '将覆盖现有文件' : '将创建新文件'}`))
        return
      }
      if (!opts.yes) {
        if (opts.jsonResult) {
          console.log(JSON.stringify({ success: false, code: 'CONFIRMATION_REQUIRED', action: 'mcp-config.write', overwrite: preview.overwrite }))
          process.exit(1)
        }
        const { confirmed } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: `${preview.overwrite ? '覆盖' : '创建'} MCP 配置文件？`,
          default: false,
        }])
        if (!confirmed) {
          console.log(chalk.gray('已取消'))
          return
        }
      }
      writeFileSync(opts.output, json, 'utf-8')
      if (opts.jsonResult) {
        console.log(JSON.stringify({ success: true, action: 'mcp-config.write', changed: true, overwrite: preview.overwrite }))
        return
      }
      console.log(chalk.green(`✓ 已写入 ${opts.output}`))
      console.log(chalk.gray('AI 助手现在可以使用以下工具：'))
    } else {
      console.log(json)
      // 机器模式到这里就结束：下面那段工具清单与"复制以上 JSON…"是**给人看的**，原来无条件打在
      // stdout 上 ⇒ `mcp-config --json-result | jq` 断在第 14 行（2026-10-12 由只读驱动扫描发现；
      // 写路径本来就早退发 JSON，所以只有读路径这一处漏）。
      if (opts.jsonResult) return
    }
    console.log(chalk.cyan('\n可用的 MCP 工具：'))
    const STATIC_TOOLS: Array<[string, string]> = [
      ['wechat.search_articles', '搜索知识库文章'],
      ['wechat.get_daily', '获取公众号日报(完整版)'],
      ['wechat.get_review', '获取 AI 学习日报'],
      ['wechat.get_stats', '统计概览(知识库+微信数据)'],
      ['wechat.get_concepts', '概念图谱索引'],
      ['wechat.get_concept', '读取概念 Wiki 页'],
      ['wechat.format_article', 'Markdown 转公众号排版'],
      ['wechat.list_themes', '排版主题列表'],
      ['wechat.fetch_article', '抓取公众号文章'],
      ['wechat.search_public', '搜索全网公众号文章'],
      ['wechat.export_messages', '按稳定数据契约读取会话消息'],
    ]
    const { MCP_TOOL_DEFS } = await import('../../services/assistantTools.js')
    const all = [
      ...STATIC_TOOLS,
      ...MCP_TOOL_DEFS.filter(t => t.function.name !== 'get_stats')
        .map(t => [`wechat.${t.function.name}`, t.function.description.split(/[。(]/)[0]] as [string, string]),
    ]
    for (const [n, d] of all) {
      console.log(chalk.white('  ' + n.padEnd(28)) + chalk.gray(d))
    }
    console.log()
    if (opts.output) {
      console.log(chalk.gray(`配置已写入 ${opts.output}，重启 AI 编辑器即可生效`))
    } else {
      console.log(chalk.gray('复制以上 JSON 到你的 .mcp.json 文件即可'))
    }
  })
}
