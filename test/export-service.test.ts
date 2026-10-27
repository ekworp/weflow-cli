import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportService } from '../src/services/exportService.js'
import { chatService } from '../src/services/chatService.js'
import type { Message } from '../src/types.js'

test('JSON export reports count and writes the versioned contract', async () => {
  const output = mkdtempSync(join(tmpdir(), 'weflow-export-'))
  const original = chatService.getMessagesInRange
  const messages: Message[] = [{
    localId: 1,
    serverId: 'synthetic-server',
    localType: 1,
    createTime: 1_700_000_000,
    isSend: 1,
    senderUsername: 'synthetic-sender',
    content: 'synthetic content',
    rawContent: 'synthetic content',
    parsedContent: 'synthetic content',
  }]

  try {
    chatService.getMessagesInRange = async () => messages
    const result = await exportService.exportJson('synthetic-session', output, 100, undefined, undefined, 'weflow-v1')
    assert.equal(result.success, true)
    assert.equal(result.count, 1)
    const payload = JSON.parse(readFileSync(result.path!, 'utf8'))
    assert.equal(payload.schema, 'weflow-message/v1')
    assert.equal(payload.messages.length, 1)
    assert.equal(payload.coverage.requestedLimit, 100)
    assert.equal(payload.coverage.returned, 1)
    assert.equal(payload.coverage.mayHaveMore, false)
    assert.equal(payload.coverage.oldestCreateTime, 1_700_000_000)
    assert.equal(payload.coverage.newestCreateTime, 1_700_000_000)

    const rawResult = await exportService.exportJson('synthetic-session', output, 100)
    assert.equal(rawResult.success, true)
    const rawPayload = JSON.parse(readFileSync(rawResult.path!, 'utf8'))
    assert.equal(Array.isArray(rawPayload), true)
    assert.equal(rawPayload[0].messageType, undefined)
  } finally {
    chatService.getMessagesInRange = original
    rmSync(output, { recursive: true, force: true })
  }
})

test('save-originals is refused where it could not be honoured, not silently dropped', async () => {
  const output = mkdtempSync(join(tmpdir(), 'weflow-export-'))
  try {
    // markdown already writes its images to disk; the basic renderer used for
    // --from/--to embeds no images at all, so an "originals" folder would come
    // out empty while the flag looked like it had worked.
    const markdown = await exportService.exportHtml('synthetic-session', output, 0, '', undefined, undefined, true,
      { format: 'md', saveOriginals: true })
    assert.equal(markdown.success, false)
    assert.match(markdown.error ?? '', /save-originals/)

    const ranged = await exportService.exportHtml('synthetic-session', output, 0, '', 1_700_000_000, 1_700_000_100, true,
      { saveOriginals: true })
    assert.equal(ranged.success, false)
    assert.match(ranged.error ?? '', /save-originals/)
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})
