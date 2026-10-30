/** 看图片：把图交给助手自己的模型，而不是转成文字。 */
import { readFileSync } from 'fs'
import { runPythonJson } from '../pythonBridge.js'
import { privacyGate } from '../assistantPrivacy.js'
import { MAX_IMAGES_PER_TURN, MAX_INBOUND_IMAGE_BYTES, sniffImageMime } from './images.js'
import { resolveTalker, fail } from './runtime.js'
import type { ToolContext } from './types.js'

export async function handleLookAtImage(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const contact = String(args.contact || '')
  // 句柄在 get_messages 里长这样：`[图片 #1234]`。允许带不带 `#` 都接受——模型从
  // 上下文里抄一个编号过来，"抄得像不像"不该决定它能不能看图。
  const image = String(args.image ?? '').replace(/^#/, '').trim()
  if (!image) return '(缺少 image 参数)'
  // 来信自带的图（D-128）：句柄 `信N`，与聊天记录的 `#N` 是两个空间。静态校验
  // 先于隐私门——参数错就是参数错，与档位无关。
  const inbound = /^信(\d+)$/.exec(image)
  if (!inbound) {
    if (!contact) return '(缺少 contact 参数：看聊天记录里的图要说明在哪个会话)'
    if (!/^\d+$/.test(image)) {
      return `(image 要填 get_messages 里 [图片 #N] 的编号或来信的 #信N，收到的是「${image.slice(0, 20)}」)`
    }
  }
  // 第一层门：strict 模式（第三方聊天正文不出境）下图片也不出去。第二层在
  // `toApiMessages` 里——"工具肯给"与"这道门肯放"是两件事。
  if (privacyGate.mode() === 'strict' && !privacyGate.isLocalInference()) {
    return '(当前隐私模式是 strict：图片不发出本机，用不了这个工具。'
      + '要让我看图，得把 assistantPrivacy 改成 balanced)'
  }
  const budget = ctx.pendingImages ?? []
  if (budget.length >= MAX_IMAGES_PER_TURN) {
    return `(这一轮已经看过 ${MAX_IMAGES_PER_TURN} 张图了，先把已经看到的说完，别再取)`
  }

  // ---- 来信自带的图：文件已在本机（wechatMediaDownload 落盘解密过），
  // 不走 read_image.py。
  if (inbound) {
    const files = ctx.inboundImages ?? []
    const n = Number(inbound[1])
    const ref = files[n - 1]
    if (!ref) {
      return `(本轮来信没有 #信${n} 这张图${files.length ? `（只有 #信1 到 #信${files.length}）` : '：来信没带可看的图片文件'})`
    }
    let buf: Buffer
    try {
      buf = readFileSync(ref.filePath)
    } catch {
      return `(读不到 #信${n} 的图片文件：落盘文件已不在（可能被清理过）)`
    }
    if (buf.length > MAX_INBOUND_IMAGE_BYTES) {
      // 不缩放（D-128）：入站文件是证据形态，缩了再给模型看，模型说的就不是那张图。
      return `(这张来信图片 ${(buf.length / 1048576).toFixed(1)} MB，超过 ${MAX_INBOUND_IMAGE_BYTES / 1048576} MB 上限，没有附上)`
    }
    const mime = sniffImageMime(buf)
    if (!mime) {
      return `(#信${n} 的文件头不是 png/jpeg/webp，附上也没有意义)`
    }
    ;(ctx.pendingImages ??= []).push({ b64: buf.toString('base64'), mime })
    return `(已附上来信图片 #信${n}（${buf.length} 字节）。你能看到它了，直接据此回答。)`
  }

  const talker = await resolveTalker(contact)
  // 90 秒。建媒体索引是这条路唯一的成本，且随会话大小走：实测单聊 ~1 秒、
  // 一个 3 万条消息的大群 18.9 秒（而那个群本机只有缩略图）。取到的图会落在
  // `output/.cache/read-image/`，同一张再看是 0.1 秒。超时是必要的兜底——助手是
  // **串行**处理消息的，一次卡住会挡住后面所有人的话，所以宁可说"取图失败"。
  const r = await runPythonJson<any>('read_image.py',
    ['--talker', talker, '--local-id', image, '--json'], { timeoutMs: 90_000 })
  if (!r.ok) return fail('取图失败', r)
  if (!r.data?.b64) {
    // 文字说明而不是空：本机没有这张图的副本（缓存清过、或只有缩略图）是常态
    return `(没取到 #${image} 的图片：${r.data?.reason || '本机没有这张图的副本'})`
  }
  // 拿到图才建数组：`pendingImages` 为 undefined 与"空数组"在下游是同一个意思，
  // 但只有前者能一眼看出"这一轮没图"。
  ;(ctx.pendingImages ??= []).push({
    b64: r.data.b64, mime: r.data.mime || 'image/jpeg', localId: Number(image) })
  const size = r.data.width && r.data.height ? `${r.data.width}×${r.data.height}` : '尺寸未知'
  return `(已附上图片 #${image}（${size}）。你能看到它了，直接据此回答。)`
}
