/** 工具声明表、MCP 可见面、可用性前置条件。 */
import { configService } from '../configService.js'
import type { ToolDef } from './types.js'

export const TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'list_sessions',
      description: '列出用户最近的微信聊天会话(显示名+最后一条消息摘要)。用于了解用户最近在和谁聊天。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回条数, 默认15' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_messages',
      description: '读取用户与某位联系人的聊天记录。默认给最近若干条；'
        + '问**某一天或某段时间**时给 since/until —— 不给的话久远的日子按条数是取不到的。'
        + '联系人名用会话里出现的显示名。',
      parameters: {
        type: 'object',
        properties: {
          contact: { type: 'string', description: '联系人显示名或备注名' },
          limit: { type: 'number', description: '消息条数, 默认20, 上限50' },
          since: { type: 'string', description: '起点：2026-09-16 或相对写法 3d / 2w / 12h' },
          until: { type: 'string', description: '终点（含当天）：2026-09-16' },
        },
        required: ['contact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'look_at_image',
      description: '看一张图片（把图片本身交给模型看，不只是"这里有一张图"）。'
        + '看聊天记录里的图：`image` 填 get_messages 输出里 `[图片 #1234]` 的编号，`contact` 给会话。'
        + '看**本轮来信自带**的图：`image` 填 `#信1`（只有来信带图时才会出现这个句柄），不用 contact。'
        + '一轮最多看两张；隐私模式为 strict 时不可用（图片不出发本机）。',
      parameters: {
        type: 'object',
        properties: {
          contact: { type: 'string', description: '聊天记录那条路：这张图所在会话的联系人显示名（#信N 不需要）' },
          image: { type: 'string', description: '[图片 #N] 的编号 N，或来信图片的 #信N' },
        },
        required: ['image'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_favorites',
      description: '搜索用户的微信收藏(主要是收藏的公众号文章)；**不给关键词就是最近收藏了什么**。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词' },
          limit: { type: 'number', description: '返回条数, 默认8' },
        },
              },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_favorite',
      description: '读取一篇收藏文章的正文内容。先用 search_favorites 或按关键词找到文章标题, 再用标题关键词调本工具抓取正文。适合「这篇文章讲了啥」「总结第一篇」类问题。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '文章标题中的关键词' },
          max_chars: { type: 'number', description: '返回正文字数上限, 默认3000' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_daily_report',
      description: '获取公众号日报: 推送了哪些文章(标题/来源/分类/AI摘要)。'
        + '适合「今天/某天公众号推了什么」「最近有哪些AI文章」「搜一下关于X的文章」类问题。'
        + '**给 date 就是那一天的；不给 date 只给关键词/分类就是跨日期搜**（默认最近 7 天，用 days 调）。'
        + '要当天那份**人读的日报正文**（不是条目清单）加 full。',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: '日期 YYYY-MM-DD；省略则最新一期（或配合关键词跨日期搜）' },
          topic: { type: 'string', description: '分类过滤: AI | 学术 | 新闻 | 文学 | 投资' },
          keyword: { type: 'string', description: '标题/摘要/来源关键词。不给 date 时跨日期搜' },
          days: { type: 'number', description: '跨日期搜的时间窗(天), 默认 7, 上限 60' },
          full: { type: 'boolean', description: '返回当天日报的正文（人读的那份），而不是条目清单' },
          max_chars: { type: 'number', description: 'full 时正文上限, 默认 3000, 上限 6000' },
          limit: { type: 'number', description: '返回条数, 默认15' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_sns',
      description: '查看用户朋友圈: 最新动态时间线或统计概览(发帖数/好友数)。适合「朋友圈最近发了啥」「谁常发朋友圈」类问题。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', description: 'timeline (最新动态) / stats (统计) / users (谁发得最多), 默认 timeline' },
          limit: { type: 'number', description: 'timeline 模式条数, 默认10' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weread',
      description: '查看用户微信读书数据。mode: shelf(书架) | notebooks(有笔记的书) | search(按书名搜) '
        + '| stats(近期阅读时长) | book(某本书详情+我的进度) | review(某本书的热门书评) '
        + '| discover(推荐/相似书) | profile(累计阅读画像)。适合「我在读什么书」「某本书讲什么」「读了多少」类问题。'
        + 'book / review 需要先用 search 拿到 book_id。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', description: 'shelf | notebooks | search | stats | book | review | discover | profile, 默认 shelf' },
          keyword: { type: 'string', description: 'search 模式的书名关键词' },
          book_id: { type: 'string', description: 'book / review 模式的书籍 id（search 或 shelf 的结果里有）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_todos',
      description: '查看用户从聊天记录提取的待办任务清单(含优先级和截止时间)。适合「我最近有什么待办」「有什么紧急的事」类问题。'
        + '每条后面方括号里的 id 用来改某一条的状态（set_todo_status 需要它）。按紧急度分组看用 group_by。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'pending | done, 默认 pending' },
          group_by: { type: 'string', description: '传 urgency 就按紧急度分组列出' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_chats',
      description: '在**聊天记录**里检索「在哪聊过某件事」，按字面词匹配。适合「上次说的那个部署方案是在哪聊的」。'
        + '（知识库用 search_knowledge；助手记得的关于你的事用 search_memory）'
        + '「谁提过这个客户」这类问题。它只匹配字面词（同义改写要靠别的路子），所以问题描述得具体些。'
        + '代价：会把你的问题与候选词发给判断模型（不发聊天正文），约 1-2 秒。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要找的事，用自然语言描述' },
          per_card: { type: 'number', description: '每个会话最多回几条消息，默认 3' },
          confirm: {
            type: 'boolean',
            description: '仅当用户**明确同意**这个工具会把内容发出去时才传 true。不传或传 false 时只返回预览（要发什么、发给谁），零出境。',
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_reply',
      description: '帮用户**起草**一条回复（只产出候选文本，绝不替他发送）。适合「帮我回老王那句话」'
        + '「这条怎么回」。会先判断对方要什么、该不该给实质内容、风险多高，再给几条候选。'
        + '涉及钱或风险很高时**不给草稿**，只说明风险与该先确认什么——别把这种情况当失败。'
        + '（想看对方写了什么用 get_messages；想知道谁在等用 who_owes_reply。）'
        + '代价：要把这段对话发给判断模型与生成模型（两个云端模型），约几秒；'
        + '**外部机器调用（MCP）不带 confirm 时只返回预览**（发多少字符给谁），不实际出境。',
      parameters: {
        type: 'object',
        properties: {
          contact: { type: 'string', description: '给谁起草（联系人名，和 get_messages 一样解析）' },
          count: { type: 'number', description: '要几条候选，默认 3（最多 5）' },
          confirm: {
            type: 'boolean',
            description: '仅当用户**明确同意**把这段对话发给两个云端模型时才传 true。'
              + '不传或传 false 时只返回预览（多少条消息、多少字符、发给哪两个模型），零出境。',
          },
        },
        required: ['contact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'who_owes_reply',
      description: '看看谁在等你回话（对方说完就没下文的那种）。适合「我有没有漏回谁的消息」。'
        + '代价：逐会话问一次判断模型，可能要几十秒；只报谁在等，不回正文。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '只看最近多少天有动静的会话，默认 14' },
          confirm: {
            type: 'boolean',
            description: '仅当用户**明确同意**这个工具会把内容发出去时才传 true。不传或传 false 时只返回预览（要发什么、发给谁），零出境。',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_semantic',
      description: '按**意思**找聊天记录（语义/同义检索），而 search_chats 只匹配字面词——'
        + '想不起原话、只记得大意时用它。'
        + '「上次说的那个部署方案是在哪聊的」用 search_chats；「和钱有关的讨论」这种同义改写用这条。'
        + '代价：查询词会发给阿里云百炼做嵌入、候选片段会发给判断模型重排（都是仓库既有的云端路径），'
        + '需要先建过索引（weflow-cli search-index）。'
        + '用户要「正文 / 具体内容」时传 with_text: true（每条约 1500 字，比片段长得多）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要找的意思，用自然语言描述' },
          line: {
            type: 'string',
            description: '搜哪一条知识库：wiki=公众号文章线与聊天记录里的文章（默认）、'
              + 'chat=你的微信聊天记录、all=两条都搜。**默认只搜 wiki**，'
              + '问"我们聊过什么"「上次说的那个」这类一定要给 chat 或 all，否则会搜不到。',
          },
          top_k: { type: 'number', description: '要几条，默认 8，上限 20' },
          with_text: {
            type: 'boolean',
            description: '用户**明确要正文/具体内容**时传 true：每条会带回本地正文'
              + '（约 1500 字/条，比默认片段长得多，注意上下文占用）。默认 false 只给标题＋片段。',
          },
          confirm: {
            type: 'boolean',
            description: '仅当用户**明确同意**这个工具会把内容发出去时才传 true。不传或传 false 时只返回预览（要发什么、发给谁），零出境。',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_chat',
      description: '把某个人的聊天记录导出成 HTML（含图片），落到 output/exports/ 下。'
        + '适合「帮我把和某某的聊天导出备份一下」。**会写文件**：每次新建一个带时间戳的目录，绝不覆盖已有的，'
        + '路径也不是你给而是固定的。',
      parameters: {
        type: 'object',
        properties: {
          contact: { type: 'string', description: '联系人显示名或备注名' },
          limit: { type: 'number', description: '最多导出多少条，默认 500，上限 5000' },
          format: { type: 'string', description: 'html(默认,含图片) / txt / json / excel' },
        },
        required: ['contact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: '搜索**本地知识库**的概念页（公众号文章沉淀的是一条线、你自己的微信对话沉淀的是另一条），'
        + '适合查概念解释、找之前整理过的知识。**默认只搜文章那条线**，`line` 可以换成聊天那条或两条都搜。'
        + '**返回时会一并给出这一页连到的相关概念（每个一句定义）**——可以顺着它们再用本工具逐跳查下去，'
        + '这样一次追问能走开一小块知识，而不是停在一个孤立页面上。'
        + '（聊天里说过什么用 search_chats；助手记得的关于你的事用 search_memory）',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '概念名或关键词, 如 RAG、Agent' },
          line: {
            type: 'string',
            description: '搜哪一条知识库：wiki=公众号文章沉淀的概念（默认）、'
              + 'chat=你自己的微信对话沉淀的概念、all=两条都搜。'
              + '**默认只搜 wiki**；问"我们聊过的某个概念"要给 chat 或 all。'
              + '同一个概念名两条线可能各有一张页（那是设计），返回里会指明给的是哪一条。',
          },
          depth: { type: 'integer', description: '沿「相关概念」走几跳：默认 1 只给直接邻居，2 能一次看到这个概念周围的生态（最多 3）' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stats',
      description: '本地数据总览：会话数、收藏总数、日报文章数与覆盖天数、主题分布、概念页数。'
        + '适合「我一共有多少数据」这类总览问题；单看公众号推送用 get_reading_stats。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_reading_stats',
      description: '**公众号**推送与日报处理的统计：哪些号发得多、哪些被日报处理得多。'
        + '适合"哪个号发得最多""日报处理了多少篇"这类问题。'
        // 原文写的是「回答"我最近都在读什么/哪个号发得最多"这类问题时用它」——
        // 而"我最近在读什么"**正是微信读书的问题**。2026-09-28 实测：用户问"我在读什么书"，
        // 模型抓住这一句用了它，返回一串公众号推送量（"发得最多的是红星新闻"），
        // 用户看到的就是一个答非所问的答复。工具没错，错在这句说明侵占了读书的问题空间。
        + '**它统计的是公众号推送与日报，不含读书数据**——"我在读什么书"那类问题不要用它。'
        + '**日报没在跑的时候它会直说**（那不是"没内容"）。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '统计最近多少天，默认 7，上限 90' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: '搜索**助手记得的关于你的事**（此前对话里提取的长期事实：偏好、项目、关系）。'
        + '（聊天正文用 search_chats，整理过的知识用 search_knowledge）',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: '把关于用户的重要持久事实存入长期记忆(如偏好、项目背景、重要关系)。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '事实内容, 40字以内' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_skills',
      description: '列出本机装好的技能包(名字+一句话说明+版本)。技能是一份说明文档,'
        + '用 read_skill 读它的正文再照着做；不要凭名字猜它怎么用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选：按关键词过滤（匹配 id、名称、说明和触发词）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_skill',
      description: '读取某个技能包的完整说明（SKILL.md 正文）。要用某个技能前先读它。'
        + 'id 用 list_skills 查到的那个。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '技能 id，如 wechat-article-extract' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_contacts',
      description: '列出通讯录里的联系人（显示名、备注、昵称）。**不含 wxid 等本机标识**，'
        + '只有能叫得出名字的人。'
        + '（要看最近跟谁聊过用 list_sessions；要按名字查某个会话的聊天用 get_messages）',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '按名字过滤（可省略）' },
          limit: { type: 'number', description: '最多几条, 默认 50, 上限 200' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_review',
      description: '读某一天的学习回顾（对当天日报文章做的二次整理：要点、联系、值得回看的）。'
        + '**与 get_daily_report 不是一回事**：那个是当天日报的原始条目清单，这个是复盘。',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: '日期 YYYY-MM-DD，省略则取最近一份' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_concepts',
      description: '读知识库的两份总览索引（文章线、聊天线各一份）。这是**目录**，'
        + '用来回答"我的知识库里都有什么"；要按名字找**某一页**的内容用 search_knowledge。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '每份索引最多返回多少行, 默认 40' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_article',
      description: '抓取一篇公众号文章的正文（需要完整链接）。只接受 https 的 mp.weixin.qq.com 链接。'
        + '与 read_favorite 的区别：那个从你自己的收藏里找，这个由用户给出链接。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '公众号文章完整链接' },
          max_chars: { type: 'number', description: '正文上限, 默认 3000, 上限 6000' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_public',
      description: '在公开的公众号文章里按关键词搜标题与摘要（走第三方搜索页）。'
        + '只搜公开文章，搜不到你自己的收藏、聊天记录或知识库。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索词' },
          limit: { type: 'number', description: '最多几条, 默认 8, 上限 20' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'format_article',
      description: '把 Markdown 转成能直接粘进公众号编辑器的 HTML 片段（纯本地转换，不联网、不写文件）。'
        + '主题名用 list_themes 查。',
      parameters: {
        type: 'object',
        properties: {
          // 参数名保持 `content` —— 这个名字在 MCP 那条路上已经被外部客户端用了，
          // 改名的代价是别人的调用直接失效（工具名不变、参数变了，最难查的那种坏法）
          content: { type: 'string', description: '要排版的 Markdown 正文' },
          theme: { type: 'string', description: '主题名（省略用 default）' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_themes',
      description: '列出可用的公众号排版主题（配合 format_article 用）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lint_wiki',
      description: '知识库体检：断链、孤儿页、空页、同名页。**只读**，不改任何页。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_skills',
      description: '技能体检：报出读不出来的 SKILL.md、跨目录同名、id 不合规范、被禁用的技能。'
        + '与 list_skills 的区别：那个是清单，这个是**问题清单**。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_todo_status',
      description: '把一条待办标记为已完成 / 取消完成。**不能删除待办、不能新增**。'
        + '要精确指到那一条：优先用 get_todos 给出的 id；也可以给一段任务文字，'
        + '但**匹配到零条或多条都会被拒绝**（猜错条目比拒绝更糟）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '待办 id（get_todos 输出里的那个）' },
          task: { type: 'string', description: '或用任务文字精确匹配（必须唯一）' },
          status: { type: 'string', description: 'done = 已完成, pending = 取消完成' },
        },
        required: ['status'],
      },
    },
  },
]

/**
 * MCP 那条路看得见的工具表。
 *
 * **它不叫 read-only**（曾经叫，而那是假的）：里面一直有写文件的 `export_chat`，也有几个会把
 * 用户数据发给云端模型、需要 `confirm: true` 的工具。这里只排除**在那条路上根本做不了事**的，
 * 而"为什么做不了"写在下面那张表里（值就是原因，不是 true）：
 *
 * - `save_memory`：写记忆。MCP 没有微信用户身份，挂的记忆桶是单独一条；让它写没有意义。
 * - `look_at_image`：它的做法是把图**挂进侧信道**（`ctx.pendingImages`）交给助手自己的模型看，
 *   而 MCP 那条路只把工具返回的**文本**交给客户端（见 `mcp-server/index.ts` 的 default 分支）——
 *   图没人接，回话里却写着"已附上图片…你能看到它了"，那是**一句假话**。
 *   按本仓"不摆一个跑不了的工具"那条立论（同 `unavailableToolReason`），它不该出现在这里。
 *
 * 做成表而不是写进 filter：这是**注册表的一部分**，`test/tool-registry.test.ts` 会盯着
 * 表里的每个名字都真的存在于 `TOOL_DEFS`（写错一个名字 = 静默地没排除掉任何东西）。
 */
export const MCP_EXCLUDED: Record<string, string> = {
  save_memory: 'MCP 没有微信用户身份，挂的记忆桶是单独一条，让它写没有意义',
  look_at_image: 'MCP 只把工具返回的文本交给客户端，它挂进侧信道的图没人接，回话会变成一句假话',
  // 这条是**故意留在外面的**（docs/MCP.md 的天花板：「mutating todos ... stay out」）：
  // 助手在微信/面板里可以替你翻转一条待办状态，但外部 MCP 客户端不行——
  // 那条路上没有"你"，只有调用方；一条机器指令顺手改掉你的待办，不该是默认能力。
  set_todo_status: '待办是本地状态，MCP 那条路上没有用户可确认；改状态请在微信/面板里说，或用 CLI 的两段式 todos done',
}

export const MCP_TOOL_DEFS = TOOL_DEFS.filter(tool => !(tool.function.name in MCP_EXCLUDED))

/**
 * "这台机器上跑不了"的**声明**：缺哪个配置键、缺了之后怎么跟用户说（值就是那句话）。
 *
 * 做成一张表而不是一串 `if (name === '...')`：加一个带前置条件的工具，现在是在这里加**一行**，
 * 而不是在 if 链里再插一段；`test/tool-registry.test.ts` 盯着表里的每个名字都真的存在于 `TOOL_DEFS`
 * （写错名字 = 那条规则永远不生效，而且不会有任何报错）。
 *
 * **只写"缺了就跑不了"的前置条件**，不写"暂时没数据"——没数据时工具自己会说该运行什么
 * （`先运行 weflow-cli wiki compile`），那是有用的回答。
 */
export const TOOL_REQUIREMENTS: Record<string, { key: string; why: string }> = {
  search_semantic: { key: 'dashscopeApiKey', why: '语义检索需要 dashscopeApiKey' },
  get_weread: { key: 'wereadApiKey', why: '微信读书需要 wereadApiKey' },
  draft_reply: {
    key: 'deepseekApiKey',
    // **只有 DeepSeek 是必须的**。判断那一步（Jev）现在可降级：调不通就只用生成模型起草，
    // 输出里会写明"这次没有判断、闸门没生效"（2026-09-25 Jev 免费期结束那天改的）。
    // 所以缺 typesafeApiKey **不**该把这个工具收起来——那会让"能跑的工具"被藏掉。
    why: '起草回复需要 deepseekApiKey（生成那一步）',
  },
}

/**
 * 这台机器上**跑不了**的工具，不该出现在工具表里。规则本身在上面的 `TOOL_REQUIREMENTS` 里，这里只是执行它。
 *
 * 为什么按配置过滤：模型看见工具就会去试。这台机器没配 `dashscopeApiKey` 时 `search_semantic`
 * 必然失败——实测（评测的 `ambiguous-contact` 那次）模型连试两个检索工具、两个都报错，最后答复
 * 里带着"两个检索工具都跑不通"。那不是助手的问题，是**我们摆了一个跑不了的工具**。工具越少，
 * 选择也越准。
 */
export function unavailableToolReason(name: string, config: (key: any) => any = configService.get.bind(configService)): string | null {
  const need = TOOL_REQUIREMENTS[name]
  if (!need) return null
  return String(config(need.key) || '').trim() ? null : need.why
}

/**
 * 这台机器上**没启用**的能力，一句话一条，给系统提示词用。
 *
 * 为什么需要它：工具被藏起来之后，模型**看不见它存在**，于是用户问"我在读什么书"时它答
 * "我没有 get_weread 这个工具" —— 2026-09-28 实测就是这么一轮对话，用户因此以为功能没做
 * （其实做了、只是没配 key）。把"存在但没启用"告诉模型，它就能给出正确的下一步，
 * 而不是否认这个功能存在。
 *
 * **这不等于把工具摆回去**：模型依然调不到它们，只是知道它们存在。把跑不了的工具放进工具表
 * 的代价是实测过的（模型会去试，答复里带着一串报错，见 `availableToolDefs` 的说明）。
 */
export function unavailableCapabilities(
  config: (key: any) => any = configService.get.bind(configService),
): string[] {
  return Object.entries(TOOL_REQUIREMENTS)
    .filter(([name]) => unavailableToolReason(name, config))
    .map(([, need]) => need.why)
}

/** 这台机器上真正可用的工具表。快路径派发也要过同一道判据（见 `unavailableToolReason`）。 */
export function availableToolDefs(config?: (key: any) => any): ToolDef[] {
  return TOOL_DEFS.filter(def => !unavailableToolReason(def.function.name, config))
}
