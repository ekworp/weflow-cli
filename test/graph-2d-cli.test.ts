/**
 * `wiki graph --flat`：2D 版图谱（canvas 平面图，更像 Obsidian 那种）。
 *
 * 盯三件事：
 *
 *   1. **它真的会画。** 拿构建出来的数据在**假 canvas** 上跑一遍，数 `arc` / `lineTo` / `fillText`
 *      各落了多少笔。这个仓库有过"JS 一报错，后面的图全都不出现，而没有任何断言会红"的教训 ——
 *      我也没法在这儿肉眼看它画成什么样，但能证明它**落笔了**。假 canvas 的每个方法记一笔调用，
 *      属性赋值（fillStyle 之类）照收不误。
 *   2. **2D 页面里一个库都没有。** 自包含在 3D 那份是"内联 three.js + d3"，在这里更强：
 *      布局在构建期做完了，渲染是裸 canvas —— 所以页面里不该出现 `Three.js Authors`，
 *      也不该有任何外部引用。
 *   3. **坐标是 2D 的**（每点两个数）。把 3D 的 x/y 拍扁也"能看"，但 z 那一维承载的结构就没了，
 *      所以布局必须按 2D 重算 —— 这条断言盯的就是"确实重算了"，而不是复用了一份三维坐标。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const ROOT = process.cwd()
const python = process.platform === 'win32' ? 'python' : 'python3'
const VIEWER = readFileSync(join(ROOT, 'resources', 'js', 'graph3d', 'viewer2d.js'), 'utf8')

function concept(title: string, body: string) {
  return `---\ntitle: "${title}"\ntype: concept\ntags: [知识/概念]\n---\n\n# ${title}\n\n${body}\n`
}

/** 甲 → 乙/丙，乙 → 甲：3 个点、3 条有向边。 */
function fixtureVault(dir: string): string {
  const wiki = join(dir, 'Wiki', 'Concepts')
  mkdirSync(wiki, { recursive: true })
  writeFileSync(join(wiki, '甲.md'), concept('甲', '见 [[乙]] [[丙]]。'), 'utf8')
  writeFileSync(join(wiki, '乙.md'), concept('乙', '见 [[甲]]。'), 'utf8')
  writeFileSync(join(wiki, '丙.md'), concept('丙', '不引用别人。'), 'utf8')
  return dir
}

function run2d(cwd: string, args: string[]) {
  return spawnSync(python, [join(ROOT, 'scripts', 'graph_2d.py'), '--cache', join(cwd, 'cache'), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 300_000,
  })
}

function payload(stdout: string): any {
  const at = stdout.indexOf('{')
  assert.ok(at >= 0, `没有 JSON：${stdout.slice(0, 300)}`)
  return JSON.parse(stdout.slice(at))
}

