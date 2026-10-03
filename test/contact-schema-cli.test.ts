/**
 * `contact-schema` 必须在**命令行**里通 —— 它只解 blob 里已验证的那几个字段，
 * 未识别的原样标注（见 `docs/CONTACT_DB_SCHEMA.md`、D-067/D-068）。
 *
 * 两条守卫：
 *   1. 命令**声明**了，而且真的走到了那个 python 脚本（临时 HOME 下没有配置，脚本必然失败 ——
 *      那正是"命令跑通了"的证据）；不申报或没透传，命令行里就是个死开关。
 *   2. **这个命令不许把库密钥当参数暴露**：它只从配置里取 key/salt。这条是安全约束，
 *      不是卫生问题 —— 命令行参数在进程列表里人人可见（同 docs/EXTENDING 里
 *      "state goes in over stdin, not argv"）。
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
    env: { ...process.env, HOME: home, USERPROFILE: home, WEFLOW_HOME: join(home, '.weflow-cli') },
  })
}

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'weflow-contactschema-'))
  try {
    run(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('CLI 认得 contact-schema，并且真的把命令交给了脚本', () => {
  withHome((home) => {
    const r = runCli(home, ['contact-schema', '--limit', '1', '--json'])
    // commander 遇到不认识的命令会打 usage、exit 1、**一个 JSON 都没有**
    const start = r.stdout.indexOf('{')
    assert.ok(start >= 0, `该有 JSON 输出，实际 stdout=${r.stdout.slice(0, 200)} stderr=${r.stderr.slice(0, 200)}`)
    const body = JSON.parse(r.stdout.slice(start))
    assert.equal(body.success, false)
    assert.equal(body.code, 'CONTACT_SCHEMA_FAILED', '临时 HOME 下没有配置，脚本失败是预期的')
    assert.ok(!/unknown command/i.test(r.stdout + r.stderr), '命令行不认这个命令')
  })
})

test('这个命令不接受 --key/--salt：密钥只从配置读，不进 argv', () => {
  const src = readFileSync(join(process.cwd(), 'bin', 'weflow-cli.ts'), 'utf8')
  const at = src.indexOf(".command('contact-schema')")
  assert.ok(at > 0, '找不到 contact-schema 命令（改名了？那这条要跟着改）')
  const block = src.slice(at, src.indexOf('.action(', at))
  assert.ok(!/--key|--salt/.test(block), '不许把库密钥做成命令行参数（进程列表可见）')
})
