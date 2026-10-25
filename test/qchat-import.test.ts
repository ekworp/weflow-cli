/**
 * `weflow-cli import qchat`：解析、归一化、合并去重与两段式命令面。
 *
 * 钉四件事：
 *  - qchat 导出形状的识别（认不出的 JSON 说清原因，不猜）；
 *  - 字段映射与 messageType 映射（两套词汇表之间只有这一处翻译）；
 *  - 重复导入是安全的（按 messageId 合并，计数分得清新增/更新/原样）；
 *  - 命令面两段式（--dry-run 计划 / 无 --yes 即 CONFIRMATION_REQUIRED），
 *    且导入后的 list/show 读得回同一条数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  parseQchatExport, qqSegmentMessageType, normalizeQchatMessage,
  runImportQchat, planImportQchat, listImports, readImportedSession, importRoot,
} from '../src/services/qchatImport.js'

function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'weflow-qchat-import-'))
  process.env.WEFLOW_IMPORT_ROOT = root
  try {
    run(root)
  } finally {
    delete process.env.WEFLOW_IMPORT_ROOT
    rmSync(root, { recursive: true, force: true })
  }
}

/** qchat-cli JsonExporter 的真实输出形状（src/core/exporter/json.ts）。 */
function qchatExport(sessionId = '123456', name = '老张', messages: any[] = []): string {
  return JSON.stringify({
    session: { type: 'private', id: sessionId, name },
    exportTime: '2026-10-24T00:00:00.000Z',
    messageCount: messages.length,
    messages,
  })
}

function qchatMsg(messageId: number, timestamp: number, extra: Record<string, any> = {}) {
  return {
    messageId,
    messageSeq: messageId,
    time: 'formatted',
    timestamp,
    sender: { id: 123456, name: '老张', card: '群名片' },
    content: '这条消息的内容足够长，能当正文用',
    rawMessage: 'raw',
    segments: [{ type: 'text', data: { text: '...' } }],
    ...extra,
  }
}

test('messageType 映射：OneBot 段类型 → 13 个稳定名', () => {
  assert.equal(qqSegmentMessageType([{ type: 'text' }]), 'text')
  assert.equal(qqSegmentMessageType([{ type: 'text' }, { type: 'at' }]), 'text')
  // 优先级按"信息量"：带图的消息标 image，带回复的标 quote
  assert.equal(qqSegmentMessageType([{ type: 'text' }, { type: 'image' }]), 'image')
  assert.equal(qqSegmentMessageType([{ type: 'reply' }, { type: 'text' }]), 'quote')
  assert.equal(qqSegmentMessageType([{ type: 'record' }]), 'voice')
  assert.equal(qqSegmentMessageType([{ type: 'json' }]), 'card')
  assert.equal(qqSegmentMessageType([{ type: 'face' }]), 'emoji')
  assert.equal(qqSegmentMessageType([]), 'text')
})

test('形状识别：qchat 导出认得出来，别的 JSON 说清原因', () => {
  const ok = parseQchatExport(qchatExport('1', 'x', [qchatMsg(1, 1700000000)]), 'f.json')
  assert.equal(ok.ok, true)
  assert.equal(ok.sessions[0].messages, 1)

  const notJson = parseQchatExport('{oops', 'f.json')
  assert.equal(notJson.ok, false)
  assert.match(notJson.reason!, /不是合法 JSON/)

  const wrongShape = parseQchatExport(JSON.stringify({ foo: 1 }), 'f.json')
  assert.equal(wrongShape.ok, false)
  assert.match(wrongShape.reason!, /不是 qchat 导出形状/)

  const noIds = parseQchatExport(
    JSON.stringify({ session: { id: '1' }, messages: [{ content: 'x' }] }), 'f.json')
  assert.equal(noIds.ok, false)
  assert.match(noIds.reason!, /messageId\+timestamp/)
})

test('字段映射：sender 名字取群名片优先；isSend 只在给了 own-id 时才有', () => {
  const m = normalizeQchatMessage(qchatMsg(7, 1700000000))!
  assert.equal(m.serverId, '7')
  assert.equal(m.senderUsername, '123456')
  assert.equal(m.senderName, '群名片', 'card 优先于 nickname')
  assert.equal(m.parsedContent, '这条消息的内容足够长，能当正文用')
  assert.equal(m.rawContent, 'raw')
  assert.equal('isSend' in m, false, '没给 own-id 时该字段不存在，不是 false')

  const mine = normalizeQchatMessage(qchatMsg(8, 1700000000), '123456')!
  assert.equal(mine.isSend, true)
  const theirs = normalizeQchatMessage(
    qchatMsg(9, 1700000000, { sender: { id: 999, name: '别人', card: '' } }), '123456')!
  assert.equal(theirs.isSend, false)

  assert.equal(normalizeQchatMessage({ timestamp: 1 }), null, '没有 messageId 的行跳过')
})

