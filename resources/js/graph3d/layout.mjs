// 在 Node 里把 3D 布局算好，坐标交给 scripts/graph_3d.py 内联进页面。
//
// 为什么不在浏览器里算：25,431 个点跑 90 tick 实测要 **15.9 秒**，每次打开页面都要等一遍。
// 布局只跟图有关、跟窗口无关，所以算一次存下来最合适 —— 打开即用。
//
// 这里不装 npm 包：d3-force-3d 的 UMD 就是浏览器分支（挂 globalThis.d3），
// 用 new Function 跑一遍就得到同一个 d3，省掉 node_modules。
//
// 用法：node layout.mjs <缓存目录> <库目录> [tick]
// **路径一律走参数**：这个文件原来住在 output/_3d/ 里，并且写死了某台机器的绝对路径。
// 搬进仓库时一并改掉 —— 仓库里的代码不许出现用户的真实路径。
import { readFileSync, writeFileSync } from 'node:fs'

const [cacheDir, libDir, ticksArg] = process.argv.slice(2)
if (!cacheDir || !libDir) {
  console.error('用法：node layout.mjs <缓存目录> <库目录> [tick]')
  process.exit(2)
}
const IN = `${cacheDir}/graph.json`
const OUT = `${cacheDir}/positions.json`
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
const sim = d3.forceSimulation(nodes, 3)
  .force('charge', d3.forceManyBody().strength(-22).distanceMax(600).theta(1.1))
  .force('link', d3.forceLink(L).id((d) => d.id).distance(22).strength(0.6))
  .force('center', d3.forceCenter(0, 0, 0))
  .stop()

const t0 = Date.now()
for (let i = 0; i < TICKS; i += 1) sim.tick()
const ms = Date.now() - t0

// 整数就够：整团云上千单位宽，1 个单位的误差在屏幕上肉眼不可见，但能省一半体积
const flat = nodes.map((n) => `${Math.round(n.x)},${Math.round(n.y)},${Math.round(n.z)}`).join(',')
writeFileSync(OUT, flat)
console.log(`布局 ${nodes.length} 点 / ${L.length} 边，${TICKS} tick 用时 ${(ms / 1000).toFixed(1)} s`)
console.log(`${OUT} ${(flat.length / 1048576).toFixed(2)} MB`)
