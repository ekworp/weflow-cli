import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

/**
 * `skill` / `scene` 两个命令组：注册（D-018）、以及**写操作那道门**。
 *
 * 盯的是三件静默失败的事：
 * 1. 命令在 capabilities 里没登记 —— 机器调用方看不见它，等于没做；
 * 2. `scene add` 不带 `--yes` 就写了 —— 配置被一条脚本改掉，用户没同意过；
 * 3. 技能目录配错（根目录不存在）时不说出来 —— 用户只会看到"一个技能都没有"。
 */
function runCli(home: string, args: string[]) {
  return spawnSync(process.execPath, [
    '--import', 'tsx', join(process.cwd(), 'bin', 'weflow-cli.ts'), ...args,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  })
}

function payload(stdout: string): any {
  const start = stdout.indexOf('{')
  if (start < 0) throw new Error(`no JSON payload in output: ${stdout.slice(0, 300)}`)
  return JSON.parse(stdout.slice(start))
}

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'weflow-skillscene-'))
  try {
    run(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('skill / scene 都在 capabilities 里登记（D-018）', () => {
  withHome((home) => {
    const body = payload(runCli(home, ['capabilities', '--json']).stdout)
    const skills = body.workflows?.skills
    assert.ok(skills, 'skill 应当登记在 capabilities 里')
    assert.equal(skills.installsAnything, false, 'v1 没有安装器——这一条必须如实')
    assert.equal(skills.grantsTools, false, '装技能不给模型加工具')
    assert.equal(skills.executesSkillCode, false)

    const scenes = body.workflows?.scenes
    assert.ok(scenes, 'scene 应当登记在 capabilities 里')
    assert.equal(scenes.confirmationRequired, true)
    assert.equal(scenes.modelWritable, false, '场景不许模型改')
    assert.equal(scenes.invokesAI, false)
  })
})

test('skill check：技能目录不存在时说清是"目录没配对"，并且体检通过（不是失败）', () => {
  withHome((home) => {
    const empty = join(home, '空的技能目录')
    const r = runCli(home, ['skill', 'check', '--json'])
    const body = payload(r.stdout)
    assert.equal(body.success, true)
    // 临时 HOME 下两个默认根都不存在 → 要报出来（配错目录不能表现为"没有技能"）
    assert.ok(body.missingRoots.length >= 1, '不存在的根目录必须报出来')
    assert.equal(body.total, 0)
    assert.equal(body.unreadable.length, 0)
    void empty
  })
})

test('skill list/check：能扫到临时目录里的技能（靠 WEFLOW_ASSISTANT_SKILL_DIRS）', () => {
  withHome((home) => {
    const root = join(home, 'skills')
    mkdirSync(join(root, 'demo-skill'), { recursive: true })
    writeFileSync(join(root, 'demo-skill', 'SKILL.md'),
      '---\nname: 演示技能\ndescription: 演示用\n---\n\n# 正文\n', 'utf8')
    const env = { ...process.env, HOME: home, USERPROFILE: home, WEFLOW_ASSISTANT_SKILL_DIRS: root }
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(process.cwd(), 'bin', 'weflow-cli.ts'),
      'skill', 'check', '--json'], { cwd: process.cwd(), encoding: 'utf8', env })
    const body = payload(r.stdout)
    assert.equal(body.total, 1, `应当扫到那一个技能，输出：${r.stdout.slice(0, 200)}`)
    assert.equal(body.unreadable.length, 0)
    assert.deepEqual(body.missingRoots, [])
  })
})

test('scene 写操作：不带 --yes 一律拦住，带了才写', () => {
  withHome((home) => {
    const add = ['scene', 'add', '--id', '日报', '--name', '日报整理',
      '--keywords', '日报,推文', '--instruction', '按主题分组']

    // 1) 拦：不带 --yes 不许写
    const blocked = runCli(home, [...add, '--json'])
    assert.equal(blocked.status, 1, '不带 --yes 必须非零退出')
    const blockedBody = payload(blocked.stdout)
    assert.equal(blockedBody.code, 'CONFIRMATION_REQUIRED')
    assert.match(blockedBody.error, /--dry-run/)
    assert.equal(runCli(home, ['scene', 'list', '--json']).stdout.includes('日报'), false,
      '被拦住时**不能**已经写进去了')

    // 2) 预览：报出将要写什么，但不写
    const preview = payload(runCli(home, [...add, '--dry-run', '--json']).stdout)
    assert.equal(preview.dryRun, true)
    assert.equal(preview.action, 'scene.add')
    assert.equal(runCli(home, ['scene', 'list', '--json']).stdout.includes('日报'), false,
      '预览不许写')

    // 3) 确认：这才写
    const done = payload(runCli(home, [...add, '--yes', '--json']).stdout)
    assert.equal(done.success, true)
    const listed = payload(runCli(home, ['scene', 'list', '--json']).stdout)
    assert.equal(listed.total, 1)
    assert.equal(listed.scenes[0].id, '日报')
    assert.deepEqual(listed.scenes[0].keywords, ['日报', '推文'])

    // 4) 绑定也是写操作：同样要 --yes
    const bindBlocked = runCli(home, ['scene', 'bind', 'wxid_x', '--scene', '日报', '--json'])
    assert.equal(bindBlocked.status, 1)
    assert.equal(payload(bindBlocked.stdout).code, 'CONFIRMATION_REQUIRED')
    const bindOk = payload(runCli(home, ['scene', 'bind', 'wxid_x', '--scene', '日报', '--yes', '--json']).stdout)
    assert.equal(bindOk.success, true)

    // 5) 重复 id 与保留字：都拒
    const dup = runCli(home, [...add, '--yes', '--json'])
    assert.equal(dup.status, 1)
    assert.match(payload(dup.stdout).error, /已经存在/)
    const reserved = runCli(home, ['scene', 'add', '--id', '无', '--yes', '--json'])
    assert.equal(reserved.status, 1)
    assert.match(payload(reserved.stdout).error, /保留字/)
  })
})
