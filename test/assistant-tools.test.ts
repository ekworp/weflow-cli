import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  boundedToolInteger,
  MCP_READ_ONLY_TOOL_DEFS,
  resolveUniqueTalker,
} from '../src/services/assistantTools.js'

test('MCP assistant-tool subset contains no write operation', () => {
  const names = MCP_READ_ONLY_TOOL_DEFS.map(tool => tool.function.name)
  const mcpSource = readFileSync(join(process.cwd(), 'mcp-server', 'index.ts'), 'utf8')
  assert.equal(names.includes('save_memory'), false)
  assert.equal(names.includes('send'), false)
  assert.equal(names.includes('publish_article'), false)
  assert.doesNotMatch(mcpSource, /name:\s*['"]wechat\.publish_article['"]/)
  assert.doesNotMatch(mcpSource, /case\s+['"]wechat\.publish_article['"]/)
})

test('conversation resolution requires a unique display-name match', () => {
  const sessions = [
    { username: 'session-a', displayName: '项目讨论' },
    { username: 'session-b', displayName: '项目讨论' },
    { username: 'session-c', displayName: '项目讨论二组' },
  ]

  assert.equal(resolveUniqueTalker('session-a', sessions), 'session-a')
  assert.throws(() => resolveUniqueTalker('项目讨论', sessions), /对应多个会话/)
  assert.throws(() => resolveUniqueTalker('项目', sessions), /匹配多个会话/)
  assert.equal(resolveUniqueTalker('二组', sessions), 'session-c')
  assert.equal(resolveUniqueTalker('unlisted-session-id', sessions), 'unlisted-session-id')
})

test('tool limits accept bounded integers and reject coercion hazards', () => {
  assert.equal(boundedToolInteger(undefined, 15, 30), 15)
  assert.equal(boundedToolInteger('20', 15, 30), 20)
  assert.throws(() => boundedToolInteger(0, 15, 30), /1-30/)
  assert.throws(() => boundedToolInteger(-1, 15, 30), /1-30/)
  assert.throws(() => boundedToolInteger(1.5, 15, 30), /1-30/)
  assert.throws(() => boundedToolInteger('not-a-number', 15, 30), /1-30/)
  assert.throws(() => boundedToolInteger(31, 15, 30), /1-30/)
})

test('capability discovery tells the truth about the MCP surface', () => {
  // 这条以前断言 `mcpDefaultReadOnly === true`，**而那是假的**：MCP 那张表不是手写的只读清单，
  // 而是"助手工具表减去 save_memory"——里面早就有写文件的 `export_chat` 和会把图片交给云端
  // 模型的 `look_at_image`。一个名字在撒谎的字段比没有这个字段更糟，所以改成如实声明。
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'bin/weflow-cli.ts', 'capabilities', '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const capabilities = JSON.parse(result.stdout)
  assert.equal(capabilities.safety.mcpDefaultReadOnly, false)
  assert.deepEqual(capabilities.safety.mcpSurface.callsCloudModels, ['look_at_image', 'draft_reply'])
  assert.deepEqual(capabilities.safety.mcpSurface.writesFiles, ['export_chat'])
  assert.deepEqual(capabilities.safety.mcpSurface.requiresConfirm, ['draft_reply'],
    '机器调用默认只给预览的那些工具要能被机器读到')
  assert.equal(capabilities.read.exports.versionedContract, 'weflow-message/v1')
  assert.equal(capabilities.read.exports.rawContractPreserved, true)
  assert.equal(capabilities.read.exports.incrementalRead.stableCursor, false)
})

test('generated MCP guidance does not advertise publishing / sending / memory writes', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'bin/weflow-cli.ts', 'mcp-config'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /wechat\.export_messages/)
  assert.doesNotMatch(result.stdout, /wechat\.publish_article/)
  assert.doesNotMatch(result.stdout, /wechat\.save_memory/)
})

test('live MCP tools/list excludes publishing / sending / memory writes', { timeout: 15_000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(process.cwd(), 'mcp-server', 'index.ts')],
    stderr: 'pipe',
  })
  const client = new Client({ name: 'weflow-test-client', version: '1.0.0' })

  try {
    await client.connect(transport)
    const result = await client.listTools()
    const names = result.tools.map(tool => tool.name)
    assert.equal(new Set(names).size, names.length)
    assert.equal(names.includes('wechat.export_messages'), true)
    assert.equal(names.includes('wechat.publish_article'), false)
    assert.equal(names.includes('wechat.save_memory'), false)
    assert.equal(names.includes('wechat.send'), false)

    const rejectedUrl = await client.callTool({
      name: 'wechat.fetch_article',
      arguments: { url: 'https://mp.weixin.qq.com.evil.test/s/example' },
    })
    assert.match(String((rejectedUrl.content[0] as { text?: string }).text), /仅支持 HTTPS/)

    const rejectedLimit = await client.callTool({
      name: 'wechat.search_public',
      arguments: { keyword: 'synthetic', limit: 1000 },
    })
    assert.match(String((rejectedLimit.content[0] as { text?: string }).text), /1-20/)

    const rejectedDate = await client.callTool({
      name: 'wechat.get_daily',
      arguments: { date: '../latest' },
    })
    assert.match(String((rejectedDate.content[0] as { text?: string }).text), /日期无效/)
  } finally {
    await client.close()
  }
})

test('MCP 那张表里的 draft_reply 带 confirm 参数 —— 机器调用默认只给预览', () => {
  // 这条盯着的是"MCP 有显式权限边界"这句话在**工具定义**上成不成立：
  // 没有 confirm 这个入参，调用方就没有办法表达"我还没得到用户同意"。
  const def = MCP_READ_ONLY_TOOL_DEFS.find(tool => tool.function.name === 'draft_reply')
  assert.ok(def, 'draft_reply 本来就在 MCP 表里（那张表是助手工具表减去 save_memory）')
  const properties = def!.function.parameters.properties as Record<string, any>
  assert.ok(properties.confirm, 'draft_reply 必须有 confirm 入参')
  assert.equal(properties.confirm.type, 'boolean')
  assert.match(def!.function.description, /MCP/, '描述里要说清外部机器调用时的预览行为')
})

test('live MCP: 不带 confirm 调 draft_reply 绝不会产出草稿（边界走真协议也成立）', { timeout: 20_000 }, async () => {
  // 这条是"机器调用默认只给预览"在**真协议**上的证据：起真的 MCP server、真的 callTool。
  // 断言写成"**不出现候选**"而不是"出现预览字样"：CI 干净检出里没有微信库，预览那一步
  // 会自己去读库、读不到就回一句失败——但无论哪种，**都不许产出草稿**。
  // 有人把 confirm 那道门去掉的话，这条在有库的机器上就会红（真跑会给出"建议这样回"）。
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(process.cwd(), 'mcp-server', 'index.ts')],
    stderr: 'pipe',
  })
  const client = new Client({ name: 'weflow-test-client', version: '1.0.0' })
  try {
    await client.connect(transport)
    const result = await client.callTool({
      name: 'wechat.draft_reply',
      arguments: { contact: 'synthetic-contact' },   // 不传 confirm
    })
    const text = String((result.content[0] as { text?: string }).text ?? '')
    assert.doesNotMatch(text, /建议这样回/, '没确认就不许产出草稿')
    assert.match(text, /预览|没找到|起草预览失败/, `既不是预览也不是本地查不到：${text.slice(0, 120)}`)
  } finally {
    await client.close()
  }
})
