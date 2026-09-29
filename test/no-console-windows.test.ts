/**
 * 子进程不许弹出控制台窗口。
 *
 * **为什么要有这条**（2026-09-29 用户报的）：助手在思考时调用工具跑命令行，
 * 会有一个黑色命令行窗口弹出来，很难看。成因不是某一处写错，而是**没人盯着这件事**：
 * 守护进程自己是"无控制台"启动的（`assistantDaemon.ts` 里 `detached + stdio:'ignore' +
 * windowsHide`），所以它 spawn 的每一个子进程都会被 Windows **新建一个控制台**——
 * 除非那一处显式写了 `windowsHide: true`。
 *
 * 当时扫了一遍：15 个调用点里 14 个没写，包括助手跑工具的那条主路
 * （`pythonBridge`）和 Python 探测（`utils/python.ts` 的 `--version` 与 import 检查）。
 * 也就是说这不是"漏了一处"，是**默认就该写、而没有任何东西提醒你写**。
 * 所以这里把默认钉死：**新增子进程调用必须带 windowsHide**。
 *
 * `windowsHide` 不会让本来该看见的输出消失——父进程有控制台时子进程共用它
 * （`stdio: 'inherit'` 照旧）；它只挡住"父进程没有控制台时凭空开一个窗口"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')

function walk(dir: string, filter: (name: string) => boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue
      out.push(...walk(full, filter))
    } else if (filter(entry)) {
      out.push(full)
    }
  }
  return out
}

// 会**新建**进程的那几个 API。`exec`/`execSync` 要有意排除吗？不排除——
// 它们同样会开窗口；只是本仓现在没用，用了也一并管上。
const CALL_RE = /(?<![.\w])(spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(/g

/** 注释要去掉：注释里举例写的 `spawn(...)` 不是调用（第一版就被这条绊了一下）。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
}

test('每一个子进程调用都写了 windowsHide', () => {
  const files = [
    ...walk(join(ROOT, 'src'), (n) => n.endsWith('.ts')),
    ...walk(join(ROOT, 'bin'), (n) => n.endsWith('.ts') || n.endsWith('.cjs')),
    ...walk(join(ROOT, 'resources', 'panel'), (n) => n.endsWith('.cjs') || n.endsWith('.js')),
  ]
  const missing: string[] = []
  let seen = 0
  for (const file of files) {
    const live = stripComments(readFileSync(file, 'utf8'))
    for (const match of live.matchAll(CALL_RE)) {
      seen += 1
      // 只看这次调用往后一小段：选项对象就在参数表后面
      const window = live.slice(match.index!, match.index! + 400)
      if (!window.includes('windowsHide')) {
        const line = live.slice(0, match.index!).split('\n').length
        missing.push(`${file.slice(ROOT.length + 1).replace(/\\/g, '/')}:${line} ${match[1]}(...)`)
      }
    }
  }
  assert.ok(seen >= 10, `扫描到的调用点太少（${seen} 个），这条检查大概是失效了`)
  assert.deepEqual(missing, [],
    '这些子进程没写 windowsHide —— 从无控制台的守护进程里跑起来时，Windows 会弹一个命令行窗口，' +
    '用户看到的就是那个黑框。补上 `windowsHide: true` 即可（不会挡掉该看见的输出）')
})
