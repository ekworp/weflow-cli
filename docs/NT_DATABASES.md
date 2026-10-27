# NT 数据库普查（db_storage 全量清单）

> 普查日期：2026-10-26 首次全量（微信 4.1.15.56，D-130 verified）；**2026-10-27 二次普查**
> 补齐读取方并逐条验证下列结构关系。方法：逐库用全库口令派生钥匙打开，只读
> `sqlite_master` / `PRAGMA table_info` / `COUNT(*)`，不导出行内容。
> **行数是本机的观测值**，别的机器数量不同、表结构可能随版本变。
>
> 2026-10-27 的行数是在同一天两次读数之间**会变**的（比如 `websearch_record` 一次 83、
> 一会儿 84——微信还在写）。所以本文的行数只作量级参考，别当断言用。

## 一、已解析（代码里有读取方）

| 库 | 读取方 | 备注 |
| --- | --- | --- |
| `message/message_*.db` | `nt_decrypt` / 导出 / 全家 | 消息分片（按时间切） |
| `message/biz_message_0.db` | `_utils.biz_message_db()` | 公众号推送 |
| `message/media_*.db` | `wechat_voice.py`（`VoiceInfo.voice_data`） | 语音本体，走文件缓存那套解码 |
| `message/message_fts.db` | `route_cards`（只 `LIKE`，不 `MATCH`） | 分词器 MMFtsTokenizer 不可用 |
| `message/message_resource.db` | `export_chat_html.py` | 图片资源，媒体匹配用 |
| `contact/contact.db` | 联系人 / 群 `ext_buffer` / `network` | 结构笔记见 CONTACT_DB_SCHEMA.md |
| `favorite/favorite.db` | `fav` 命令族 | 收藏 |
| `sns/sns.db` | `sns` 命令族 | 朋友圈缓存 |
| `head_image/head_image.db` | `wechat-cli avatar` | 头像本体内嵌（JPEG/PNG 原始字节） |
| `hardlink/hardlink.db` | `weflow-cli media`、`pdf-notes --from-chat` | md5 → 本地文件的**精确**路径 |
| `general/general.db` | `weflow-cli ledger`（2 张表）+ `weflow-cli extras`（其余） | 见下 |
| `session/session.db` | `weflow-cli extras sessions` | 一手会话表 + 删除痕迹 + 未读明细 |
| `emoticon/emoticon.db` | `weflow-cli extras emoticons` | **只有元数据**，图片解不开（见 §四） |
| `solitaire/solitaire.db` | `weflow-cli extras solitaire` | 群接龙 |
| `bizchat/bizchat.db` | `weflow-cli extras bizchat` | 企业微信联系人（本机几乎没用） |

`weflow-cli extras <kind>` 还接受 `overview`（每个库每张表的行数）与 `all`（全部）。
**`rows: null` 表示读不出，`0` 表示表在且为空——两者在输出里分得开。**

## 二、`general.db` 的 23 张表（2026-10-27 读数）

有数据的 15 张里，被读取方覆盖的：

| 表 | 行 | 读它的命令 | 是什么 |
| --- | --- | --- | --- |
| `websearch_record` | 83–84 | `extras search-history` | **微信内置搜索历史**：keyword + `pay_load_`（实测 83/83 是 JSON 形状，长度 377–432，内容未解析） |
| `SearchRecent` | 35 | 同上 | 搜索框里**点过谁**（username + query + score） |
| `brand_search_record` | 9 | 同上 | 品牌搜索 |
| `redEnvelopeTable` | 15 | `ledger` | 红包（**无时间列、无金额列**） |
| `transferTable` | 22 | `ledger` | 转账（有 `begin_transfer_time`） |
| `FMessageTable` | 11 | `extras fmessages` | **好友/群申请**（`content_` 是申请语，本机长度 3–33） |
| `biz_subscribe_status` | 41 | `extras biz-subscribe` | 公众号订阅状态 |
| `wacontact` | 470 | 同上 | **小程序资料卡**：`contact_pack_data` 是 **protobuf，470/470 可解析**（见 §四），解出名称 / 英文 id / logo / 简介 |
| `WeAppBizAttrSyncBufferTableV02` | 470 | 同上 | 同一批小程序的属性同步；`version` 列**存了非法 UTF-8**（见 §六） |
| `revokebatchmessage` | 2 | `extras revoke` | 批量撤回 |
| `revokemessage` | 0 | 同上 | 表在、本机无记录 |

