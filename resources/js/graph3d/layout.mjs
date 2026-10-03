// 在 Node 里把 3D 布局算好，坐标交给 scripts/graph_3d.py 内联进页面。
//
// 为什么不在浏览器里算：25,431 个点跑 90 tick 实测要 **15.9 秒**，每次打开页面都要等一遍。
// 布局只跟图有关、跟窗口无关，所以算一次存下来最合适 —— 打开即用。
//
// 这里不装 npm 包：d3-force-3d 的 UMD 就是浏览器分支（挂 globalThis.d3），
// 用 new Function 跑一遍就得到同一个 d3，省掉 node_modules。
//
// 用法：node layout.mjs <缓存目录> <库目录> [tick] [digest] [dims]
//
// `dims=2` 走 2D 力导向（`forceCenter(0,0)`）：**不是把 3D 的 x/y 拍扁** —— 那一维也承载结构，
// 拍扁会把两团本不相干的点叠在一起。2D 的解也更省（快的不是一个量级），所以同一张图重算得起。
//
// **路径一律走参数**：这个文件原来住在 output/_3d/ 里，并且写死了某台机器的绝对路径。
// 搬进仓库时一并改掉 —— 仓库里的代码不许出现用户的真实路径。
import { readFileSync, writeFileSync } from 'node:fs'

const [cacheDir, libDir, ticksArg, digest, dimsArg, paramsArg] = process.argv.slice(2)
if (!cacheDir || !libDir) {
  console.error('用法：node layout.mjs <缓存目录> <库目录> [tick] [digest] [dims] [params-json]')
  process.exit(2)
}
const DIMS = Number(dimsArg || 3) === 2 ? 2 : 3
// digest 是图内容的哈希（含维度）：核心图与全量图、2D 与 3D 各存一份坐标
// （见 graph_3d.py / graph_2d.py 里那段注释）
const suffix = digest ? `-${digest}` : ''
const IN = `${cacheDir}/graph${suffix}.json`
const OUT = `${cacheDir}/positions${suffix}.json`
const TICKS = Number(ticksArg || 250)

const LIBS = ['d3-dispatch.min.js', 'd3-timer.min.js', 'd3-quadtree.min.js',
  'd3-binarytree.min.js', 'd3-octree.min.js', 'd3-force-3d.min.js']
const code = LIBS.map((f) => readFileSync(`${libDir}/${f}`, 'utf8')).join('\n')
new Function(code)()
const d3 = globalThis.d3
if (!d3?.forceSimulation) {
  console.error('d3 没挂上 globalThis，检查 UMD 列表')
  process.exit(1)
}

const { nodes, links } = JSON.parse(readFileSync(IN, 'utf8'))
const L = links.map(([source, target]) => ({ source, target }))
// 力参数**由调用方给**（graph_3d.py 的 LAYOUT_PARAMS），这里只照做：参数放两处迟早会分叉，
// 而它们还得计入缓存 key（改了参数却读到旧坐标，这个坑踩过一次）。
const P = paramsArg ? JSON.parse(paramsArg) : { charge: -22, chargeMax: 600, linkDist: 22, linkStrength: 0.6 }
const sim = d3.forceSimulation(nodes, DIMS)
  .force('charge', d3.forceManyBody().strength(P.charge).distanceMax(P.chargeMax).theta(1.1))
  .force('link', d3.forceLink(L).id((d) => d.id).distance(P.linkDist).strength(P.linkStrength))
  .force('center', DIMS === 2 ? d3.forceCenter(0, 0) : d3.forceCenter(0, 0, 0))
  .stop()

const t0 = Date.now()
for (let i = 0; i < TICKS; i += 1) sim.tick()
const ms = Date.now() - t0

// 整数就够：整团云上千单位宽，1 个单位的误差在屏幕上肉眼不可见，但能省一半体积
const coords = (n) => (DIMS === 2
  ? `${Math.round(n.x)},${Math.round(n.y)}`
  : `${Math.round(n.x)},${Math.round(n.y)},${Math.round(n.z)}`)
const flat = nodes.map(coords).join(',')
writeFileSync(OUT, flat)
console.log(`布局 ${nodes.length} 点 / ${L.length} 边，${TICKS} tick 用时 ${(ms / 1000).toFixed(1)} s`)
console.log(`${OUT} ${(flat.length / 1048576).toFixed(2)} MB`)
