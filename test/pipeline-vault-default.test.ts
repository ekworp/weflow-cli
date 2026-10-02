/**
 * pipeline 默认**不写** Obsidian Vault（用户 2026-10-03 要的："图谱要我说了才重建"）。
 *
 * 为什么是静态断言而不是真跑一遍：真跑要抓网络、要 key、几十秒，而这条要防的退步非常具体 ——
 * 有人把 `--with-vault` 改回"默认做、可 `--skip`"，于是"公众号内容一更新图谱就重建"又回来了，
 * 而**别的测试一条都不会红**（写 vault 成功本来就没人断言，它就是那么安静）。
 *
 * 依据是量到的事实：**Obsidian 自带的图谱视图是实时的** —— 它盯着 vault 里的文件，文件一变就重画，
 * 从外面没法暂停。所以"要不要重建图谱"唯一的杠杆就是"要不要写 vault"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PIPELINE = readFileSync(join(process.cwd(), 'scripts', 'pipeline.py'), 'utf8')
const CLI = readFileSync(join(process.cwd(), 'bin', 'weflow-cli.ts'), 'utf8')

test('pipeline：写 Vault 的两个开关是 opt-in，默认不做', () => {
  assert.match(PIPELINE, /add_argument\('--with-vault'/, '要有 --with-vault')
  assert.match(PIPELINE, /add_argument\('--with-wiki'/, '要有 --with-wiki')
  assert.doesNotMatch(PIPELINE, /add_argument\('--skip-vault'/,
    '不该再有"默认做、可跳过"的那个开关 —— 那正是"一更新就重建图谱"的来源')
  assert.doesNotMatch(PIPELINE, /add_argument\('--skip-wiki'/, '同理')
  // 守卫必须是 `if args.with_vault:`，而不是 `if not args.skip_vault:`
  assert.match(PIPELINE, /^\s+if args\.with_vault:$/m, 'Vault 同步要由 --with-vault 把关')
  assert.match(PIPELINE, /^\s+if args\.with_wiki and not args\.no_ai:$/m, '概念编译要由 --with-wiki 把关')
  // 跳过时要说出来：不然用户只看到"图谱没变"，不知道是设计还是坏了
  assert.match(PIPELINE, /Obsidian 那边没有动/, '跳过时要说明它没动 Obsidian、以及怎么让它动')
})

test('CLI：同名透传，且内部那两处调用不再传已经不存在的开关', () => {
  assert.match(CLI, /\.option\('--with-vault'/, 'CLI 要有 --with-vault')
  assert.match(CLI, /\.option\('--with-wiki'/, 'CLI 要有 --with-wiki')
  assert.doesNotMatch(CLI, /\.option\('--skip-vault'/, '不该再暴露 skip 版本')
  assert.doesNotMatch(CLI, /\.option\('--skip-wiki'/, '同理')
  assert.match(CLI, /if \(opts\.withVault\) args\.push\('--with-vault'\)/, '要透传')
  assert.match(CLI, /if \(opts\.withWiki\) args\.push\('--with-wiki'\)/, '要透传')
  // 内部那两处（助理那条、日报那条）原本传 `--skip-wiki`；那个开关现在不存在了，
  // 再传 pipeline 会直接以"unrecognized arguments"退出 —— 比"多写一次 vault"更糟。
  assert.doesNotMatch(CLI, /'--skip-wiki'/, '内部调用里不许再出现它')
  assert.doesNotMatch(CLI, /'--skip-vault'/, '同理')
})
