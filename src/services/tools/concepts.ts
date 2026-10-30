/** 概念页图谱：邻居、摘要、子图。只读 Markdown，不发网络请求。 */
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { vaultDirs, safeConceptFile } from './paths.js'

/** 概念页里「相关概念」那一节指向的名字（按出现顺序）。 */
export function relatedNames(pagePath: string): string[] {
  const text = readFileSync(pagePath, 'utf8')
  const start = text.indexOf('## 相关概念')
  if (start < 0) return []
  const rest = text.slice(start + 1)
  const end = rest.indexOf('\n## ')
  const section = end > 0 ? rest.slice(0, end) : rest
  return [...section.matchAll(/\[\[([^\]|]+)\]\]/g)]
    .map(match => match[1].replace(/\.md$/, '').trim())
    .filter(Boolean)
}

/**
 * 从一页出发，**沿着图走若干跳**，逐层返回 `{名字, 一句定义, 从谁连过来}`。
 *
 * 与 `conceptNeighbors` 的分工：那个给"一跳"（本页 + 直接邻居），这个给"一片"。助手此前只能
 * 一跳一跳地查（工具说明里写着"可以顺着它们再用本工具逐跳查下去"），但那要**模型自己决定**
 * 下一跳查谁。一次给两跳，它就能直接看到"这个概念周围的生态"。
 *
 * 三条规矩：
 * - **去重**：一个概念在图上有多条路径时只留**最先到达**的那条（BFS 保证它跳数最少），
 *   否则同一个名字会在好几层里重复出现，读的人分不清；
 * - **封顶**（`maxNodes`）：4 个邻居乘 4 乘 4 就是 64 —— 不封顶第三跳能把输出撑爆，而模型
 *   读不完的图等于没给。截断了要**说出来**（`truncated`），不能默默少给；
 * - **没建页的邻居照旧报数**（`missing`），不静默吞掉。
 */
export function conceptSubgraph(pageName: string, depth = 2, maxNodes = 30,
                                wikiDirs: string[] = vaultDirs(), homeDir?: string): {
  levels: Array<Array<{ name: string; brief: string; via: string }>>
  truncated: boolean
  missing: number
} {
  // 同 `conceptNeighbors`：传字符串会静默地按字符遍历，所以这里响，不猜。
  if (typeof wikiDirs === 'string') {
    throw new TypeError('conceptSubgraph 的 wikiDirs 要的是目录数组，不是单个字符串')
  }
  // 邻居可能住在另一个目录（文章概念指向聊天概念、反之亦然），所以查找跨目录。
  // `homeDir` 只影响**起点那一页**：两条线各有一张同名页时，"第一个有这个文件的目录"
  // 永远选出文章线那张，于是聊天线那张根本走不到 —— 而调用方（`search_knowledge`）
  // 正好知道这一趟命中的是哪条线。
  const find = (name: string, from?: string): string | null => {
    const dirs = from ? [from, ...wikiDirs.filter((d) => d !== from)] : wikiDirs
    for (const dir of dirs) {
      const candidate = join(dir, safeConceptFile(name))
      if (existsSync(candidate)) return candidate
    }
    return null
  }
  // **这一趟在哪条线上**：起点由 `homeDir` 定，之后沿 BFS **往下继承** —— 与图谱那边
  // "先在页自己那条线里解析、线里没有才回退到另一条"是**同一条规则**。不继承的话每一跳
  // 都会重新按"第一个有这个文件的目录"选，于是聊天线那一支走着走着就窜到文章线去了。
  const resolved = new Map<string, string>()
  const resolve = (name: string, from?: string): string | null => {
    const hit = resolved.get(name)
    if (hit) return hit
    const path = find(name, from)
    if (path) resolved.set(name, path)
    return path
  }
  const start = resolve(pageName, homeDir)
  if (!start) return { levels: [], truncated: false, missing: 0 }

  const seen = new Set<string>([pageName])
  const levels: Array<Array<{ name: string; brief: string; via: string }>> = []
  let frontier = [pageName]
  let truncated = false
  let missing = 0
  for (let hop = 0; hop < depth && frontier.length; hop += 1) {
    const level: Array<{ name: string; brief: string; via: string }> = []
    const next: string[] = []
    for (const from of frontier) {
      const fromPath = resolved.get(from) || resolve(from)
      if (!fromPath) continue
      const home = dirname(fromPath)
      for (const name of relatedNames(fromPath)) {
        if (seen.has(name)) continue
        const target = resolve(name, home)
        if (!target) {
          missing += 1
          continue
        }
        if (seen.size >= maxNodes) {
          truncated = true
          continue
        }
        seen.add(name)
        level.push({ name, brief: conceptBrief(readFileSync(target, 'utf8')), via: from })
        next.push(name)
      }
    }
    if (level.length) levels.push(level)
    frontier = next
  }
  return { levels, truncated, missing }
}

