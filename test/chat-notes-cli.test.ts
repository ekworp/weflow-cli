/**
 * `chat-notes --transcribe-voice` 必须能从**命令行**用起来。
 *
 * 2026-10-02 查出来的实情：`scripts/chat_notes.py` 早就支持 `--transcribe-voice`（本地 whisper 补转写），
 * `docs/PROJECT_STATE.md` 也写着"要补跑加 `--transcribe-voice`"，但 CLI 那条 `chat-notes` 命令**没把它
 * 透出去** —— 于是文档承诺的能力在命令行里根本不存在。这类"两层之间少接一根线"的缺口不会有任何东西报错，
 * 所以这里放两条：一条真的跑一遍（commander 认不认得这个开关），一条盯住接线（声明与透传，少任一处都断）。
 *
 * 不碰真数据、不花钱：临时 HOME 下本机没配置也没库，脚本必然失败 —— 那正是"命令跑到了脚本"的证据。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

function runCli(home: string, args: string[]) {
  return spawnSync(process.execPath, [
    '--import', 'tsx', join(process.cwd(), 'bin', 'weflow-cli.ts'), ...args,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  })
}

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'weflow-chatnotes-'))
  try {
    run(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('CLI 认得 --transcribe-voice，并且真的把命令交给了脚本', () => {
  withHome((home) => {
    const r = runCli(home, ['chat-notes', '--transcribe-voice', '--dry-run', '--json'])
    // commander 遇到不认识的开关会打 usage、exit 1、**一个 JSON 都没有**。
    // 所以"有 JSON"就是"开关认得、action 跑到了 execFile"的证据。
    const start = r.stdout.indexOf('{')
    assert.ok(start >= 0, `该有 JSON 输出，实际 stdout=${r.stdout.slice(0, 200)} stderr=${r.stderr.slice(0, 200)}`)
    const body = JSON.parse(r.stdout.slice(start))
    assert.equal(body.success, false)
    assert.equal(body.code, 'CHAT_NOTES_FAILED', '临时 HOME 下没有本机数据，脚本失败是预期的')
    assert.ok(!/unknown option/i.test(r.stdout + r.stderr), '命令行不认这个开关')
  })
})

test('接线：--transcribe-voice 既被声明、也被透传（少任一处，命令行与文档就对不上）', () => {
  const src = readFileSync(join(process.cwd(), 'bin', 'weflow-cli.ts'), 'utf8')
  const at = src.indexOf(".command('chat-notes')")
  assert.ok(at > 0, '找不到 chat-notes 命令（改名了？那这条要跟着改）')
  const block = src.slice(at, src.indexOf('.action(', at))
  assert.ok(/--transcribe-voice/.test(block), '命令要声明 --transcribe-voice')
  const argsStart = src.indexOf('const args = [', at)
  const argsBlock = src.slice(argsStart, argsStart + 600)
  assert.ok(/opts\.transcribeVoice \? \['--transcribe-voice'\]/.test(argsBlock),
    '参数数组里要真的带上它 —— 只声明不透传，开关就是死的')
})