仍然没有读取方的（本机 0 行，读出来也只有"是空的"）：
`groupPayTable`、`handoff_remind_v0`、`ilink_voip`、`new_tips`、`reddot`、
`reddot_last_notify`、`teenager_apply_access_agree_info`、`revokemessage`(见上)、
`biz_pay_status`(1)、`reddot_record`(3)、`ForwardRecent`(3)、`wcfinderlivestatus`(1)、
`wcfinderuserpage`(47)、`wacontact` 已覆盖。

## 三、已验证的结构关系（每条都带对照）

这些是**实测出来的**，不是猜的。写在这里是为了下一次没人需要重新试：

| 关系 | 证据 |
| --- | --- |
| `SessionUnreadListTable_1.username_id` = `Name2Id.rowid` | 276 个不同 id **276/276** 命中；按行算 **26816/26816** 全部解出会话（0 条 unresolved） |
| `SessionDeleteTable` 是"删过哪些会话"的**唯一痕迹** | 6 条删除记录里 **0 条**还留在 `SessionTable`（删除时两边一起删） |
| solitaire 表名里的 md5 = `md5(contact.username)` | 2 个表 md5 **2/2** 命中；contact 侧有 4228 个 md5 桶（碰撞不构成解释） |
| `SearchRecent` 与 `websearch_record` **不是**重复 | 35 条 query ∩ 83 条 keyword = **0**；合成一张会丢一半 |
| `kStoreEmoticonFilesTable` 是**单文件归档** | 每包 12–24 个文件，`emoticon_offset_` 从 0 起连续到 2–6 MB |
| 表情缓存里**有一部分本来就是明文图** | 抽 2000 个缓存文件看前 8 字节：JPEG 502 / PNG 141 / GIF 9 / wxgf 9 / 其他 1339（文件层结论，不是库层） |
| **`gh_` 前缀不专属于公众号** | `wacontact` 的 470 个**小程序** id 全是 `gh_`（470/470）。判据不是前缀而是内容：解出的简介写的是「下单免排队 外卖送上门」「快递查询、发货打单」「通过蓝牙技术连接蓝牙水控器」「官方点餐、买单小程序」，配合 `wx_app_opt` 列与表名 `wacontact` |
| 上面那条**不影响**现有 `LIKE 'gh_%'` 过滤 | 那 470 个小程序与 `contact.db`（4228 个号）、`session.db.Name2Id`、消息库 `Name2Id` 的交集**都是 0** —— 它们只住在 `general.db` 的 `wacontact` 里，所以 9 处 `gh_%` 公众号过滤没有被污染 |
| `pay_load_` 里哪些字段**真的在变** | 84 行实测：`scene` 6 档（88×69/134×8/236×4/33/139/218）、`parentType` 6 档（7×66/0×8/53×7/135/18/缺 1）→ 保留；`hotword` 与 `keyword` **84/84 相同**、`optype` **84/84 恒为 1**、`businesstype` 83/84 为 0、`timestamp` 与 `create_time` 只差 0～−2 秒 → **无新信息，丢掉**；`searchId` 78/84 是空串 |

## 四、`contact_pack_data` 是 protobuf（已解）

`wacontact.contact_pack_data` 没有 `.proto`，但**470/470 都能按 protobuf wire format
走通、0 失败**，所以不需要 schema：读字段号 → 值，再按实测值反推含义。

| 字段号 | 含义 | 实测依据 |
| --- | --- | --- |
| 2 | `name` | 4–5 个汉字（如「腾讯微保」「喜茶GO」「圆通速递」） |
| 3 | `englishId` | `tengxunweibao` / `xichaGO` / `yuantongsudi` 这类 |
| 4 / 5 | `logoUrl` / `logoUrlLarge` | 都是 `http://wx.qlogo.cn/mmhead/…`，本机逐行相同 |
| 6 | `description` | 25–38 字的中文句子（「下单免排队 外卖送上门」等） |
| 1 | （嵌套消息） | 本机多数为空，**不去猜它是干什么的** |
| 其余 | `unknownFields` | 只报字段号与出现次数，不猜名字 |

实现：`scripts/wechat_extras.py` 的 `parse_protobuf` / `decode_contact_pack`。
解不出返回 `None`（调用方标 `packDecoded: false`），**不返回空字典**——空字典会让人
以为"这个号没有资料"。

> 顺带一个反面记录：我一度看到 `user_name` 全是 `gh_` 就断定"这些是公众号、不是小程序"，
> 把字段改名成 `bizContacts`——**那是错的**。解出的简介内容（点餐 / 快递查询 / 蓝牙水控）
> 直接证明了它们是小程序。**前缀不是内容**；这次的教训是：换个角度（读内容）再验一遍，
> 比顺着一个看起来很强的信号推下去更可靠。

## 五、`emoticon.db` 的 `aes_key`：解不开（带正对照的否定）

