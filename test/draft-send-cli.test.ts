/**
 * `draft --pick N --send`：**人在环里**的发送。
 *
 * 起草那一半早就有了（判断 → 3 条候选 → 排序），缺的是"人选定之后能真的发出去"。这条新增的路
 * 要点全在**拦**上，所以测试也全在拦上：
 *
 *   1. `--send` 不带 `--pick` → 拒绝（**不允许"让它自己挑一条发"**。少了这条，就成了
 *      "模型起草三条、模型挑一条、模型发出去"）；
 *   2. `--pick` 越界 → 拒绝；
 *   3. 不带 `--yes` → 只回 `CONFIRMATION_REQUIRED`（两段式），**并且不要发送**。
 *
 * 三条都必须在**调用任何云端模型之前**拒绝 —— 否则"用法错误"的代价是一次模型调用。判据就是
 * 退出码 + 错误码，外加"审计里没有任何一次 send"。这个测试不碰模型、不碰网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function runCli(home: string, args: string[]) {
  return spawnSync(process.execPath, [
    '--import', 'tsx', join(process.cwd(), 'bin', 'weflow-cli.ts'), ...args,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    // 临时 HOME：配置、白名单、审计都落在那儿，真实的那些一律不碰
    env: { ...process.env, HOME: home, USERPROFILE: home, DEEPSEEK_API_KEY: '', TYPESAFE_API_KEY: '' },
  })
}

/** 审计文件里出现过多少次"真的发送"（`send` 且 success）。 */
/**
 * 审计里出现过多少次**发送尝试**（`action === 'send'`，成不成不论）。
 *
 * 为什么不数"成功"：临时家里没有消息通道的 context_token，真发也只会失败；数成功的话这个函数
 * 永远是 0，于是"没有发送"就成了**空断言** —— 第一次写正是这样：文件名我写成 `send-audit.jsonl`，
 * 真实是 `audit-send.log`，它恒返回 0 而测试照样绿。数尝试还更严格：被拦住的那几条路**连试都不该试**。
 */
function sendAttempts(home: string): number {
  const file = join(home, '.weflow-cli', 'audit-send.log')
  if (!existsSync(file)) return 0
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter((entry) => entry && entry.action === 'send').length
}

test('正向对照：审计里确实能看见发送尝试（否则下面那些"没有发送"是空断言）', () => {
  const home = mkdtempSync(join(tmpdir(), 'weflow-draft-send-'))
  const target = 'wxid_test_draft_send'
  try {
    // **不能靠"真发一次"来当对照**：临时家里 `/api/pair` 未登录，`send --yes` 会先以
    // `MESSAGE_CHANNEL_NOT_LOGGED_IN` 退出（实测），压根走不到写审计那一步。
    // 走**黑名单**分支：它在通道检查**之前**就拦下并写审计 —— 这条真的会落一行。
    const blocked = runCli(home, ['blacklist', 'add', target, '--yes', '--json'])
    assert.equal(blocked.status, 0, blocked.stderr || blocked.stdout)
    runCli(home, ['send', target, 'synthetic', '--yes', '--json'])
    assert.ok(sendAttempts(home) >= 1,
      '读不到真实尝试的话，下面"没有发送"的断言就什么也没证明')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('draft --send 必须点名发哪一条，否则拒绝且不花模型调用', () => {
  const home = mkdtempSync(join(tmpdir(), 'weflow-draft-send-'))
  try {
    const missingPick = runCli(home, ['draft', '某个不存在的会话', '--send', '--json'])
    assert.equal(missingPick.status, 1, missingPick.stderr || missingPick.stdout)
    assert.equal(JSON.parse(missingPick.stdout).code, 'PICK_REQUIRED')

    // 越界同理：用法错误要在碰模型之前报出来
    const outOfRange = runCli(home, ['draft', '某个不存在的会话', '--pick', '9', '--send', '--json'])
    assert.equal(outOfRange.status, 1, outOfRange.stderr || outOfRange.stdout)
    assert.equal(JSON.parse(outOfRange.stdout).code, 'INVALID_ARGUMENT')

    assert.equal(sendAttempts(home), 0, '这两条都该在任何发送**尝试**之前就被拦住')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('draft --pick N --send 不给 --yes 时只回确认要求，不发送', () => {
  const home = mkdtempSync(join(tmpdir(), 'weflow-draft-send-'))
  try {
    // 注意：这条路**不会**走到调模型那一步 —— `--json` 且没有 `--yes` 时，
    // "要不要把这段对话发给模型"那道闸门先回 CONFIRMATION_REQUIRED。
    const res = runCli(home, ['draft', '某个不存在的会话', '--pick', '1', '--send', '--json'])
    assert.equal(res.status, 1, res.stderr || res.stdout)
    const payload = JSON.parse(res.stdout)
    assert.equal(payload.code, 'CONFIRMATION_REQUIRED')
    assert.equal(payload.sendsNothing, true, '这条命令在确认之前什么都不该发')
    assert.equal(sendAttempts(home), 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('draft 命令不在助手/MCP 的工具表里：发送不能由模型驱动', async () => {
  const { TOOL_DEFS } = await import('../src/services/assistantTools.js')
  const names = TOOL_DEFS.map((tool: any) => tool.function.name)
  for (const forbidden of ['send', 'draft', 'draft_reply_and_send', 'send_message', 'publish_article']) {
    assert.ok(!names.includes(forbidden),
      `${forbidden} 出现在工具表里了 —— 发送必须结构上不可达（docs/EXTENDING.md）`)
  }
  // 反向：草稿能力在（只是不发），别把这句删成"什么都不剩"
  assert.ok(names.includes('draft_reply'), '起草本身仍该在工具表里')
})
