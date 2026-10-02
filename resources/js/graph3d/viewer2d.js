// 2D 图谱视图（canvas）。数据与坐标都是构建期内联进来的，这里只负责画与交互。
//
// 为什么是 canvas 而不是 SVG/DOM：5 万个点用元素画，光建元素就要几秒 —— 这和 Obsidian 全局图谱
// 在十万级上吃力的原因同类。这里每帧只做三件事：一次批量描线、按线分三批批量填点、一小批文字。
// 视口外的点与线直接跳过（所以缩放到任何一级，画的都只是眼前这些）。
//
// 坐标分两套，别混：**世界坐标**（构建期算出来的那套，成千上万）用来画点线，套在 context 变换里；
// **屏幕坐标**用来写字与命中判断。第一版把两套混着用，图形会被画到屏幕外。
//
// 标签只给度数最高的一小批：5 万个名字全画上去就是一团墨，什么也读不出来。
(() => {
  'use strict'

  const data = window.__DATA__ || { nodes: [], links: [] }
  const nodes = data.nodes
  const N = nodes.length
  const flat = String(window.__POS__ || '').split(',')
  const X = new Float64Array(N)
  const Y = new Float64Array(N)
  for (let i = 0; i < N; i += 1) {
    X[i] = Number(flat[2 * i]) || 0
    Y[i] = Number(flat[2 * i + 1]) || 0
  }

  const index = new Map()
  for (let i = 0; i < N; i += 1) index.set(nodes[i].id, i)

  const edges = []
  for (const pair of data.links) {
    const a = index.get(pair[0])
    const b = index.get(pair[1])
    if (a === undefined || b === undefined) continue // 悬空边（上游过滤过，这里再兜一次）
    edges.push(a, b)
  }
  const E = Int32Array.from(edges)
  const adj = new Array(N)
  for (let i = 0; i < N; i += 1) adj[i] = []
  for (let k = 0; k < E.length; k += 2) {
    adj[E[k]].push(E[k + 1])
    adj[E[k + 1]].push(E[k])
  }

  const bucketOf = (line) => (line === 'wiki' || line === 'chat' ? line : 'other')
  const LINE_COLOR = { wiki: '#6ea8fe', chat: '#f0a35e', other: '#8b98b3' }

  // 度数最高的一批画名字（其余只在鼠标指着或点开时显示）
  const labelled = nodes
    .map((_n, i) => i)
    .sort((a, b) => (nodes[b].deg || 0) - (nodes[a].deg || 0))
    .slice(0, 80)
  const labelledSet = new Set(labelled)

  const canvas = document.getElementById('cv')
  const hudStats = document.getElementById('stats')
  const hudInfo = document.getElementById('info')
  const boot = document.getElementById('boot')
  const q = document.getElementById('q')
  const HINT = '拖动平移 · 滚轮缩放 · 点一个概念看它连谁 · 双击空白复位'

  let ctx = null
  try {
    ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null
  } catch (_error) {
    ctx = null
  }
  if (!ctx) {
    if (boot) boot.textContent = '这个浏览器给不出 2D 画布，图谱无法渲染'
    return
  }

  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const view = { scale: 1, x: 0, y: 0 } // 世界 → 屏幕：sx = view.x + X * scale
  let hovered = -1
  let focus = -1
  let neighbours = null

  const cssW = () => canvas.clientWidth || window.innerWidth || 800
  const cssH = () => canvas.clientHeight || window.innerHeight || 600

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  }

  function resize() {
    canvas.width = Math.floor(cssW() * dpr)
    canvas.height = Math.floor(cssH() * dpr)
    draw()
  }

  function fit() {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < N; i += 1) {
      if (X[i] < minX) minX = X[i]
      if (X[i] > maxX) maxX = X[i]
      if (Y[i] < minY) minY = Y[i]
      if (Y[i] > maxY) maxY = Y[i]
    }
    if (!Number.isFinite(minX)) {
      view.scale = 1
      view.x = cssW() / 2
      view.y = cssH() / 2
      draw()
      return
    }
    const pad = 28
    view.scale = Math.max(1e-6, Math.min((cssW() - pad * 2) / Math.max(1, maxX - minX),
                                         (cssH() - pad * 2) / Math.max(1, maxY - minY)))
    view.x = cssW() / 2 - ((minX + maxX) / 2) * view.scale
    view.y = cssH() / 2 - ((minY + maxY) / 2) * view.scale
    draw()
  }

  /** 屏幕坐标 → 命中的节点下标（找不到是 -1）。 */
  function pick(px, py) {
    const s = view.scale
    const wx = (px - view.x) / s
    const wy = (py - view.y) / s
    const tol = 7 / s
    let best = -1
    let bestD = tol * tol
    for (let i = 0; i < N; i += 1) {
      const dx = X[i] - wx
      const dy = Y[i] - wy
      const d = dx * dx + dy * dy
      if (d <= bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  function draw() {
    const w = cssW()
    const h = cssH()
    const s = view.scale
    const ox = view.x
    const oy = view.y

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    // 视口在世界坐标里的范围（多留一点余量，免得边缘的点被切掉半个）
    const pad = 4 / s
    const x0 = -ox / s - pad
    const y0 = -oy / s - pad
    const x1 = (w - ox) / s + pad
    const y1 = (h - oy) / s + pad

    // ---- 世界坐标：点与线 ----
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy)

    // 聚焦时把无关的点线压暗（不是藏起来）：结构还在，但一眼看得出它连的是谁
    const dimOthers = focus >= 0
    const near = (i) => !dimOthers || i === focus || (neighbours !== null && neighbours.has(i))

    ctx.lineWidth = 0.7 / s
    ctx.strokeStyle = dimOthers ? 'rgba(96,116,152,0.10)' : 'rgba(96,116,152,0.26)'
    ctx.beginPath()
    for (let k = 0; k < E.length; k += 2) {
      const i = E[k]
      const j = E[k + 1]
      if (dimOthers && !(near(i) && near(j))) continue
      const xi = X[i]
      const yi = Y[i]
      const xj = X[j]
      const yj = Y[j]
      if ((xi < x0 && xj < x0) || (xi > x1 && xj > x1)) continue
      if ((yi < y0 && yj < y0) || (yi > y1 && yj > y1)) continue
      ctx.moveTo(xi, yi)
      ctx.lineTo(xj, yj)
    }
    ctx.stroke()

    for (const line of ['wiki', 'chat', 'other']) {
      let started = false
      for (let i = 0; i < N; i += 1) {
        if (bucketOf(nodes[i].line) !== line) continue
        if (X[i] < x0 || X[i] > x1 || Y[i] < y0 || Y[i] > y1) continue
        if (dimOthers && !near(i)) continue
        if (!started) {
          ctx.beginPath()
          ctx.fillStyle = LINE_COLOR[line]
          started = true
        }
        const deg = nodes[i].deg || 0
        const r = (i === focus ? 4 : deg >= 50 ? 2.6 : deg >= 10 ? 1.9 : 1.4) / s
        ctx.moveTo(X[i] + r, Y[i])
        ctx.arc(X[i], Y[i], r, 0, Math.PI * 2)
      }
      if (started) ctx.fill()
    }

    // ---- 屏幕坐标：名字 ----
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.font = '11px "Segoe UI","Microsoft YaHei",system-ui,sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < N; i += 1) {
      const show = i === hovered || i === focus || (labelledSet.has(i) && !dimOthers)
      if (!show) continue
      const sx = ox + X[i] * s
      const sy = oy + Y[i] * s
      if (sx < -40 || sy < -20 || sx > w + 40 || sy > h + 20) continue
      ctx.fillStyle = i === hovered || i === focus ? '#ffffff' : 'rgba(201,211,230,0.78)'
      ctx.fillText(nodes[i].id, sx + 6, sy)
    }
  }

  function setFocus(i) {
    focus = i
    if (i >= 0) {
      neighbours = new Set(adj[i])
      if (hudInfo) {
        const names = [...neighbours].slice(0, 6).map((j) => nodes[j].id).join('、')
        const more = neighbours.size > 6 ? ' 等' : ''
        hudInfo.innerHTML = `<b>${escapeHtml(nodes[i].id)}</b> · 连 ${neighbours.size} 个（${escapeHtml(names)}${more}）`
      }
    } else {
      neighbours = null
      if (hudInfo) hudInfo.textContent = HINT
    }
    draw()
  }

  // ---- 交互 ----
  let dragging = false
  let lastX = 0
  let lastY = 0
  let moved = 0

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    dragging = true
    moved = 0
    lastX = event.clientX
    lastY = event.clientY
    if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId)
  })
  canvas.addEventListener('pointermove', (event) => {
    if (dragging) {
      const dx = event.clientX - lastX
      const dy = event.clientY - lastY
      moved += Math.abs(dx) + Math.abs(dy)
      lastX = event.clientX
      lastY = event.clientY
      view.x += dx
      view.y += dy
      draw()
      return
    }
    const rect = canvas.getBoundingClientRect()
    const hit = pick(event.clientX - rect.left, event.clientY - rect.top)
    if (hit !== hovered) {
      hovered = hit
      canvas.style.cursor = hit >= 0 ? 'pointer' : 'grab'
      draw()
    }
  })
  canvas.addEventListener('pointerup', (event) => {
    if (!dragging) return
    dragging = false
    if (moved > 3) return // 拖过就是平移，不算点选
    const rect = canvas.getBoundingClientRect()
    setFocus(pick(event.clientX - rect.left, event.clientY - rect.top))
  })
  canvas.addEventListener('dblclick', () => setFocus(-1))
  canvas.addEventListener('pointerleave', () => {
    if (hovered >= 0) {
      hovered = -1
      draw()
    }
  })
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault()
    const rect = canvas.getBoundingClientRect()
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top
    const next = Math.max(0.02, Math.min(60, view.scale * Math.exp(-event.deltaY * 0.0015)))
    const k = next / view.scale
    view.x = px - (px - view.x) * k
    view.y = py - (py - view.y) * k
    view.scale = next
    draw()
  }, { passive: false })

  if (q) {
    q.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      const needle = q.value.trim().toLowerCase()
      if (!needle) return
      let hit = -1
      for (let i = 0; i < N; i += 1) {
        if (nodes[i].id.toLowerCase() === needle) { hit = i; break }
      }
      if (hit < 0) {
        for (let i = 0; i < N; i += 1) {
          if (nodes[i].id.toLowerCase().includes(needle)) { hit = i; break }
        }
      }
      if (hit < 0) {
        if (hudInfo) hudInfo.textContent = `没找到「${q.value.trim()}」`
        return
      }
      view.scale = Math.max(view.scale, 2.5)
      view.x = cssW() / 2 - X[hit] * view.scale
      view.y = cssH() / 2 - Y[hit] * view.scale
      setFocus(hit)
    })
  }

  if (hudStats) {
    let wiki = 0
    let chat = 0
    for (let i = 0; i < N; i += 1) {
      if (nodes[i].line === 'wiki') wiki += 1
      else if (nodes[i].line === 'chat') chat += 1
    }
    hudStats.textContent = `${N.toLocaleString('en-US')} 个概念 · ${(E.length / 2).toLocaleString('en-US')} 条链接`
      + ` · 文章线 ${wiki.toLocaleString('en-US')} / 聊天线 ${chat.toLocaleString('en-US')}`
  }
  if (hudInfo) hudInfo.textContent = HINT
  if (boot) boot.style.display = 'none'

  window.addEventListener('resize', resize)
  resize()
  fit()
  // 给冒烟测试一个把手：能问它"画了多少个点、多少条线"
  window.__GRAPH2D__ = { nodes: N, edges: E.length / 2, draw, fit, view }
})()
