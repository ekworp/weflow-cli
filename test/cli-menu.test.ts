/**
 * 交互式菜单与命令的**一致性**：`showInteractiveMenu` 里那份手写清单是这套 CLI 里
 * **唯一没有东西盯着**的扩展点（`docs/EXTENDING.md` 的配方 C 把这一点写在了明处）。
 *
 * 两种坏法都是**静默**的，这正是要测它的理由：
 *
 * - **菜单项没有对应的 `case`**：用户选了它，什么都不发生，也没有报错。
 * - **`runCmd('x')` 指向一个不存在（或改了名）的命令**：`runCmd` 的实现是
 *   `const cmd = program.commands.find(...); if (cmd) await …` —— 找不到就**什么都不做**。
 *   同理 `runSubCmd`。
 *
 * 所以这里一律**从源码与运行时 derive**，不把当前的值再抄一遍（这条纪律是本仓吃过亏的：
 * 照着字段的值抄的断言会和字段一起错，谁都发现不了）。
 * 命令清单只能**问运行时**：源码里 `.command('x')` 既有顶层的也有子命令的（实测 64 个名字
 * 对 44 个真命令），静态分不出来。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const SOURCE = readFileSync(join(process.cwd(), 'bin', 'weflow-cli.ts'), 'utf8')

const MENU_START = SOURCE.indexOf('async function showInteractiveMenu')
assert.ok(MENU_START > 0, '没找到 showInteractiveMenu —— 改名了就要同步这条测试')
const SWITCH_START = SOURCE.indexOf('switch (action)', MENU_START)
assert.ok(SWITCH_START > MENU_START, '没找到 showInteractiveMenu 里的 switch (action)')
const MENU = SOURCE.slice(MENU_START, SWITCH_START)
const SWITCH = SOURCE.slice(SWITCH_START)

/** 菜单里那 21 个 value（去重前先看重复：重复的 value 意味着两项点了走同一个分支） */
const menuIdsRaw = [...MENU.matchAll(/value: '([a-z0-9-]+)'/g)].map(m => m[1])
const menuIds = [...new Set(menuIdsRaw)]
/** switch 的分支名 */
const caseIds = [...SWITCH.matchAll(/^    case '([a-z0-9-]+)':/gm)].map(m => m[1])
/** 每个 case 分支体：id → 那段代码（`runCmd` 的检查要按分支看） */
const blocks = new Map<string, string>()
{
  const parts = SWITCH.split(/^    case '([a-z0-9-]+)':/m).slice(1)
  for (let i = 0; i < parts.length; i += 2) blocks.set(parts[i], parts[i + 1] ?? '')
}

/** 问运行时：某个命令（或顶层）的帮助里列了哪些命令 */
async function commandsListedBy(...commandPath: string[]): Promise<string[]> {
  const { stdout } = await runFile(process.execPath,
    ['--import', 'tsx', 'bin/weflow-cli.ts', ...commandPath, '--help'],
    { cwd: process.cwd(), encoding: 'utf8' })
  const section = stdout.slice(stdout.indexOf('Commands:'))
  return [...section.matchAll(/^ {2}([a-z][a-z0-9-]*)/gm)].map(match => match[1])
}

test('菜单项与 switch 分支**一一对应**（两个方向都要对上）', () => {
  assert.equal(menuIds.length, menuIdsRaw.length, `菜单里有重复的 value：${menuIdsRaw.join(' ')}`)
  const noBranch = menuIds.filter(id => !caseIds.includes(id))
  const noMenuEntry = caseIds.filter(id => !menuIds.includes(id))
  assert.deepEqual(noBranch, [],
    '这些菜单项没有对应的 case：用户选了它，**什么都不发生**，也不报错')
  assert.deepEqual(noMenuEntry, [],
    '这些 case 没有任何菜单项通向它：等于一段走不到的死代码')
})

test('`runCmd` 指向的命令都真的注册过', async () => {
  // `runCmd` 找不到命令时**静默什么都不做**——所以"命令改了名、菜单没跟上"是一种无声的坏
  const registered = await commandsListedBy()
  const missing: string[] = []
  for (const [id, body] of blocks) {
    for (const match of body.matchAll(/runCmd\(\s*'([a-z0-9-]+)'/g)) {
      if (!registered.includes(match[1])) missing.push(`${id} → ${match[1]}`)
    }
  }
  assert.deepEqual(missing, [], `菜单调的命令不存在（runCmd 会静默不做）：${missing.join('、')}`)
})

test('`runSubCmd` 指向的父子命令都真的注册过', async () => {
  const pairs = new Set<string>()
  for (const body of blocks.values()) {
    for (const match of body.matchAll(/runSubCmd\(\s*'([a-z0-9-]+)',\s*'([a-z0-9-]+)'/g)) {
      pairs.add(`${match[1]} ${match[2]}`)
    }
  }
  assert.ok(pairs.size > 0, '一个 runSubCmd 都没解析到 —— 解析方式过时了')
  const parents = [...new Set([...pairs].map(pair => pair.split(' ')[0]))]
  // 每个父命令问一次（并发，别串行等）
  const listed = new Map<string, string[]>()
  await Promise.all(parents.map(async parent => {
    listed.set(parent, await commandsListedBy(parent))
  }))
  const missing = [...pairs].filter(pair => {
    const [parent, child] = pair.split(' ')
    return !listed.get(parent)?.includes(child)
  })
  assert.deepEqual(missing, [], `菜单调的子命令不存在（同样静默）：${missing.join('、')}`)
})
