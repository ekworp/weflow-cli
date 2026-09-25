import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const invalidVaultSearch = ['vault', 'search', 'synthetic', '--type', 'invalid']

test('Python-backed commands propagate failures in source and compiled layouts', () => {
  const source = spawnSync(process.execPath, [
    '--import', 'tsx', join(process.cwd(), 'bin', 'weflow-cli.ts'), ...invalidVaultSearch,
  ], { cwd: process.cwd(), encoding: 'utf8' })

  assert.equal(source.status, 1, source.stderr || source.stdout)

  const compiled = spawnSync(process.execPath, [join(process.cwd(), 'cli.cjs'), ...invalidVaultSearch], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  const output = `${compiled.stdout}\n${compiled.stderr}`

  assert.equal(compiled.status, 1, output)
  assert.equal(output.includes("can't open file"), false, output)
})

test('Semantic index writes require a read-only preview and explicit confirmation', () => {
  const entry = join(process.cwd(), 'bin', 'weflow-cli.ts')
  const preview = spawnSync(process.execPath, [
    '--import', 'tsx', entry, 'search-index', '--full', '--dry-run', '--json',
  ], { cwd: process.cwd(), encoding: 'utf8' })

  assert.equal(preview.status, 0, preview.stderr || preview.stdout)
  // `chatDays` / `articleDays` 是窗口（原来写死在脚本里、预览里一个字都不提）：
  // 天数越多，发给向量服务的文本越多，所以预览必须把它算作**代价的一部分**说出来。
  assert.deepEqual(JSON.parse(preview.stdout), {
    success: true,
    dryRun: true,
    action: 'search-index.build',
    mode: 'full',
    chatDays: 90,
    articleDays: 30,
    readsLocalData: true,
    usesCloudEmbedding: true,
    replacesExistingIndex: true,
  })

  const refused = spawnSync(process.execPath, [
    '--import', 'tsx', entry, 'search-index', '--json',
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(refused.status, 1, refused.stderr || refused.stdout)
  assert.equal(JSON.parse(refused.stdout).code, 'CONFIRMATION_REQUIRED')
})

test('The index window is adjustable, and a bad one is refused before anything is read', () => {
  // 窗口原先写死在脚本的两处调用里（聊天 90 天 / 日报 30 个日期目录）——用户既看不见也改不了，
  // 而"知识库只有三个月记忆"正是这个数字造成的。预览里报的就是真跑的那些（同一处算出来的）。
  const entry = join(process.cwd(), 'bin', 'weflow-cli.ts')
  const run = (extra: string[]) => spawnSync(process.execPath,
    ['--import', 'tsx', entry, 'search-index', '--dry-run', '--json', ...extra],
    { cwd: process.cwd(), encoding: 'utf8' })

  const wide = run(['--days', '3650', '--article-days', '365'])
  assert.equal(wide.status, 0, wide.stderr || wide.stdout)
  assert.equal(JSON.parse(wide.stdout).chatDays, 3650)
  assert.equal(JSON.parse(wide.stdout).articleDays, 365)

  // 0 / 过大 / 非数字：**在动任何东西之前**拒掉。0 天最阴——它会建出一个空索引，
  // 而结果看起来像"建好了"；过大则让一次构建变成全库穿透。
  for (const bad of [['--days', '0'], ['--days', '99999'], ['--article-days', 'nope']]) {
    const out = run(bad)
    assert.equal(out.status, 1, `${bad.join(' ')} 应当被拒，而不是悄悄退回默认值`)
    assert.equal(JSON.parse(out.stdout).code, 'INVALID_ARGUMENT')
  }

  // CLI → 脚本那一段只有**静态断言**：真验它要跑一次索引（读真库 + 联网），在测试里又慢又越界。
  // 而这段断掉恰好是最坏的一种：预览报 3650 天、脚本实际按 90 天跑，用户被自己的工具误导。
  const source = readFileSync(join(process.cwd(), 'bin', 'weflow-cli.ts'), 'utf8')
  assert.match(source, /'--days', String\(chatDays\)/, '窗口要真的传给脚本，不能只印在预览里')
  assert.match(source, /'--article-days', String\(articleDays\)/)
})

test('Knowledge and WeRead limits reject coercion hazards before external access', () => {
  const entry = join(process.cwd(), 'bin', 'weflow-cli.ts')
  const commands = [
    ['search', 'synthetic', '--top-k', '1.5'],
    ['chat', 'synthetic', '--top-k', '101', '--json'],
    ['weread', 'search', 'synthetic', '--limit', 'not-a-number', '--json'],
    ['vault', 'search', 'synthetic', '--top-k', '101'],
    ['vault', 'rag', 'synthetic', '--top-k', '0'],
  ]

  for (const args of commands) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(result.stdout, /必须是/)
  }
})

test('Knowledge pipeline exposes a side-effect-free no-AI preview', () => {
  const entry = join(process.cwd(), 'bin', 'weflow-cli.ts')
  const preview = spawnSync(process.execPath, [
    '--import', 'tsx', entry,
    'pipeline', 'run',
    '--date', '2026-09-08',
    '--source', '示例来源一',
    '--source', '示例来源二',
    '--no-ai',
    '--dry-run',
    '--json',
  ], { cwd: process.cwd(), encoding: 'utf8' })

  assert.equal(preview.status, 0, preview.stderr || preview.stdout)
  const data = JSON.parse(preview.stdout)
  assert.equal(data.action, 'pipeline.run')
  assert.equal(data.sourceCount, 2)
  assert.equal(data.aiEnabled, false)
  assert.equal(data.cloudAiEnabled, false)
  assert.equal(data.vaultSyncEnabled, true)

  const refused = spawnSync(process.execPath, [
    '--import', 'tsx', entry, 'pipeline', 'run', '--no-ai', '--json',
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(refused.status, 1, refused.stderr || refused.stdout)
  assert.equal(JSON.parse(refused.stdout).code, 'CONFIRMATION_REQUIRED')

  const invalidDate = spawnSync(process.execPath, [
    '--import', 'tsx', entry, 'pipeline', 'run', '--date', '2026-02-30', '--dry-run', '--json',
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(invalidDate.status, 1, invalidDate.stderr || invalidDate.stdout)
  assert.equal(JSON.parse(invalidDate.stdout).code, 'INVALID_DATE')
})

test('Report generators expose content-free previews and reject unconfirmed JSON writes', () => {
  const entry = join(process.cwd(), 'bin', 'weflow-cli.ts')
  const previewCommands = [
    ['report', '--month', '2026-09', '--talker', '示例一', '--talker', '示例二', '--no-ai', '--dry-run', '--json'],
    ['review', '--date', '2026-09-08', '--engine', 'ollama', '--dry-run', '--json'],
    ['annual-report', '2026', '--skip-ai', '--dry-run', '--json'],
  ]

  const previews = previewCommands.map(args => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return JSON.parse(result.stdout)
  })

  assert.equal(previews[0].talkerCount, 2)
  assert.equal(previews[0].aiEnabled, false)
  assert.equal(previews[1].usesAi, true)
  assert.equal(previews[2].aiEnabled, false)

  for (const command of ['report', 'review', 'annual-report']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', entry, command, '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.equal(JSON.parse(result.stdout).code, 'CONFIRMATION_REQUIRED')
  }
})

test('Vault and daily-favorite mutations expose content-free previews', () => {
  const entry = join(process.cwd(), 'bin', 'weflow-cli.ts')
  const commands: Array<{ args: string[]; action: string }> = [
    { args: ['vault', 'enrich', '--date', '2026-09-08'], action: 'vault.enrich' },
    { args: ['vault', 'notes', '--date', '2026-09-08'], action: 'vault.notes' },
    { args: ['vault', 'tag', '--date', '2026-09-08', '--force'], action: 'vault.tag' },
    { args: ['vault', 'sync-weread', '--type', 'notes'], action: 'vault.sync-weread' },
    { args: ['vault', 'promote', 'ideas', '--with-ai'], action: 'vault.promote.ideas' },
    { args: ['vault', 'promote', 'all'], action: 'vault.promote.all' },
    { args: ['wiki', 'compile', '--limit', '20'], action: 'wiki.compile' },
    { args: ['todos', 'extract', '--days', '7'], action: 'todos.extract' },
    { args: ['chat-stats', '--period', 'week'], action: 'chat-stats.generate' },
    { args: ['daily', 'favorites', 'sync', '--date', '2026-09-08'], action: 'daily.favorites.sync' },
    { args: ['daily', 'favorites', 'add', 'AI/synthetic.md', '--date', '2026-09-08'], action: 'daily.favorites.add' },
    { args: ['daily', 'favorites', 'remove', 'AI/synthetic.md', '--date', '2026-09-08'], action: 'daily.favorites.remove' },
  ]

  for (const command of commands) {
    const preview = spawnSync(process.execPath, [
      '--import', 'tsx', entry, ...command.args, '--dry-run', '--json',
    ], { cwd: process.cwd(), encoding: 'utf8' })
    assert.equal(preview.status, 0, preview.stderr || preview.stdout)
    const data = JSON.parse(preview.stdout)
    assert.equal(data.action, command.action)
    assert.equal(data.dryRun, true)
    assert.equal(preview.stdout.includes(process.cwd()), false)
  }

  const refused = spawnSync(process.execPath, [
    '--import', 'tsx', entry, 'daily', 'favorites', 'sync', '--date', '2026-09-08', '--json',
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(refused.status, 1, refused.stderr || refused.stdout)
  assert.equal(JSON.parse(refused.stdout).code, 'CONFIRMATION_REQUIRED')
})
