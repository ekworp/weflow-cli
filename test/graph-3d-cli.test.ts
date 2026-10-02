/**
 * `wiki graph`：把概念图谱导成一张**自包含**的 3D 页面（只读本地、不联网、不调用模型）。
 *
 * 盯三件"坏了不会有别的东西报错"的事：
 *   1. **自包含**：页面里不许有任何外部引用。它被 `file://` 双击打开 —— 那种情况下 `fetch` 会被
 *      CORS 挡死，所以库、数据、坐标全部内联。哪天有人图省事把 CDN 引回来，页面就白屏，
 *      而所有别的测试照样绿。
 *   2. **库随包发**：`resources/js/graph3d/` 少一个文件，页面会在 `new Function` 里炸，
 *      报错长得像"库坏了"（缺件时是 `u.timer is not a function`）。这条还顺带盯着
 *      `graph_3d.py` 与 `layout.mjs` 那两份库清单**必须一致** —— 页面与布局用的是同一套 UMD。
 *   3. **不许踩真实缓存**：布局缓存在 `output/.graph3d-cache/`（几万个坐标，重算要几分钟）。
 *      测试一律 `--cache` 指到临时目录 —— 第一版没这个开关，测试直接把真实缓存覆盖成了三节点的
 *      fixture（后台正在算的那次就撞上了）。这类"测试踩用户数据"不会有任何断言报错。
 *
 * 全程用**临时 Vault**（三张概念页互链）、临时输出、临时缓存，不读也不写真数据。
 *
 * （另一件量过但不写成断言的事：脚本里那行 `os.chdir(REPO)` 是防御性的 ——
 * 实测把 `wiki_lint.CARD_DIRS` 变回 cwd 相关，本脚本的输出**一点不变**（`collect` 收了这个参数
 * 却在函数体里没用过），所以"换个目录跑答案一样"是一条**不可能红**的断言，没写。）
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const ROOT = process.cwd()
const GRAPH_DIR = join(ROOT, 'resources', 'js', 'graph3d')
// 与 `graph_3d.py` 的 LIB_D3 + LIB_THREE、`layout.mjs` 的 LIBS 应当完全一致
const LIBS = ['three.min.js', 'd3-dispatch.min.js', 'd3-timer.min.js', 'd3-quadtree.min.js',
  'd3-binarytree.min.js', 'd3-octree.min.js', 'd3-force-3d.min.js']
const python = process.platform === 'win32' ? 'python' : 'python3'

function concept(title: string, body: string) {
  return `---\ntitle: "${title}"\ntype: concept\ntags: [知识/概念]\n---\n\n# ${title}\n\n${body}\n`
}

/** 甲 → 乙 → 丙 → 甲：3 个点、3 条边。 */
function fixtureVault(dir: string): string {
  const wiki = join(dir, 'Wiki', 'Concepts')
  mkdirSync(wiki, { recursive: true })
  writeFileSync(join(wiki, '甲.md'), concept('甲', '甲的定义。见 [[乙]]。'), 'utf8')
  writeFileSync(join(wiki, '乙.md'), concept('乙', '乙的定义。见 [[丙]]。'), 'utf8')
  writeFileSync(join(wiki, '丙.md'), concept('丙', '丙的定义。见 [[甲]]。'), 'utf8')
  return dir
}

function runGraph(cwd: string, args: string[]) {
  // `--cache` 一律指到临时目录：真实缓存是派生数据，重算要几分钟，测试不该碰它。
  return spawnSync(python, [join(ROOT, 'scripts', 'graph_3d.py'), '--cache', join(cwd, 'cache'), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 300_000,
  })
}

function payload(stdout: string): any {
  const start = stdout.indexOf('{')
  assert.ok(start >= 0, `没有 JSON 输出：${stdout.slice(0, 300)}`)
  return JSON.parse(stdout.slice(start))
}

