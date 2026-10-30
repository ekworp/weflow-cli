/** 工具层的公共类型：工具声明、执行上下文、图片附件。 */
import type { AssistantMemory } from '../assistantMemory.js'

export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolContext {
  userId: string
  memory: AssistantMemory
  /**
   * 工具这一轮取到的图片，由 `look_at_image` 填。
   *
   * 图片走**侧信道**而不是工具返回值：工具返回值是字符串，要往里塞 base64 就得约定一个
   * 魔法前缀再解析——那是这个仓库反复吃亏的"用文本承载结构"。服务层拿这个字段去把图片
   * 附到对话里（见 `assistantService.toApiMessages`）。
   */
  pendingImages?: AttachedImage[]
  /**
   * 本轮**来信自带**的图片（Bot 通道按 `wechatMediaDownload` 落盘解密过的文件，D-128）。
   * `look_at_image` 的 `#信N` 句柄指向这里：文件已在本机，不走 `read_image.py`。
   * 与 `pendingImages` 的分工：那是"模型这一轮已经看过的"，这是"来信里还没看的"。
   */
  inboundImages?: Array<{ filePath: string }>
  /**
   * 调用方是**外部机器**（MCP 那条路）时置 true。
   *
   * 与面板/微信那条路的区别不是审美：MCP 客户端是**别人家的进程**，它那边谁也看不到这一轮
   * 是在什么上下文里决定调用的。所以对"会把用户数据送出去"的工具，机器调用默认只给**预览**，
   * 要显式带 `confirm: true` 才真出境——与 CLI 那条 `--dry-run` / `--yes` 是同一套纪律，
   * 也与 `capabilities.read.draft.confirmationRequired` 对得上。
   */
  requiresConfirm?: boolean
}

/** 随某条消息一起发出去的图片。只在构造请求那一刻存在，不进记忆、不进审计内容。 */
export interface AttachedImage {
  b64: string
  mime: string
  /** 来源消息的 local_id，只为了审计里能对上"发了哪条" */
  localId?: number
}
