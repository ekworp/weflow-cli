/** 聊天转录的可读形态：时间、说话人、单条截断。 */
import { privacyGate } from '../assistantPrivacy.js'
import { clipWithMarker } from '../../utils/text.js'

/** 单条聊天消息进上下文的字数上限（见 get_messages：引用消息要放得下正文+被引原文） */
export const MSG_BODY_CHARS = 160

export function fmtTime(ts: number): string {
  const n = Number(ts)
  const d = n > 1e12 ? new Date(n) : new Date(n * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 转录里的时刻：`09-23 12:20`。
 *
 * 与 `fmtTime`（给用户看的工具输出用 `9/23 12:20`）**故意不同**：转录这一行的形状要和
 * Python 侧逐字一致，见 `transcriptLine`。改 `fmtTime` 会连带改用户看到的东西，所以这里单独一个。
 *
 * **时区也是契约的一部分，而且是固定 +8（北京时间），不是本机时区**：Python 那边写的是
 * `TZ = timezone(timedelta(hours=8))`（`scripts/reply_debt.py:39`），同一段对话从面板进来
 * 与从命令行进来必须是同一串字符。用 `getHours()` 取本机时区，在非 +8 的机器上两边会差几小时
 * ——CI（UTC）实测差 8 小时：TS 出 `09-23 04:00`、Python 出 `09-23 12:00`。
 * 中国没有夏令时，固定 +8 是精确的。要改成"跟随本机时区"，得连 Python 的欠账天数一起改
 * （那里用同一个 TZ 算"等了多少天"），不是改这一行的事。
 */
export function transcriptTime(ts: number): string {
  const n = Number(ts)
  const shifted = new Date((n > 1e12 ? n : n * 1000) + 8 * 3600_000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} `
    + `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
}

/** 单条消息进转录的截断长度。**必须等于** `scripts/reply_debt.py` 的 `DRAFT_MSG_CHARS`。 */
export const TRANSCRIPT_MSG_CHARS = 160

/**
 * 转录取**多少条**消息。**必须等于** `scripts/reply_debt.py` 的 `TRANSCRIPT_SIZE`。
 *
 * 与上面那个字数上限是一对：一个决定"多长的一段对话"，一个决定"每条多长"。两条入口
 * （面板/微信走 `--stdin`，命令行走 `--talker`）必须给出同一段对话——否则同一件事在两边
 * 判断出的结果会不一样，而**不会报任何错**。两边今天都是 30，但在这之前谁都没盯着它。
 */
export const TRANSCRIPT_MESSAGES = 30

/**
 * 消息是**谁**说的（对方那一侧）：**有解析出来的名字就用名字，没有就写「对方」**。
 *
 * **`senderUsername` 不参与**：它是数据库原列的 wxid（`wcdbCore` 的 `sender_username`、
 * `sqlcipherCore` 的 `StrTalker`），不是名字。拿它当标签有两个坏处——把**账号标识**交给云端
 * 模型，而且对模型没用（wxid 不告诉它这是谁）。
 *
 * 实测（本机 8 个会话、179 条别人发的消息）：`senderDisplay` 是有中文的名字 174 条，
 * `senderUsername` 是 wxid 形状 176 条，两者**从不相同**。所以这个替换不丢信息：
 * 群聊里照样分得清谁说的（名字比 wxid 还更有用），而标识不再出境。
 */
export function speakerLabel(message: any): string {
  return message.senderDisplay || '对方'
}

/**
 * 对话转录里的一行：`[09-23 12:20] 老王：那个文件你什么时候发我`。
 *
 * **这段形状在 Python 侧还有一份**：`reply_debt.format_line`（`draft_reply.py --talker`
 * 那条路自己读库时用它渲染）。两处必须逐字一致，否则同一段对话走不同入口会得到不同的转录——
 * 而它们**已经漂过**，实测三处不同：
 *
 * | | 这边（`--stdin`，面板/微信那条路） | Python `format_line`（`--talker` 命令行） |
 * | --- | --- | --- |
 * | 时刻 | `9/23 12:20` | `09-23 12:20` |
 * | 对方那句 | 写死「对方」 | `senderDisplay` 优先（单聊里就是人名） |
 * | 截断 | 160 字 | 120 字（留个 `…` vs 直接切掉） |
 *
 * 漂移里最危险的是「我」那个标记：脚本靠 `'] 我：'` 挑语气样本、靠 `lastFromMe` 判最后一条，
 * 改错一个字全都**静默失效**（不报错，只是判断与语气样本都变差）。
 * 所以有 `test/transcript-format-contract.test.ts`：同一批消息（含一条超长、一条非文本）
 * 把两边逐字比一遍。谁改了这一行的形状而不改另一边，那条会红。
 *
 * **`senderUsername` 永远不参与**（实测过）：它是**数据库原列的 wxid**
 * （`wcdbCore` 的 `sender_username`、`sqlcipherCore` 的 `StrTalker`），不是名字。
 * 拿它当发言人的标签会把账号标识喂给两个云端模型——而这一行的目的只是让模型分得清谁说的。
 * 所以规则是：**有解析出来的名字就用名字，没有就写「对方」**，绝不退回原列。
 * `senderDisplay` 在真实路径上是有值的（实测一条会话：文本与图片消息都带），所以这边
 * 正常会写成人名，「对方」只是兜底。
 */
export function transcriptLine(message: any): string {
  const raw = message.localType === 1
    ? (message.content || message.parsedContent || '')
    : (message.parsedContent || message.content || '')
  const body = privacyGate.maskMessageBody(
    clipWithMarker(String(raw).replace(/\n/g, ' '), TRANSCRIPT_MSG_CHARS),
    { isText: message.localType === 1 })
  const speaker = message.isSend ? '我' : speakerLabel(message)
  return `[${transcriptTime(message.createTime)}] ${speaker}：${body}`
}