function withTemp(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'weflow-graph3d-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('三张互链的概念页 → 3 点 3 边，且页面完全自包含（没有任何外部引用）', () => {
  withTemp((tmp) => {
    const vault = fixtureVault(join(tmp, 'vault'))
    const out = join(tmp, 'graph.html')
    // **故意在临时目录里跑**（cwd 不是仓库）：页面与产出都不该因此变形
    const r = runGraph(tmp, ['--vault', vault, '--out', out, '--json'])
    assert.equal(r.status, 0, `退出码 ${r.status}：${r.stderr.slice(0, 400)}`)
    const body = payload(r.stdout)
    assert.equal(body.success, true)
    assert.equal(body.nodes, 3, `节点数不对：${JSON.stringify(body)}`)
    assert.equal(body.links, 3, `边数不对：${JSON.stringify(body)}`)
    assert.equal(body.sendsNothing, true)

    assert.ok(existsSync(out), '页面该写出来了')
    const html = readFileSync(out, 'utf8')
    assert.ok(/window\.__DATA__/.test(html), '数据要内联进去')
    assert.ok(/Three\.js Authors/.test(html), 'three.js 要内联进去（而不是引外部文件）')
    // 这两条是"自包含"的全部意思：没有 CDN、也没有 `<script src>`
    assert.ok(!/\b(?:src|href)\s*=\s*["']https?:/i.test(html), '不许有外部 http(s) 引用')
    assert.ok(!/<script[^>]+\bsrc=/i.test(html), '不许有 <script src> —— 库必须内联')
  })
})

test('库齐全，且两份清单一致（页面与布局用的是同一套 UMD）', () => {
  for (const name of LIBS) {
    assert.ok(existsSync(join(GRAPH_DIR, name)), `缺库：${name}（页面会在 new Function 里炸）`)
  }
  assert.ok(existsSync(join(GRAPH_DIR, 'layout.mjs')), '缺布局助手')
  assert.ok(existsSync(join(GRAPH_DIR, 'NOTICE.txt')), '第三方库的许可与版本要记在 NOTICE.txt 里')

  const py = readFileSync(join(ROOT, 'scripts', 'graph_3d.py'), 'utf8')
  const mjs = readFileSync(join(GRAPH_DIR, 'layout.mjs'), 'utf8')
  for (const name of LIBS.filter((n) => n !== 'three.min.js')) {
    assert.ok(py.includes(`'${name}'`), `graph_3d.py 的 LIB_D3 少了 ${name}`)
    assert.ok(mjs.includes(`'${name}'`), `layout.mjs 的 LIBS 少了 ${name}`)
  }
  assert.ok(py.includes("'three.min.js'"), 'graph_3d.py 少了 three')
})

test('--dry-run 真的不写文件（只报数）', () => {
  withTemp((tmp) => {
    const vault = fixtureVault(join(tmp, 'vault'))
    const out = join(tmp, 'nope.html')
    const r = runGraph(tmp, ['--vault', vault, '--out', out, '--dry-run', '--json'])
    assert.equal(r.status, 0, r.stderr.slice(0, 300))
    const body = payload(r.stdout)
    assert.equal(body.dryRun, true)
    assert.equal(body.nodes, 3)
    assert.ok(!existsSync(out), '--dry-run 不许写文件')
  })
})

test('手跑（没有 CLI 的 PYTHONIOENCODING）时中文也不会崩，也不该是乱码', () => {
  withTemp((tmp) => {
    const vault = fixtureVault(join(tmp, 'vault'))
    // 故意**不带** PYTHONIOENCODING：这正是评审能手跑时的环境（这台机器是 GBK）。
    // 脚本里那行 `sys.stdout.reconfigure(encoding='utf-8')` 就是为这个场景写的。
    const env = { ...process.env }
    delete (env as any).PYTHONIOENCODING
    const r = spawnSync(python, [join(ROOT, 'scripts', 'graph_3d.py'),
      '--cache', join(tmp, 'cache'), '--vault', vault, '--out', join(tmp, 'g.html'), '--dry-run'],
      { cwd: tmp, env, encoding: 'buffer' as any, timeout: 120_000 })
    assert.equal(r.status, 0, `退出码 ${r.status}：${String(r.stderr).slice(0, 300)}`)
    const out = Buffer.from(r.stdout as any).toString('utf8')
    assert.ok(out.includes('概念'), `stdout 该是可读的 UTF-8 中文，实际 ${JSON.stringify(out.slice(0, 120))}`)
  })
})

test('布局缓存在用：同一个缓存跑第二次沿用，换一个空缓存就重算', () => {
  withTemp((tmp) => {
    const vault = fixtureVault(join(tmp, 'vault'))
    const a = join(tmp, 'a')
    const b = join(tmp, 'b')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    const outOf = (dir: string) => join(dir, 'graph.html')
    const first = runGraph(a, ['--vault', vault, '--out', outOf(a), '--json'])
    assert.ok(!/图没变/.test(first.stdout), '空缓存不该说"图没变"')
    assert.ok(existsSync(join(a, 'cache', 'graph.json')), '缓存要落到 --cache 指的目录里（而不是真实那份）')
    const again = runGraph(a, ['--vault', vault, '--out', outOf(a), '--json'])
    assert.ok(/图没变/.test(again.stdout), '同一个缓存跑第二次该沿用已有布局')
    const fresh = runGraph(b, ['--vault', vault, '--out', outOf(b), '--json'])
    assert.ok(!/图没变/.test(fresh.stdout), '换了个空缓存目录就该重算')
  })
})