function withTemp(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'weflow-graph2d-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 记下每次方法调用的假 2D 上下文；属性赋值一律照收。 */
function fakeContext(calls: Record<string, number>) {
  return new Proxy({} as any, {
    get(_target, prop: string) {
      if (prop === 'then') return undefined
      return () => { calls[prop] = (calls[prop] || 0) + 1 }
    },
    set() { return true },
  })
}

test('构建：3 点 3 边，页面里一个外部引用、一行 three.js 都没有，坐标是 2D', () => {
  withTemp((tmp) => {
    const vault = fixtureVault(tmp)
    const out = join(tmp, 'g2.html')
    const r = run2d(tmp, ['--vault', vault, '--out', out, '--json'])
    assert.equal(r.status, 0, `退出码 ${r.status}：${r.stderr.slice(0, 400)}`)
    const body = payload(r.stdout)
    assert.equal(body.nodes, 3)
    assert.equal(body.links, 3)
    assert.equal(body.dims, 2)

    const html = readFileSync(out, 'utf8')
    assert.ok(!/\b(?:src|href)\s*=\s*["']https?:/i.test(html), '不许有外部引用')
    assert.ok(!/<script[^>]+\bsrc=/i.test(html), '不许有 <script src>')
    assert.ok(!/Three\.js Authors/.test(html), '2D 页面不该内联 three.js —— 它一行库都不需要')

    // `#cv` 必须**显式**给 width/height。canvas 是**替换元素**：`position:fixed; inset:0` 不会让它
    // 铺满（right/bottom 被忽略，它保持固有的 300x150），于是 clientWidth 读回来是 300，
    // 整张图被算进左上角那一小块 —— 用户第一眼就是这个症状。
    const cvRule = /#cv\s*\{[^}]*\}/.exec(html)
    assert.ok(cvRule, '样式里该有 #cv 规则')
    assert.ok(/width\s*:\s*100%/.test(cvRule[0]), `#cv 要显式给宽度：${cvRule[0]}`)
    assert.ok(/height\s*:\s*100%/.test(cvRule[0]), `#cv 要显式给高度：${cvRule[0]}`)

    const flat = /window\.__POS__ = "([^"]*)";/.exec(html)
    assert.ok(flat, '页面上要有坐标')
    const nums = flat[1].split(',')
    assert.equal(nums.length, 3 * 2, `2D 要每个点两个数，实际 ${nums.length}`)
  })
})

test('渲染：拿构建出来的数据在假 canvas 上跑一遍，点线字都要落笔', () => {
  withTemp((tmp) => {
    const vault = fixtureVault(tmp)
    const out = join(tmp, 'g2.html')
    const built = run2d(tmp, ['--vault', vault, '--out', out, '--json'])
    assert.equal(built.status, 0, built.stderr.slice(0, 300))
    const html = readFileSync(out, 'utf8')
    const data = /window\.__DATA__ = (\{.*?\});/s.exec(html)
    const pos = /window\.__POS__ = "([^"]*)";/.exec(html)
    assert.ok(data && pos, '页面上该有 __DATA__ 与 __POS__')

    const calls: Record<string, number> = {}
    const ctx = fakeContext(calls)
    const dom = new JSDOM(`<canvas id="cv"></canvas>
      <div id="hud"><div id="stats"></div><div id="info"></div></div>
      <input id="q"><div id="boot"></div>`, { runScripts: 'outside-only' })
    const { window } = dom
    ;(window as any).HTMLCanvasElement.prototype.getContext = (() => ctx) as any
    ;(window as any).__DATA__ = JSON.parse(data![1])
    ;(window as any).__POS__ = pos![1]
    try {
      window.eval(VIEWER)
    } catch (error) {
      assert.fail(`视图脚本抛异常（页面会是一片空白）：${String(error)}`)
    }

    const g2 = (window as any).__GRAPH2D__
    assert.ok(g2, '视图该把把手挂出来')
    assert.equal(g2.nodes, 3)
    assert.equal(g2.edges, 3)
    assert.ok((calls.arc || 0) >= 3, `3 个点该落 3 笔 arc，实际 ${calls.arc || 0}`)
    assert.ok((calls.lineTo || 0) >= 3, `3 条边该落 3 笔 lineTo，实际 ${calls.lineTo || 0}`)
    assert.ok((calls.fillText || 0) >= 1, `该画出概念名，实际 ${calls.fillText || 0}`)
    assert.ok((calls.fill || 0) >= 1, '点要真的填色')
    assert.ok((calls.stroke || 0) >= 1, '线要真的描边')
    assert.ok((calls.clearRect || 0) >= 1, '每帧要先清屏')

    // 画布的 CSS 尺寸与后备缓冲都要被设上。**只设后备缓冲是不够的** —— 页面里那块 canvas 仍然是
    // 300x150，clientWidth 一直是 300，图缩在左上角。（jsdom 的 clientWidth 是 0，这里走的是
    // window.innerWidth 那条兜底，所以这个断言在两种环境下都成立。）
    const cv = window.document.getElementById('cv') as any
    assert.equal(cv.style.width, `${window.innerWidth}px`, '要把画布的 CSS 宽度设成视口宽')
    assert.equal(cv.style.height, `${window.innerHeight}px`, '高度同理')
    assert.ok(cv.width > 0 && cv.height > 0, '后备缓冲也要有尺寸')
    assert.ok(cv.width >= window.innerWidth, `后备缓冲不该小于视口：${cv.width}`)
  })
})

test('CLI：--flat 走 2D 入口（声明、路由、透传三处都在）', () => {
  withTemp((tmp) => {
    const vault = fixtureVault(tmp)
    const home = join(tmp, 'home')
    mkdirSync(home, { recursive: true })
    const out = join(tmp, 'cli.html')
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'bin', 'weflow-cli.ts'),
      'wiki', 'graph', '--flat', '--vault', vault, '--out', out,
      '--cache', join(tmp, 'clicache'), '--json'], {
      cwd: ROOT, encoding: 'utf8', timeout: 300_000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    })
    assert.equal(r.status, 0, `退出码 ${r.status}：${r.stderr.slice(0, 400)}`)
    const body = payload(r.stdout)
    assert.equal(body.action, 'graph-2d', '--flat 该路由到 2D 那个脚本')
    assert.equal(body.dims, 2)
    assert.equal(body.nodes, 3)
    assert.ok(existsSync(out), '页面该写出来')
  })
})
