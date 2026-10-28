/**
 * CLI 命令面的全部源码：入口 + `src/cli/**`。
 *
 * 命令注册原本全在 `bin/weflow-cli.ts` 一个文件里，静态测试直接读那一个文件；
 * 拆分之后命令散在 `src/cli/commands/*.ts`，所以"CLI 源码"要按**整个命令面**拼起来，
 * 否则这些检查会退化成"读了一个 17 行的入口，什么都没扫到"——一种不会报错、只会静默放过的失效。
 *
 * 拼接顺序固定（入口 → src/cli → src/cli/commands，各自按文件名排序），检查里用到的
 * `.command(...)` / `.action(...)` 标记都落在同一个命令块内，跨文件的边界不会切断它们。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CLI_DIR = join(process.cwd(), 'src', 'cli')

export function cliSourceFiles(): string[] {
  const files = [join(process.cwd(), 'bin', 'weflow-cli.ts')]
  for (const dir of [CLI_DIR, join(CLI_DIR, 'commands')]) {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.ts')) files.push(join(dir, name))
    }
  }
  return files
}

export function readCliSource(): string {
  return cliSourceFiles().map((file) => readFileSync(file, 'utf8')).join('\n')
}
