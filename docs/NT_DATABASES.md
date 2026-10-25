# NT 数据库普查（db_storage 全量清单）

> 普查日期：2026-10-26，本机微信 4.1.15.56（D-130 verified）。方法：逐库用全库口令派生钥匙打开，
> 只读 `sqlite_master` / `PRAGMA table_info` / `COUNT(*)`，不导出行内容。脚本一次性（`probe_dbs.py` 用后即删），
> 本文档是留存。**行数是本机的观测值**，别的机器数量不同、表结构可能随版本变。

## 已解析（代码里有读取方）

| 库 | 读取方 | 备注 |
| --- | --- | --- |
| `message/message_*.db` | `nt_decrypt` / 导出 / 全家 | 消息分片（按时间切） |
| `message/biz_message_0.db` | `_utils.biz_message_db()` | 公众号推送 |
| `contact/contact.db` | 联系人 / 群 ext_buffer | 结构笔记见 CONTACT_DB_SCHEMA.md |
| `favorite/favorite.db` | `fav` 命令族 | 收藏 |
| `sns/sns.db` | `sns` 命令族 | 朋友圈缓存 |
| `message/message_fts.db` | `route_cards`（只 `LIKE`，不 `MATCH`） | 分词器 MMFtsTokenizer 不可用 |

## 未解析（2026-10-26 普查新增，按价值排序）

| 库 | 表 / 行数（本机） | 是什么 | 价值判断 |
| --- | --- | --- | --- |
| `head_image/head_image.db` | `head_image(1083)`：`username, md5, image_buffer, update_time` | **头像本体**：JPEG/PNG 完整图片字节内嵌库中（实测 magic：1056 个 `FFD8FFE0`、27 个 `89504E47`），按 username 键控，一人多行 = 头像变更历史 | **高**：导出/报告/replay 配真实头像；文件缓存清理会丢，库里永远在。**已实现 `weflow-cli avatar`** |
| `general/general.db` | `redEnvelopeTable(15)`、`transferTable(22)`、`revokemessage`、`websearch_record(81)`、`SearchRecent(36)`、`biz_subscribe_status(41)` 等 24 张 | **资金流与行为**：红包（hb_status/hb_type/receive_status）、转账（pay 双方/时间）、撤回记录、**微信内置搜索历史**、公众号订阅状态 | **高**：红包/转账与 `leads`/`reply-debt` 的"涉钱"判断同域；搜索历史是"我在找什么"的维度 |
| `hardlink/hardlink.db` | `image_hardlink_info_v4(4638)`、`file_(1972)`、`video_(128)`：`md5, file_name, file_size, dir1, dir2` + `dir2id(123)` | **媒体文件索引**：md5 → 实际文件路径（目录 id 经 `dir2id` 映射）。D-107 提到的 `hardlink.dat`（16 字节）与它不是一回事 | **高**：当前媒体匹配靠启发式（D-014），这张表可能把它变成精确查找——覆盖率问题的正解候选 |
| `emoticon/emoticon.db` | `kNonStoreEmoticonTable(75)`：`md5, caption, aes_key, thumb_url, cdn_url`、`kStoreEmoticonPackageTable(5)` 等 | **表情库**：自定义表情的 **aes_key 直接在表里**、CDN 地址、表情包清单 | **高**：自定义表情导出目前靠"扫内存反推 seed"——这张表可能让那条 hack 退役 |
| `message/media_0/1.db` | `VoiceInfo(1779+346)`：`chat_name_id, create_time, local_id, svr_id, voice_data, data_index` + `Name2Id` | **语音本体**：`voice_data` 内嵌库中（实测首字节 `0x0223`，**不是**标准 SILK 头 `#!SILK`/`TwoLL`，格式待研究） | 中：若解出格式，语音转写不再依赖 msg/voice 文件缓存 |
| `session/session.db` | `SessionTable(709)`：`summary, unread_count, status, is_hidden…`、`SessionUnreadListTable_1(27021)`、`SessionDeleteTable(6)` | **会话表**：未读/摘要/隐藏/草稿；`SessionDeleteTable` 记录**用户何时删了会话**（取证价值） | 中：`sessions` 命令现从消息分片推导，这里是一手表 |
| `solitaire/solitaire.db` | `SolitaireFold/Valid_<md5>`（19+21）：`front/behind_content, title` | **群接龙**：内容与参与记录 | 低（除非做接龙消息导出） |
| `contact/contact_fts.db`、`favorite/favorite_fts.db` | FTS5 结构（content/data/docsize/idx） | 联系人/收藏的搜索索引（衍生库） | 低：可从主库重建；分词器同样不可用 |
| `bizchat/bizchat.db` | `name2id(2)`、`chat_group(0)` | 企业微信联系人（本机几乎没用） | 低 |
| `chatbot/chatbot_message.db` | 4 张表全 0 行 | 微信内置 AI 助手的消息（本机未用） | 低 |
| `third_app_icon/third_app_icon.db` | 0 行 | 第三方应用图标 | 无 |
| `message/weclaw.db` | `wcdb_builtin_compression_record(0)` | WCDB 压缩簿记——**解开了 bonds 过滤 `@weclaw` 的疑惑**：它是客户端内部机制名 | 无（但解释了一个旧过滤项） |

## 钥匙

全部库用同一派生链打开（`nt_common.derive_database_key`：全库口令 PBKDF2 → 每库 salt），本次普查
14 个库全部一次打开成功——**NT 库没有按库独立的钥匙体系**，`emoticon.aes_key` 那类字段是内容层
（表情包 CDN 下载）的钥匙，不是库钥匙。

## 下一步候选

1. ✅ `avatar`（head_image）——已实现，见 `weflow-cli avatar`。
2. `general.db` 的红包/转账 → 与 leads/reply-debt 联动的"资金线索"只读命令。
3. `hardlink.db` → 媒体精确匹配（替换启发式，动 export 的媒体索引，工程量最大）。
4. `emoticon.db` 的 aes_key → 自定义表情导出去内存扫描化。
5. `media_*.db` 的 `voice_data` 格式 → 语音转写免文件缓存（格式未解，先研究）。
