/** 本机目录、知识线展示名、概念页路径 —— 工具层里"东西放在哪"的那一半。 */
import { join } from 'path'
import { resolvePackageRoot } from '../../utils/packageRoot.js'

export const PKG_ROOT = resolvePackageRoot(import.meta.url)
/**
 * 日报目录。**可以用 `WEFLOW_ASSISTANT_BIZ_DAILY_DIR` 指到别处**。
 *
 * 为什么加这个注入点：`get_daily_report` 一直是工具层里**唯一从没被执行过的分支**，
 * 原因写在测试文件头上——它读的是模块级常量路径，没有注入点，断言只能写成"没数据/有数据皆可"，
 * 那种测试看着像覆盖、其实什么也没钉住。同 `WEFLOW_ASSISTANT_EXPORT_ROOT` 的先例（见 `export_chat`）。
 */
// 做成函数而不是模块常量：环境变量在**每次调用**时读，测试才能在同一进程里换夹具
// （同 `export_chat` 的 `WEFLOW_ASSISTANT_EXPORT_ROOT` 做法）。常量只在 import 时求值，
// 那会让「目录不存在」这类分支永远测不到——写出来的断言就只能是摆设。
export const bizDailyDir = (): string =>
  process.env.WEFLOW_ASSISTANT_BIZ_DAILY_DIR || join(PKG_ROOT, 'output', 'biz-daily')
/** 学习回顾目录。同样可注入：否则 `get_review` 的断言只能依赖这台机器上有没有跑过 `review`。 */
export const reviewsDir = (): string =>
  process.env.WEFLOW_ASSISTANT_REVIEWS_DIR || join(PKG_ROOT, 'output', 'reviews', 'Daily')

// 知识页住在哪几个目录。**两个是有意的**：文章知识库与聊天知识库分开（用户 2026-09-27
// 要求），所以读的一方要把**两个都读**——只读一个，分出去的那一半就静默地搜不到。
// 与 Python 的 `_utils.CONCEPT_DIRS` 是同一份清单，有测试钉住两者一致（跨语言没法共用常量）。
/**
 * 总览索引在哪：**在概念目录的上一层**——`Wiki/Concepts/` 的兄弟是 `Wiki/00-Overview.md`。
 *
 * 抽成函数是为了能直接测：这段路径写错过一次（写成 `join(dir, '00-Overview.md')`，于是一直读不到），
 * 而当时那条测试只能断言「有内容或没有」这种形状——真实机器上有索引、CI 上没有，两条路都绿。
 */
export function wikiIndexPath(conceptDir: string): string {
  return join(conceptDir, '..', '00-Overview.md')
}

/**
 * 知识库那两条线的 `Concepts` 目录。**同样可注入**（`WEFLOW_ASSISTANT_VAULT_DIR`），
 * 与上面 `bizDailyDir` / `reviewsDir` 是同一条理由：评测跑在临时家目录里，包内那个
 * `output/wechat-vault/` 必然为空，`get_concepts` 就只能测到「还没编译过」那一支——
 * 要给它写用例，就得能把这个根换掉。（做成函数而不是常量：环境变量要在**每次调用**时读。）
 */
export const vaultDirs = (): string[] => {
  const root = process.env.WEFLOW_ASSISTANT_VAULT_DIR || join(PKG_ROOT, 'output', 'wechat-vault')
  return [join(root, 'Wiki', 'Concepts'), join(root, 'Chat', 'Concepts')]
}

/**
 * 线的展示名 —— **TS 侧只此一份**。原来有两处各自从路径里找 `Chat` 这个词猜
 * （`wiki_health` 与 `get_vault_stats`），改词的那天只会改到一半。
 *
 * 与 Python 侧 `_utils.LINE_LABELS` 是同一份名单，靠 `test/concept-dirs-agreement.test.ts`
 * 钉住一致（跨语言没法共享一个常量，这个仓库对这类常量的既有做法就是"各写各的、由测试钉住"）。
 *
 * **两条线各自一个根之后这里要跟着改**：路径里不会再有 `Wiki`/`Chat` 这一段。
 * 到那时 `wiki_health` 已经直接取 Python 给的 `report.lineLabel`（认得线的目录它都会给），
 * 这里只剩"认不出的目录"这一支要兜底。
 */
export const VAULT_LINE_LABELS: Record<string, string> = { wiki: '文章线', chat: '聊天线' }

/** 概念目录 → 线 id（`wiki`/`chat`）。按**路径段**认（`…/Wiki/Concepts`）；认不出返回 null，不猜。 */
export function vaultLineId(dir: string): string | null {
  const segments = dir.split(/[\\/]/).map(s => s.toLowerCase())
  for (const id of Object.keys(VAULT_LINE_LABELS)) {
    if (segments.includes(id)) return id
  }
  return null
}

/** 概念目录 → 线的展示名。**认不出线就返回目录名，不猜成某一条**。 */
export function vaultLineLabel(dir: string): string {
  const id = vaultLineId(dir)
  if (id) return VAULT_LINE_LABELS[id]
  return dir.split(/[\\/]/).filter(Boolean).pop() || dir
}

/**
 * 工具参数里的 `line`：`wiki` / `chat` / `all`，不传就是 `wiki`（两条线分开之后，
 * **默认只看文章线**，要合起来看显式给 `all`）。
 *
 * 认不出的值返回 `null` 让调用方**报错**，而不是当 `all`：`line: 'wiki '` 或 `'Wiki'`
 * 悄悄变成"两条线都搜"的话，"我限定住了"就是句假话，而结果里看不出来。
 */
export function toolLine(value: unknown): 'wiki' | 'chat' | 'all' | null {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return 'wiki'
  return raw === 'wiki' || raw === 'chat' || raw === 'all' ? raw : null
}

/** 线 id → 展示名（工具输出里说"搜了哪条"用）。 */
export function lineLabelOf(line: 'wiki' | 'chat' | 'all'): string {
  return line === 'all' ? '两条线' : (VAULT_LINE_LABELS[line] ?? line)
}

/**
 * 概念名 → 文件名。**与 `compile_wiki` 是同一套规则**（非法字符换下划线、截到 60 字）。
 *
 * 这里必须消毒：邻居名是从**文件内容**里读出来的，直接拼进路径就能走出目录
 * （`../../` 那类）。文件名规则两边不一致也会让"查得到"变成"查不到"。
 */
export function safeConceptFile(name: string): string {
  return `${name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.md`
}

/** 概念页正文的第一句（跳过 frontmatter、标题、引用、列表）——给"这个邻居是什么"。 */
/**
 * 页面里「正文」的那一部分：`## 来源` 之前。
 *
 * **来源段不算正文** —— 它列的是文章标题（可能 300+ 条），拿它做「这个词在这页里吗」的判断，
 * 会把「某篇来源的标题里含这个词」报成「正文提及」。
 */
export function pageBody(text: string): string {
  const at = text.indexOf('## 来源')
  return at === -1 ? text : text.slice(0, at)
}
