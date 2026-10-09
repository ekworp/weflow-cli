import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { collectMessagesInRange, emptyMessagesNote, looksLikeTalkerId } from '../src/services/messageQuery.js'
import type { Message } from '../src/types.js'

function message(createTime: number): Message {
  return {
    localId: createTime,
    serverId: String(createTime),
    localType: 1,
    createTime,
    isSend: 0,
    senderUsername: null,
    content: String(createTime),
    rawContent: String(createTime),
    parsedContent: String(createTime),
  }
}

test('message range pagination applies limit after date filtering', async () => {
  const source = [600, 500, 400, 300, 200, 100].map(message)
  const offsets: number[] = []
  const result = await collectMessagesInRange(async (limit, offset) => {
    offsets.push(offset)
    return source.slice(offset, offset + limit)
  }, 2, { from: 100, to: 350 }, 2)

  assert.deepEqual(result.map(item => item.createTime), [300, 200])
  assert.deepEqual(offsets, [0, 2, 4])
})

test('message range pagination stops after crossing the lower boundary', async () => {
  const source = [600, 500, 400, 300, 200, 100].map(message)
  let calls = 0
  const result = await collectMessagesInRange(async (limit, offset) => {
    calls += 1
    return source.slice(offset, offset + limit)
  }, 0, { from: 350 }, 2)

  assert.deepEqual(result.map(item => item.createTime), [600, 500, 400])
  assert.equal(calls, 2)
})

// ---- 空结果时的那句话（`emptyMessagesNote`）----
// 起因：`resolveTalker` 对 `wxid_*` / `@chatroom` / `@openim` 三种形状**原样放行**
// （src/utils/talkerUtils.ts），于是拼错的 ID 与"这条会话确实没消息"给出完全一样的输出。

test('形状判断与 resolveTalker 放行的那三种一致', () => {
  assert.equal(looksLikeTalkerId('wxid_abcdef'), true)
  assert.equal(looksLikeTalkerId('12345@chatroom'), true)
  assert.equal(looksLikeTalkerId('someone@openim'), true)
  assert.equal(looksLikeTalkerId('张三'), false, '名字形状的输入由 resolveTalker 报错，这里不插话')
  assert.equal(looksLikeTalkerId('wxid'), false, '少了前缀下划线就不算 ID')
  assert.equal(looksLikeTalkerId(''), false)
})

test('只在"看起来是 ID、名单里又没有"时补一句话', () => {
  const known = { sessionUsernames: ['wxid_in_sessions'], contactUsernames: ['wxid_in_contacts'] }
  assert.equal(emptyMessagesNote('wxid_in_sessions', known), '', '认识的 ID 取不到消息是正常结果')
  assert.equal(emptyMessagesNote('wxid_in_contacts', known), '', '只在联系人里也算认识')
  assert.equal(emptyMessagesNote('张三', known), '', '名字形状不归这里管')
  const note = emptyMessagesNote('wxid_typoo', known)
  assert.match(note, /既不在会话里、也不在联系人里/)
  assert.match(note, /wxid_typoo/, '要把输入原样回显，用户才看得出拼错在哪')
  assert.match(note, /weflow-cli sessions/, '要给下一步，而不只是"没找到"')
})

test('接线守卫：这句话真的接在 messages 命令上，且没有改动 success 语义', () => {
  const src = readFileSync(new URL('../bin/weflow-cli.ts', import.meta.url), 'utf8')
  const start = src.indexOf(".command('messages <talker>')")
  assert.ok(start > 0, '找不到 messages 命令（命令改名了？那这条守卫要跟着改）')
  const block = src.slice(start, src.indexOf('.command(', start + 10))
  assert.ok(block.includes('looksLikeTalkerId('), '要先按形状筛，否则对昵称输入也会去查名单')
  assert.ok(block.includes('emptyMessagesNote('),
    '判断函数写了却没接上——这类缺口没有任何东西会报错（本仓记过好几次）')
  assert.match(block, /success: true, talker, messages: \[\]/,
    'JSON 仍要报 success: true：没有消息不是错误，脚本与 MCP 依赖这一点')
})