test('导入合并：重复导入安全，计数分得清新增/更新/原样', () => {
  withRoot((root) => {
    const dir = join(root, 'input')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.json'), qchatExport('123456', '老张', [
      qchatMsg(1, 1700000000),
      qchatMsg(2, 1700000100),
    ]), 'utf-8')

    const first = runImportQchat(dir)
    assert.equal(first.success, true)
    assert.equal(first.sessions[0].added, 2)
    assert.equal(first.sessions[0].total, 2)

    // 再导一次：内容没变 → 全是"原样"；第 2 条改了、第 3 条是新的
    writeFileSync(join(dir, 'a.json'), qchatExport('123456', '老张', [
      qchatMsg(1, 1700000000),
      qchatMsg(2, 1700000200, { content: '改过的内容' }),
      qchatMsg(3, 1700000300),
    ]), 'utf-8')
    const second = runImportQchat(dir)
    const s = second.sessions[0]
    assert.equal(s.total, 3)
    assert.equal(s.added, 1, `新增 1，实际 ${JSON.stringify(s)}`)
    assert.equal(s.updated, 1)
    assert.equal(s.unchanged, 1)

    // 存储里按时间升序
    const stored = readImportedSession('123456')!
    assert.deepEqual(stored.messages.map(m => m.serverId), ['1', '2', '3'])
    assert.equal(stored.schema, 'weflow-import/qq-v1')

    const list = listImports()
    assert.equal(list.length, 1)
    assert.equal(list[0].name, '老张')
    assert.equal(list[0].messages, 3)
  })
})

test('存储路径跟随 WEFLOW_IMPORT_ROOT（测试与 Python 侧读同一个变量）', () => {
  withRoot((root) => {
    assert.equal(importRoot(), root)
  })
})

// ---------------- CLI 命令面 ----------------

function runCli(args: string[], root: string) {
  return spawnSync(process.execPath, [
    '--import', 'tsx', join(process.cwd(), 'bin', 'weflow-cli.ts'), ...args,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, WEFLOW_IMPORT_ROOT: root },
  })
}

function payload(stdout: string): any {
  const at = stdout.indexOf('{')
  if (at < 0) throw new Error(`no JSON: ${stdout.slice(0, 120)}`)
  return JSON.parse(stdout.slice(at))
}

test('import qchat：两段式 + list/show 读回同一条数据', () => {
  withRoot((root) => {
    const input = join(root, 'exports')
    mkdirSync(input, { recursive: true })
    writeFileSync(join(input, 'qce.json'), qchatExport('42', '某群', [
      qchatMsg(11, 1700000000),
      qchatMsg(12, 1700000100),
    ]), 'utf-8')

    // --dry-run：只报计划，不写
    const dry = runCli(['import', 'qchat', input, '--dry-run', '--json'], root)
    assert.equal(dry.status, 0, dry.stderr)
    const plan = payload(dry.stdout)
    assert.equal(plan.dryRun, true)
    assert.equal(plan.sessionsFound, 1)
    assert.equal(plan.messagesTotal, 2)
    assert.equal(plan.invokesAI, false)
    assert.equal(existsSync(join(root, 'sessions')), false, 'dry-run 不许写任何东西')

    // 无 --yes：CONFIRMATION_REQUIRED
    const refused = runCli(['import', 'qchat', input, '--json'], root)
    assert.equal(refused.status, 1)
    assert.equal(payload(refused.stdout).code, 'CONFIRMATION_REQUIRED')
    assert.equal(existsSync(join(root, 'sessions')), false, '拒绝发生在写之前')

    // --yes：执行
    const done = runCli(['import', 'qchat', input, '--yes', '--json'], root)
    assert.equal(done.status, 0, done.stderr)
    assert.equal(payload(done.stdout).sessions[0].added, 2)

    // list / show 读回
    const list = runCli(['import', 'list', '--json'], root)
    assert.equal(list.status, 0)
    assert.equal(payload(list.stdout).sessions[0].name, '某群')

    const show = runCli(['import', 'show', '42', '-n', '1', '--json'], root)
    assert.equal(show.status, 0)
    const body = payload(show.stdout)
    assert.equal(body.messages.length, 1)
    assert.equal(body.messages[0].serverId, '12', 'limit 取最近的一条')

    const missing = runCli(['import', 'show', 'nope', '--json'], root)
    assert.equal(missing.status, 1)
    assert.equal(payload(missing.stdout).code, 'IMPORT_SESSION_NOT_FOUND')
  })
})

test('import qchat：不认识的输入如实报告，不假装成功', () => {
  withRoot((root) => {
    const input = join(root, 'input2')
    mkdirSync(input, { recursive: true })
    writeFileSync(join(input, 'not-qchat.json'), JSON.stringify({ hello: 1 }), 'utf-8')

    const dry = runCli(['import', 'qchat', input, '--dry-run', '--json'], root)
    assert.equal(dry.status, 0)
    const plan = payload(dry.stdout)
    assert.equal(plan.sessionsFound, 0)
    assert.match(plan.files[0].reason, /不是 qchat 导出形状/)

    const done = runCli(['import', 'qchat', input, '--yes', '--json'], root)
    assert.equal(done.status, 1, '一个可导入的文件都没有 = 失败')
    assert.equal(payload(done.stdout).success, false)
  })
})
