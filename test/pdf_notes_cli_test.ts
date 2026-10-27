/**
 * `pdf-notes` 的 CLI 表面：失败时要把脚本的**真实原因**透出来。
 *
 * 为什么单测这一条：脚本在 `--json` 下会打印 `{"success":false,"error":"没找到 PDF（…）"}` 并退出 1，
 * 而 CLI 的通用 catch 只会说"子进程执行失败 (exit 1)"——实测第一次跑就是这样，用户看不出是
 * 路径写错、还是 OCR 引擎没装。这类"错误被兜底文案盖住"的退化不会让任何现有测试变红，
 * 所以钉在这里。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const SOURCE = join(process.cwd(), 'bin', 'weflow-cli.ts')

/** 取出 `pdf-notes` 那个命令块（从 `.command('pdf-notes')` 到下一个 `// todos`）。 */
function block(): string {
  const src = readFileSync(SOURCE, 'utf8')
  const start = src.indexOf(".command('pdf-notes')")
  assert.ok(start > 0, '没找到 pdf-notes 命令')
  const end = src.indexOf('// todos', start)
  assert.ok(end > start, '没找到 pdf-notes 块的结尾')
  return src.slice(start, end)
}

test('pdf-notes 失败时解析并透出脚本的 JSON 错误', () => {
  const b = block()
  assert.match(b, /stdout/, '失败分支没有读子进程的 stdout')
  assert.match(b, /JSON\.parse/, '失败分支没有解析子进程的结构化错误')
  assert.match(b, /parsed\?\.error/, '拿到解析结果却没有用它替换兜底文案')
})

test('pdf-notes 声明了 --json 与 --dry-run（机器路径）', () => {
  const b = block()
  assert.match(b, /\.option\('--json'/, '缺 --json')
  assert.match(b, /\.option\('--dry-run'/, '缺 --dry-run')
})

test('pdf-notes 的确认门：没有 --yes 时要求确认', () => {
  const b = block()
  assert.match(b, /CONFIRMATION_REQUIRED/, '缺确认门')
  assert.match(b, /inquirer\.prompt/, '缺交互确认')
})
