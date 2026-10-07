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

/** contact-schema 那段源码（从 `.command(` 到下一个 `program.command(` 之前） */
function contactSchemaBlock(src: string): string {
  const at = src.indexOf(".command('contact-schema')")
  const end = src.indexOf(".command('", at + 1)
  return src.slice(at, end > at ? end : src.length)
}

test('声明了的每个旗标都必须真的转发给脚本 —— 漏转发会静默按默认模式跑', () => {
  // 这条守的是**跨语言那一步**：旗标在 TS 里声明、在 Python 里解析，中间的转发是手写的。
  // 少写一行 `--contacts`，命令行不报错、脚本也不会说"我没收到" —— 它会安安静静地去读群，
  // 而调用方以为拿到的是联系人。`--room` 当初也是这么手写转发的（同样的裸奔）。
  const src = readFileSync(join(process.cwd(), 'bin', 'weflow-cli.ts'), 'utf8')
  const block = contactSchemaBlock(src)
  assert.ok(block.length > 0, '定位不到 contact-schema 的命令块（改名了？）')
  const declared = [...block.matchAll(/\.option\('([^']+)'/g)]
    .map((m) => m[1].split(',').pop()!.trim().split(/\s+/)[0])
  assert.ok(declared.includes('--contacts'),
    `这个命令现在声明了 ${declared.join(' / ')}；--contacts 不见了？`)
  // 只看 `.action(` **之后**的片段：声明处自己也有那个字符串，用 indexOf 会比到声明处去
  const action = block.slice(block.indexOf('.action('))
  assert.ok(action.length > 0, '定位不到 action 体（结构变了？）')
  for (const flag of declared) {
    assert.ok(action.includes(`'${flag}'`),
      `${flag} 声明了但没在 action 里转发给脚本 —— 命令会静默跑成默认模式`)
  }
})

test('--contacts 是命令行认得的旗标（不是被 commander 拒掉的死开关）', () => {
  withHome((home) => {
    const r = runCli(home, ['contact-schema', '--contacts', '--limit', '1', '--json'])
    const start = r.stdout.indexOf('{')
    assert.ok(start >= 0, `该有 JSON 输出，实际 stdout=${r.stdout.slice(0, 200)} stderr=${r.stderr.slice(0, 200)}`)
    const body = JSON.parse(r.stdout.slice(start))
    assert.equal(body.success, false)
    assert.equal(body.code, 'CONTACT_SCHEMA_FAILED', '临时 HOME 下没有配置，脚本失败是预期的')
    assert.ok(!/unknown option/i.test(r.stdout + r.stderr), '--contacts 没被声明，成了死开关')
  })
})