export function conceptBrief(text: string): string {
  const body = text.startsWith('---') ? text.slice(text.indexOf('---', 3) + 3) : text
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || /^[#>\-|`\[]/.test(line)) continue
    return line.length > 60 ? `${line.slice(0, 60)}…` : line
  }
  return '(这页没写定义)'
}

/**
 * 一个概念页在 `## 相关概念` 里连到的邻居——**图谱在 Agent 侧的落地**。
 *
 * 为什么要有：Obsidian 的关系图谱是人眼视图，助手那条路一直读不到"图"。但概念页里
 * 本来就写着它的邻居，把它们一并给出去，"查一个概念"就变成"拿到一小块子图"。
 * 实测：全部概念页都短于这个工具返回的 2,000 字上限，所以那段一直在返回内容里
 * ——但**没人点明它可以顺着走**，也没人把邻居的一句话定义取出来。
 *
 * 有页的邻居连定义一起给；没有页的只报个数（`missing`），免得模型去追一个取不到的名字。
 */
export function conceptNeighbors(pageName: string, wikiDirs: string[] = vaultDirs()): { linked: Array<{ name: string; brief: string }>; missing: number } {
  // **传字符串会静默地按字符遍历**（`for (const dir of 'D:\vault')` 挨个字符看过去），
  // 于是 `join('D', '某概念.md')` 不存在，函数安静地回一句「没有邻居」。2026-09-27 把参数
  // 从单个目录改成目录数组时，测试里正好踩到这个——类型拦得住 `src/`（`tsc` 覆盖它），
  // 拦不住测试与将来的 JS 调用方。所以这里响，不猜。
  if (typeof wikiDirs === 'string') {
    throw new TypeError('conceptNeighbors 的 wikiDirs 要的是目录数组，不是单个字符串')
  }
  // **邻居可能住在另一个目录**（文章概念指向聊天概念、反之亦然），所以查找也是跨目录的
  const find = (name: string): string | null => {
    for (const dir of wikiDirs) {
      const candidate = join(dir, safeConceptFile(name))
      if (existsSync(candidate)) return candidate
    }
    return null
  }
  const pagePath = find(pageName)
  if (!pagePath) return { linked: [], missing: 0 }
  const text = readFileSync(pagePath, 'utf8')
  const start = text.indexOf('## 相关概念')
  if (start < 0) return { linked: [], missing: 0 }
  const rest = text.slice(start + 1)
  const end = rest.indexOf('\n## ')
  const section = end > 0 ? rest.slice(0, end) : rest

  const linked: Array<{ name: string; brief: string }> = []
  let missing = 0
  for (const match of section.matchAll(/\[\[([^\]|]+)\]\]/g)) {
    const name = match[1].replace(/\.md$/, '').trim()
    if (!name) continue
    const target = find(name)
    if (!target) {
      missing += 1
      continue
    }
    linked.push({ name, brief: conceptBrief(readFileSync(target, 'utf8')) })
  }
  return { linked, missing }
}