76 行全部 `aes_key` 长度 32（hex → 16 字节，长度上正好是 AES-128），76 个**全不同**。
试解结果：

* 111 个能按 md5 对上号的本机缓存文件；
* 三种组合：`AES-128-CBC(key, iv=key)` / `CBC(iv=全0)` / `ECB`；
* 命中已知图片 magic（JPEG/PNG/GIF/wxgf）：**0 次**；
* **正对照**：同一批文件用全 0 当错 key 解，命中也是 **0 次** ——
  说明这个 0 不是"测试根本解不了任何东西"造成的假否定。

所以 `extras emoticons` **只给元数据**（md5 / caption / CDN 地址 / 所属表情包 /
包内文件偏移）。自定义表情的**解码**那条路仍未通，靠内存扫 seed 的老办法还在。

## 六、`WeAppBizAttrSyncBufferTableV02.version` 存了非法 UTF-8

直接 `SELECT version FROM WeAppBizAttrSyncBufferTableV02` 会抛
`Could not decode to UTF-8 column 'version'`，而**整条查询**失败——于是那张表被读成
0 行，看起来像"没有小程序数据"（实际 470 行）。

读法：`SELECT hex(version)`，Python 侧 `bytes.fromhex(...).decode('utf-8', 'replace')`。
`scripts/wechat_extras.py` 的 `T()`/`text()` 就是这个；输出里那一列叫 `versionHex`。
**同理适用于任何 TEXT 列装了二进制的情况**——所以那个脚本的文本列一律走 hex。

## 七、常量列（不可当分类维度）

同一台机器上的分布说明这些列在这个账号里**只有一个值**：

| 列 | 本机分布 | 后果 |
| --- | --- | --- |
| `SessionTable.type` | 710/710 = 0 | 拿它做 `--type` 过滤 → 全中或全空，两种假象 |
| `FMessageTable.type_` | 11/11 = 37 | 同上 |
| `wacontact.type` | 470/470 = 0 | 同上 |
| `biz_subscribe_status.is_subscribe` | 41/41 = 1 | 同上 |
| `kNonStoreEmoticonTable.type` | 76/76 = 3 | 同上 |

`wechat_extras.py` 因此**不提供**按这些列过滤，并在结果里带 `unverifiedEnums`。

## 八、仍然没解析的

| 库 | 表 / 行数（本机） | 是什么 | 价值判断 |
| --- | --- | --- | --- |
| `chatbot/chatbot_message.db` | 4 张表**全 0 行** | 微信内置 AI 助手的对话 | 无（本机没用过；表结构已记录，等有数据再说） |
| `third_app_icon/third_app_icon.db` | `third_app_icon(0)`：`app_key, icon_url_md5, image_buffer, update_time` | 第三方应用图标 | 无（0 行；有数据时它是 head_image 的同款做法） |
| `message/weclaw.db` | `wcdb_builtin_compression_record(0)` | WCDB 压缩簿记 | 无（但它解释了 `bonds` 里过滤 `@weclaw` 的来历：那是客户端内部机制名） |
| `contact/contact_fts.db`、`favorite/favorite_fts.db` | FTS5 结构 | 联系人/收藏的搜索索引（衍生库） | 低：可从主库重建；分词器同样不可用 |
| `general.db` 那 8 张 0 行表 | 见 §二 | 各种客户端簿记 | 无（0 行，且语义未验证） |

## 九、钥匙

全部库用同一派生链打开（`nt_common.derive_database_key`：全库口令 PBKDF2 → 每库 salt）。
两次普查合计 22 个库**全部一次打开成功**——**NT 库没有按库独立的钥匙体系**。
`emoticon.aes_key` 那类字段是**内容层**（表情包 CDN 下载/解密）的钥匙，不是库钥匙；
而且它在实测里连内容层也没解开（§五）。

## 十、下一步候选

1. ~~`wacontact.contact_pack_data`~~ → **已解**（§四，protobuf）。仍未映射的是字段 1
   （嵌套消息，本机多数为空）与 8–12：没有实测证据，不猜名字。
2. ~~`websearch_record.pay_load_`~~ → **已解**（§三末两行）。它是**请求上下文**、不是搜索结果；
   `searchId` 不能当"回查结果"的句柄。
3. 表情解码 → 仍然卡在 §五 那个否定上；要动它得先找到 16 字节 key 的真正来源。
4. `SessionTable.last_msg_type` / `last_msg_sub_type` / `last_msg_ext_type` 的语义未逐值验证
   （`draft` / `summary` 只是原样搬运，也没有语义结论）。
5. `contact_pack_data` 的字段 8–12（256 / 177 行有）含义未验证。
