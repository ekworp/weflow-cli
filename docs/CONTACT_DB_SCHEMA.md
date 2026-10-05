# contact.db 结构笔记（含 ext_buffer / extra_buffer）

> **口径**：以下全部在**一台机器的真实库**上跑出来的（Windows 微信 4.x，2026-10-03），
> 方法是只读地读表 + 手写 protobuf 走线（varint / length-delimited），**不依赖 protobuf 库**。
> 标 ✅ 的是验过的（有对照数据），标 ❓ 的是**没验出来**的 —— 后者不要当结论用。
> 复现方法见文末。

## 1. 库里有什么

`contact.db` 共 17 张表。有数据的：

| 表 | 行数（本机） | 说明 |
| --- | --- | --- |
| `biz_info` | 698 | 公众号信息，`external_info` 是一大段 JSON 文本 |
| `chat_room` | 77 | 群；**`ext_buffer` 就这里**（每行都有，1500 ~ 21590 字节） |
| `chat_room_info_detail` | 77 | 群的公告等；另有自己的 `ext_buffer_`（6 ~ 2210 字节） |
| `chatroom_member` | 4146 | `(room_id, member_id)` —— 库自己的成员关系表 |
| `contact` | 4014 | 联系人，22 列；二进制列叫 **`extra_buffer`**（不是 `ext_buffer`） |
| `stranger` | 1 | 与 `contact` 同 22 列形状；`extra_buffer` 是**另一套** protobuf |
| `openim_appid` / `openim_acct_type` / `openim_wording` | 1 / 1 / 21 | 各有一列 `ext_buffer`，**schema 互不相同** |
| `name2id` / `encrypt_name2id` / `contact_label` / `ticket_info` / `sqlite_sequence` | 4025 / 1 / 1 / 92 / 1 | id 映射与杂项 |
| `oplog` / `room_verify_application` / `stranger_ticket_info` | 0 | 空表：`oplog(id, buffer)`、`room_verify_application(8 列)`、`stranger_ticket_info(id, ticket)` |

### 1.1 `biz_info`（公众号表，2026-10-05 首次测绘）

15 列。**代码从来没读过它**（全仓库 grep 下来只有这份文档提到过 `biz_info`/`external_info`），
但里面**有日报线现在拿不到的东西**。

- 核心列：`username`（身份 id）、`type` / `accept_type` / `child_type` / `brand_flag`、
  `external_info`（JSON）、`brand_info`、`brand_icon_url`、`home_url`、`sync_version`；
  `brand_list` / `ext_buffer` **全空**。
- ⚠️ **一个坑**：`sync_version` 声明是 TEXT，**实际是二进制 blob** ⇒ 直接 `SELECT *` 会在 UTF-8 解码上崩，
  要 `text_factory=bytes`。（现在没代码读它，所以是隐患不是现伤。）
- `external_info`：根一律 dict、**0 解析失败**，共 **30 个键**。覆盖最高的几个：
  `Appid` 698 / `MMBizMenu` 673 / `RegisterSource` 650 / `WxaAppInfo` 599 / `VerifySource` 271 /
  `ServiceType` 257 / `PersonVerifyInfo` 72。
- **它是不是"我关注的公众号"**：准确说是"**客户端已知的公众号集合**"——698 = `Name2Id` 里的 683 个 `gh_`
  + 15 个系统号；**凡是 `contact` 里的 `gh_` 必在 `biz_info`（单向包含）**。另有 **10 个 `gh_` 在
  biz / Name2Id 里而 `contact` 里没有**（`contact` 取关是**硬删行** ⇒ 疑似取关残留），
  以及 **33 个号有消息表却不在 `biz_info`**。
- **对日报线的增量（现成的，不用联网）**：`RegisterSource.RegisterBody` = **主体名称（93.1% 覆盖）**、
  `VerifySource.Description` / `VerifyBizType` = **认证类型**、`ServiceType` = **服务类型**、
  `brand_icon_url` = **头像直链（691 行）**、`PersonVerifyInfo.VerifyDescribe` = 个人号简介（68 行）。
  现状是：日报的名字取自 `contact.remark` / `nick_name`、**不用头像**，而 `contact.description` 在
  673 个 `gh_` 里**全空** ⇒ **今天根本没有"主体名称 / 简介"的来源**。
- **隐私**：键名扫 `token`/`session`/`cookie`/`password`/`login` **0 命中**；但确有
  `PersonVerifyInfo.VerifyName`（**认证人真名**）、`ServicePhone`、`Location`（经纬度）、企业 `corp_id`
  ⇒ 取用时只取需要的字段，**别整包带出去**。

## 2. `chat_room.ext_buffer` = protobuf（已验）

顶层只有三种：`#1`（长度分隔，重复）× N、`#3`/`#4`（varint，**两者恒相等**）、`#5`（长度分隔，重复）。
本机 77 行里出现过的字段号只有 `1`（4151 次）、`3`（77）、`4`（77）、`5`（**28 条目，落在 15 个群**）
—— **没有 `#2`，也没有 `#6`**。（`#6` 是 `chat_room_info_detail.ext_buffer_` 的东西，见第 3 节；
两个 blob 长得很像，别混。）

```
RoomData {
  repeated RoomDataUser users = 1;   // ✅ 成员列表
  // 下面是实测到的、上游定义里没有的：
  //  3 = varint, 4 = varint（每个群 #3 == #4；见 6.1）
  //  5 = 长度分隔，重复（**= 成员里 status 位 11 置位的那批 id**，77/77 与该集合完全相等；
  //      不是"额外的参与者"——早前那么叫是错的，见 D-070 与第 6 节）
}
RoomDataUser {
  string userName    = 1;  // ✅
  string displayName = 2;  // ✅ 群昵称。本机 **1252/4151 = 30.2%** 的成员有（其中 14 条是空串），
                           //    其余 2899 条**连字段都没有**（早前写的 85.2% 是错的）
  int32  status      = 3;  // ⚠️ **不是 0-9**，是位标志：实测 0/1/9/17/25/2057/2073/
                           //    8193/2097153/3145729/6291457/7340049
  string inviter     = 4;  // ✅ 邀请人（本机 4074/4151 = 98.1% 有）
}
```

**验过的对照**：`#1` 的条数与关系表 `chatroom_member` 逐群对（77 个群）：**72 个相等、5 个不相等，
且这 5 个一律是"blob 比表多 1 个人"**（`id` = 331 / 2007 / 2148 / 2869 / 3968），从不更少；
多出来的那个人在 `contact` / `name2id` 里都存在（不是脏数据）。**以 blob 为准 —— 它更新。**
（这 5 个群正好就是 6.1 里 `#3 != #4` 的那 5 个：两件事是同一个「已到达、还没落到关系表的
成员变更」的两个标志。）

**与上游定义的差异**（[Wing900/chatlog-export](https://github.com/Wing900/chatlog-export) 的
`internal/model/wxproto/roomdata.proto`，声称 v3/v4 通用）：成员那一段**完全对得上** ✅；
但它写的 `optional int32 roomCap = 5` ❌（实测 `#5` 是长度分隔的字符串列表）；
顶层的 `#3`/`#4`/`#6` 它也没有 ❌。它的注释"syntax v3 & v4 通用，可能会有部分字段差异"
——差异比注释里说的大。（**客户端自己**给这个 blob 的类型叫 `micromsg.ChatroomExtData`，见 3.1。）

## 3. 其余几处 protobuf（形状已验，语义多半未定）

| 列 | 形状 | 状态 |
| --- | --- | --- |
| `chat_room_info_detail.ext_buffer_` | `#1`(wt2) + `#3`/`#4`(varint) + 有时 `#6`(varint)，1 行里还见到 `#7` | ❓ **另一套编号**：`#3` 与该群 `chat_room.ext_buffer` 的 `#3` **从不相等**（0/77）；`#3`/`#4` 大多相等、**5 行差 1**（见 6.1）；`#6` **就是公告发布时间**（25 行里有 23 行 == `announcement_publish_time_`，另 2 行 blob 里是 0）；`#1` 多数为空、少数是一大块二进制 |
| `contact.extra_buffer` | `#3`(varint)，2 字节上下 | ❌ **追到边界了**：4014 行里 **3028 行的这一列是空的**（≈75%；这个数与 `local_type = 3` 的行数**恰好相等**——本机所有 `local_type = 3` 的行都空）；**986 行非空**，其中 **984 行顶层有 `#3`**、2 行没有（另有按 proto 形状的切法得 942 / 44，44 行是另一种 proto —— 与"有没有 `#3`"**不是同一个判据，别混用**）。有值的 `#3` 只有 0(520)/3(418)/9(2)/1(1)/515(1)。与同行 21 列**没有一列一一对应** —— `local_type`/`flag`/`verify_flag`/`is_in_chat_room`/`chat_room_type` 逐张列联表都试过（`verify_flag` 的 0/8/24 三种取值下 `#3` 都同时有 0 和 3）。唯一稳定的关系是**存在性**：`local_type = 3` 的行全部为空，有值的基本只在别的类型上 —— 存在性与类型相关。**取值本身**见第 6 节（逐位后只解出两条：`bit0 == (值≠0)`、`bit1 ⊂ bit0`） |
| `stranger.extra_buffer` | 38 个顶层字段（`#2`…`#38`，varint 与 length-delimited 混排，含嵌套） | ❓ 形状清楚，字段含义**一个都没定** |
| `openim_appid.ext_buffer` / `openim_acct_type.ext_buffer` | 各约 200~340 字节，顶层 3~4 个字段、含嵌套 | ❓ 与上面几套**都不一样** |

### 3.1 这几个 blob 的**类型名**（2026-10-03 从客户端二进制里读出来的）

客户端安装目录里的 `Weixin.dll` 里有一张"类型名"表（生成的代码给每个 message 都留了全名）。
`local_proto/local_contact.pb.cc` 这个编译单元注册的，正好就是本地 contact 库那几个 blob 的类型：

| 我们的列 | 客户端里的类型名 |
| --- | --- |
| `chat_room.ext_buffer` | `micromsg.ChatroomExtData` |
| 每个成员子消息 | `micromsg.ChatroomMemberLocalData` |
| `chat_room_info_detail.ext_buffer_` | `micromsg.ChatroomDetailInfoExtData` |
| `contact.extra_buffer` | `micromsg.ContactExtData` |
| `stranger.extra_buffer` | 同一编译单元里有 `micromsg.OpenIMContactExtData` —— 与「`stranger` 是外部联系人」对得上，但**没验** |

同一编译单元还注册了 `WeclawExternalInfo` / `OpenIMKefuContactExtData` / `CustomInfoExtProfileInfo*` 等，
正好是 contact 库里"带 `ext_buffer` 的那几张表"那一整套。**所以 blob 是有类型的，我们能叫出类型的名字。**

**但字段名拿不到，而"客户端到底留没留名字"这件事现在说清了：**

- **明文只到"表的列名"这一层** —— 同一份 dll 里 `contact` 的列名就是明文数组
  （`nick_name / quan_pin / … / extra_buffer / …`），`chat_room_info_detail` 的也是
  （`room_id_ / … / ext_buffer_`）；
- 这些**本地 message 的字段名不以明文出现**。挨着类型名的那几块是二进制（高熵、不可读），
  把同一把密钥套上去还是乱的；
- ⚠️ **早前那版 3.1 里我把附近那批 `<长度><hex>` 记录当成"字段名被编码"，是错的** ——
  那批是客户端的**字符串池**，见 3.2。

**实际意义**：`#3`/`#4` 现在能追到「`micromsg.ChatroomExtData` 的第 3、4 号字段」这个粒度；
名字只剩 3.2 那条**候选**，要坐实还得换环境（另一个微信版本 / 另一台机器）。

### 3.2 客户端把一批字符串混淆了（2026-10-03 破掉）

`Weixin.dll` 里有一大批这种记录（本机数出 **41,913 条**长度自洽的；最长 580 字节）：

```
0xa1 <4 个 ASCII 十六进制数字> 0xb1 <2N 个 ASCII 十六进制字符>
```

（⚠️ 第一版我数出 41,557 条——那个正则的上限写成 200，把 **356 条 >200 字节的记录静默丢了**。
"数量对不上"的时候先怀疑自己的正则，别怀疑是别人漏了。）

前 4 位是小端 uint16，**正好等于**后面那串 hex 解出来的字节数（长度分布峰值在 8~21 字节）。
字节本身是 **明文 XOR 一条固定的逐位密钥**。判据：随便拿一条算出来的密钥去解全部 41k 条，
**每一位的可打印率都在 86%~100%**（随机密钥只会有约 37%；26 字节全可打印的概率约 1e-11）。
穷举式的"它是不是哈希"先做过一轮：拿已知列名做 md5/sha1/sha256/变体 895 组，**0 命中**。

密钥是这样拿到的：先用一条密文假设明文前缀是 `wechat::<表>::<字段>`，再用**逐位搜索**
（每位选"让解出来的字节最集中在标识符字符上"的那一档）——前 30 位就出人话了；剩下第 0 位
有个系统性偏差（差 `0x19`），用 crib 修掉（`rernel::`→`kernel::`、`jessionid:`→`sessionid:`、
`Iarameter`→`Parameter`）；第 30 位之后按同样办法扩到 200 位。

解出来是**客户端的字符串池**：C++ 符号、源文件名、日志片段。抽样：

```
kernel::manager::ChatroomManager::GetChatroomMemberCount
kernel::manager::InitContactManager::CoRequestAndProcess
init_contact_manager.cc / contact_util.cc / windows_version.cc
'Parameter validation failed: P…'
',chatroom_seq='    ',contact_seq='    ' total_count_='
```

**池里没有我们要的字段名**：`ChatroomExtData` / `ext_buffer` / `extra_buffer` / 任何 `micromsg.*`
全 **0 命中**；`member_seq` / `room_seq` / `member_version` / `room_version` 也全 0。

**对本文有用的是最后一行**：初始化联系人流程（`init_contact_manager.cc`）的日志键里有一个
**`chatroom_seq`**（和 `contact_seq`、`total_count_` 并排）。**但它跟 6.1 量到的 `#3`/`#4` 对不上**：
它出现在**账号级**的 InitContact 收尾日志里（同一段还打 `respCount`、` total_count_=`），
**日志里没有任何房间标识**；全池里"同时含 room 与 seq"的串**只有这一条**。⇒ 它更像
**"群列表整张表的游标"**，不该拿它给我们的"每群一个"的字段命名（两轮独立追查都指向这个结论）。

### 3.3 客户端**也有**明文字段名组 —— 但拿不到字段号

除了 3.2 那层被混淆的字符串池，客户端 `.rdata` 里还有**成组的明文"字段名清单"**
（本机数出约 3,764 组 / 76,022 个槽）。它们排成**"实体注册组"**：条目固定 0x20 字节
（`pool_ptr | tag | … | name_rva`），`tag ∈ {1,2,3,4}`，组内用 **4 字节 RVA** 指向名字串 ——
所以"哪些名字属于同一组"是**可复跑**的（把名字的文件偏移当 RVA，全文件搜 `struct.pack('<I', off)`；
例：`InfoVersion` 有 4 处引用）。抽两组看形态（与 6.1 的 `InfoVersion` 同一片）：

- `ChatRoomName | UserNameList | DisplayNameList | ChatRoomFlag | Owner | IsShowName | SelfDisplayName | RoomData`
- `strUsrName | nOrder | nUnReadCount | parentRef | strNickName | nStatus | nIsSend | nMsgType |
  nMsgLocalID | nMsgStatus | nTime | editContent | othersAtMe | bytesXml`（**匈牙利命名** ⇒ 像 V3 时代/镜像
  struct；这 14 个名字**跨两个实体**，边界在 `nUnReadCount` 之后）

**三条边界（前两条是负结果，第三条是纠错）**：

- **没有任何一张名字表带字段号**：全文件扫过 3,764 张表，"（名字, 小整数）"的配对里**没有编号表**；
  名字旁的 `tag` 是 `{1,2,3,4}` 这种**结构标记**（从不出现 6/7，而 detail blob 实测字段号是 1/3/4/6/7）
  ⇒ **"名字表第 n 个 = 字段号 n"不成立**。
- **"名字表 → 具体 message 类型"这一层没有链**：类型名字符串本身几乎不被任何 RVA/VA 引用；而我们关心的
  `ChatroomExtData` / `ChatroomMemberLocalData` / `ChatroomDetailInfoExtData` 在各自编译单元里
  **根本没有字段名表**（那片区域只有类型名后缀 + `contact` 的 snake_case 列名）。
- ⚠️ **纠错（2026-10-04）**：本节早前一版写"全文件搜这些名字的指针引用都是 0"——**那是错的**，
  来自一次**PE 节区 file-offset ↔ RVA 错位**。实际存在 **4 字节 RVA 引用**（`InfoVersion` 4 处），
  以能一行复跑的那个版本为准。这是本轮两个子 Agent 互相核对出来的：一个报了 0 引用，另一个复跑复现出 4 处。

**教训**：以后再看到"某个明文名字恰好和某个字段对得上"，**先验证名字顺序能不能对上字段号**——
对不上就只能当线索，不能当名字（6.1 的 `InfoVersion` 候选就是这么撤掉的）。

**2026-10-04 又把范围扩到"本机所有腾讯系二进制"（84 个文件，含四个微信版本）**：

- 本机其实有 **四个微信版本**：`4.1.15.11` / `4.1.15.13`（在 `D:\WeiXin\` 下）与 **`4.1.12.26` / `4.1.13.12`**
  （在 `C:\微信\Weixin\` 下）。**都没有配套的数据目录**（数据只有一份，见 6.2）。
- **三版 `Weixin.dll` 的明文名字组一字不差**，而且我们那三个类型
  （`ChatroomExtData` / `ChatroomMemberLocalData` / `ChatroomDetailInfoExtData`）的**类型注册块逐字相同**
  ⇒ **老版本也没给我们那层字段名**。
- 84 个文件里**没有任何 `RoomData` / `RoomDataUser` 的字段名组**：`RoomData` 只作为那族 V3 名字组的**末位**出现。
- 唯一的跨版本**差异**：`roomCap`（那份公开 proto 里的字段名）在老版本 `4.1.12.26` 的 `ConfSdk.dll` 里有 **6 处**，
  而 **4.1.15.13 的 22 个 exe/dll 里全是 0**。它是 V3/配置侧的遗留，**不能拿来给我们的字段命名**（何况
  我们实测 `#5` 是成员 status 位 11 的投影，不是 `roomCap`）。
- 企业微信（WXWork）**只剩数据、主程序已卸载** ⇒ 那条路也不通。

**把 3,764 张表全看一遍之后，还得到三条**（都写在这里，省得后人重跑）：

- **contact 库的"实体名"是明文**，而且是 snake_case：
  `contact | group_contact | group_member | stranger | im_contact | im_group_contact | im_group_member |
  im_stranger | chatroom | chatroom_detail` —— 我们的两张表在客户端里就叫 `chatroom` / `chatroom_detail`。
- **`chat_room_info_detail` 的列名有明文组**（`room_id_ | … | ext_buffer_`），但 **`chat_room`（= `chatroom` 实体）
  的列名偏偏没有**；取而代之的是那族 **V3 风格**的 8 名字组
  （`ChatRoomName | UserNameList | DisplayNameList | ChatRoomFlag | Owner | IsShowName | SelfDisplayName | RoomData`）。
  ⇒ **客户端自己给我们这个 blob 那个"成员"叫 `RoomData`**（V3 谱系：V3 时代成员在 `UserNameList` /
  `DisplayNameList` 列里，V4 挪进了这个 blob）。
- **没有任何一组名字描述这个 blob 的顶层字段**：`users`、`roomCap`、`memberList`、`MemberVersion`、
  `UserListVersion`、`MemberSeq`、`RoomVersion`（含 snake 变体）在 3,764 张表里**全 0 命中**。
  ⇒ `#3`/`#4` 的名字**不是"没找到"，而是这一版客户端里就没有可读的存放处**（见 8 节的公开圈结论）。

## 4. 明确证伪的猜测（省得后人再试一遍）

对 `chat_room.ext_buffer` 顶层那个 `#3`（每个群一个数、与 `#4` 恒相等），验到这四条**否定**：

- ❌ 不是 `max/min(chatroom_member.member_id)`（20 个群 0 命中）；
- ❌ 不是 `chat_room.id` —— 而且**厂商自己的 DLL 给出了这个字段的正解**：它内置的 SQL 是
  `FROM name2id n LEFT JOIN chatroom_member c ON n.rowid = c.room_id`，也就是 `chat_room.id`
  = `name2id.rowid`（本地行号），与 `#3` 那个大数字不是一个 id 空间；
- ❌ 不是群号（群 `username` 都是 `11 位数字@chatroom`，而 `#3` 是 9 位或 5 位）；
- ❌ 不是消息会话表名 `Msg_<md5>` 里那个 md5 的输入（实测那 139 张表的输入是**群的 username**，
  61/74 命中；`#3` 作为输入 0/74）。

**最强的一条**：把 24 个群的 `#3`（其中 **24 个是大值**，`≥ 10^8`）拿到 `db_storage` 下**全部 24 个
数据库**的**每一张表的每一个非二进制列**里找（文本列也按子串找），**大值命中 0 个**。
消息**内容**里也找过（第 8 节）—— 同样 0。
大整数不可能与别处的 id 撞车，所以结论是硬的：

> `#3` 只存在于 `chat_room.ext_buffer` 这个 blob 里；本机可见的任何表都不存它。

**能说到的程度**（2026-10-03 又往前推了一步，细节见 **6.1**）：它**不是**每群固定的 id —— 同一天里
它会变（实测 +2）；`#4` 与它恒等，是因为它俩是**一对版本号**（同一个计数器的两份：新版本 / 已落库版本，
见 6.1）。去掉底数之后的大小跟**成员数量/成员变动**走（秩相关 0.92 ~ 0.94），跟消息数几乎无关。
底数有两种（`10000`：47 个群；`7×10^8`：24 个群），跟记录进库的先后相关。
**它到底叫什么名字，本机判定不了** —— 那需要对照源（另一台机器 / 另一个微信版本 /
同一房间的两个时点快照）。**别再照着猜往下写代码。**

（`contact.extra_buffer` 的 `#3` 是同一种形状：取值在同行各列里找不到对应物。两张表的结论一样 ——
**这些 blob 字段不与本地 schema 镜像**，它们是厂商自己状态机里的位/标识，本地不存第二份。
所以"能不能解出来"这件事，卡点不在解码，而在**没有对照源**。）
（第一版扫描曾报"22 个库打不开"，那是**我自己传错了钥匙**：把配置里的原始 key 当成了派生后的
hexKey。修对之后 24/24 全能打开 —— 这类"打不开"要先怀疑自己。）

## 5. 实用替代（不用解 blob 也能拿到大部分东西）

只要成员与显示名：`chatroom_member`（`room_id` → `member_id`）join `name2id` / `contact` 即可，
本地就能做。**blob 多出来的是两样**：每个人的 `status`（位标志）与 `inviter` —— 库里的表没有。
（`#5` **不算多出来的东西**：它等于"成员里 status 位 11 置位的那批 id"的投影，见第 6 节。）

本仓库现在**只解已验证的那部分**：`weflow-cli contact-schema`（脚本 `scripts/contact_schema.py`，只读本地）
输出每个群的成员（`userName` / `displayName` / `status` / `inviter`）与 `#5`
（JSON 键 `statusBit11Ids`），以及该群里**未识别**的字段号。

```
weflow-cli contact-schema -n 3           # 看 3 个群
weflow-cli contact-schema --json         # 机器可读
```

两条边界写死在实现里（见 D-068）：

- **未识别字段原样带出、不猜名字**：顶层 `#3`/`#4` 进 `unrecognized`，键就是字段号。一旦给它编个
  像样的名字，下游迟早会拿一个猜出来的含义写逻辑。
- **解不动就报错**：坏 blob 抛异常并进 `failures`，**绝不返回空成员表** —— "解不动"和"这个群没人"
  是相反的两件事。

群昵称那条路仍然走原生 DLL（`wcdb_get_chat_room_ext_buffer`，见 `src/core/wcdbCore.ts`）；
`contact` 库的其余二进制列（`stranger.extra_buffer` 的 38 个字段等）**仍未解**，见上面第 3 节。

## 6. 位域：那些"未定"的字段，有一半能定性到形状

前面标 ❓ 的字段里，有一部分能再往前推一步：**它们是位标志，不是枚举**。

- **群成员 `status`**（`chat_room.ext_buffer` 成员 `#3`）：实测 27 种取值，出现过 **8 个位** ——
  `0, 3, 4, 11, 13, 20, 21, 22`；其中位 0 占绝大多数（4037 次），像"正常成员"。
  ⚠️ **"非零时最低位恒为 1" 这条假设是错的**（`8` = 只有位 3、`8192` = 只有位 13 单独出现过）——
  这是我先提出来、再被自己的数据否掉的，记在这儿免得后人又当约定用。
- **`contact.extra_buffer` 的 `#3`**：5 种取值（0/3/9/1/515），出现过 4 个位 `0, 1, 3, 9`。

**已经定下来的两条"位 ↔ 含义"（2026-10-03，都由子 Agent 提出、我独立复核）**：

- **位 11（2048）↔ `#5`**：`chat_room.ext_buffer` 顶层 `#5` 的 id 集合与"该群成员里 `status & 2048`
  的那批人"**逐群完全相等（77/77）**；全库 4151 个成员里带 bit11 的正好 **28 个**，与 `#5` 的
  28 条目**一一对应，一个不多一个不少**。⇒ `#5` 是成员列表的**投影**，没有独立信息；
  **早前把它当"额外的参与者 id"是错的**（见 D-070）。
- **`chat_room_info_detail.chat_room_status_` 的位 17（131072）↔ "本群与企业微信/openim 互通"**：
  置位的 6 个群**全部**有 `@openim` 成员或群主；不置位的 71 个**全部**没有（77/77）。

**成员 `status` 里还有 6 个位没解出来（2026-10-05），但它们的"作用域"已经定了：**

- **位 `3/4/11/13/20/21/22` 全是"房间内成员"的状态，不是"这个人"的属性**：同一个 `username`
  在不同群里带同一位的一致率只有 **0~12%**（对照组：位 0 是 **93%**）⇒ "某位 = 这个人是 X"这类读法
  **整类被否掉**。这一条比"某一位的含义"更有用：它把搜索空间从"人的属性"缩到"群内状态"。
- **位 0**：默认/正常标志（97.6% 置位）。**缺它的恰好 100 人**，且高度房间集中
  （其中一个房占 64 个，另有 3 个房整群都缺）⇒ 像"未初始化的成员行"。
- **位 4**（300 人）：最强倾向 = **有群昵称**（0.693 vs 0.271）+ 偏老成员；**与位 13 完全互斥（交集 0）**。
- **位 3**（272 人）：只有弱相关（同样是"有群昵称"0.489 vs 0.288）。**没找到干净判别式。**
- **位 13**（422 人）：最好的判别式是**房间级**的 `chat_room_status_` 位 17 / openim（0.668 vs 0.264）——
  但那是房间属性，**别读成"位 13 = openim"**；成员级没有干净判别式。
  （本机登录账号自己在 5 个群里带这一位。）
- **位 `20/21/22`**（21/30/23 人）：**没解出来**。三者成簇（20/22 只与 21 同现），取值范围只有 `1/3/5/7`
  ⇒ 更像"位置 20–22 上的一个小枚举"，不是三个独立标志；集中在 8 个房里。
- **已否掉的读法**（列出来省得再试）：位 = 好友 / 位 = 群主 / 位 = 我自己
  —— **群主与本机账号自己基本都只是 `status = 1`**。

**顺带核清的几列**（`contact` 共 22 列，其中这几列是标志型）：`delete_flag` **全 0**（4014 行 ⇒ 取关是硬删行）；
`verify_flag` = `0(3327)/8(356)/24(241)/520(54)/1048(22)/776(11)`；`is_in_chat_room` = `0/1/2`；
`chat_room_type` = `0(4010)/2(4)`；`chat_room_notify` = `0(3960)/1(54)`。
**一条副产品关系**：`verify_flag != 0` 的 687 行**全部是"不在任何群里的人"**（单向蕴含；
反过来不成立 —— 非群成员里也有 545 行为 0）。

**`chat_room_status_`（房间级，32 位标志）—— 2026-10-05 又解出两位（含"众数"那一位）**：

- **位 19（524288）⟺「该房已初始化（`status ≠ 0`）**且**与 openim 不互通」**：**77/77 完全一致**（我独立复核过）。
  这就解释了它为什么是**众数（51/77）而不是常量**——openim 群与 `status = 0` 的新群**都不带**这一位。
  ⇒ 文档里此前"位 19 只是众数、与 `#3` 的族没有干净关系"的写法可以收起来了：**它有确切含义，只是与 `#3` 无关**。
- **位 2 与位 31 恒同现**（77/77）⇒ 在本机数据上**这两位的含义分不开**，别单独解释其中一位。
- 位 `14 / 21 / 27` **没解出来**（各 1~3 个群，样本太小）。
- `chat_room_status_ = 0` 的 16 个群**全部**是 id ≥ 3327 的新群，但**不是**"最新 16 个"
  （有 4 个更新的群取值不为 0）。

**`contact.extra_buffer` 的 `#3`（逐位重做后，2026-10-05）**：4 个位 `0/1/3/9` ——

- **`bit0` ⟺ 值 ≠ 0**（这是恒等式，不是发现）；
- **`bit1 ⊂ bit0`**：`bit1 = 1` 的 **423 行全部是 `local_type = 1` 且不在任何群里**（423/423 单向干净）；
- `bit3`（2 行）/ `bit9`（1 行）**没找到**判别式 —— 样本太小，且本机没有第二个参照实例。
- ⚠️ 早前一版写的"取值本身无从判定"，是**拿整值（0/3/9/1/515）做列联表**得出的结论；
  对位域而言粒度就是错的（两个位会互相抵消）。逐位重做后才有上面两条 —— **这是本轮的一处方法更正**。

**这解释了为什么它们找不到对应列**：位标志是**集合**，不会与任何单一列镜像 ——
所以"跟每列做列联表"这种找法注定失败，不是我没找到。

### 6.1 `#3` / `#4` 那一对（2026-10-03 追出来的）

这是全篇最想解的一个：每个群一个数、`#3 == #4`、只在 blob 里、跟本地任何列都对不上。
现在能说到下面这个程度 —— **下面每条都是本机 77 行实测，可复跑**（脚本见第 9 节）。

**① 它是"同一个量写了两遍"的一对数 —— 但这条是拿 `chat_room_info_detail` 证出来的。**
`chat_room` 自己的 `#3`/`#4` **77/77 恒等**（不等的 0 个），所以在它自己身上看不出"两份拷贝"；
能看出的是结构相同的 `chat_room_info_detail.ext_buffer_`：同一对字段号 `#3`/`#4` 在 **5 行** 上
`#3` 比 `#4` **大 1**（`room_id_` = 331 / 2007 / 2148 / 2869 / 3968，其余 72 行相等）。

**② 那 5 个群另有一个独立标志，而且正好是同一批 —— 但"差 1"是 detail 的性质，不是 chat_room 的。**
`chat_room.ext_buffer` 的成员条数 vs 关系表 `chatroom_member`：**5 个群不相等**，一律是
"blob 比表**多 1 个人**"（从不更少），多出来的那个人在 `contact` / `name2id` 里都在；
**这 5 个群正好就是上面那 5 个**（77 里挑 5，两次挑中同一批）。
⚠️ **但把 detail 的配对语义搬回 `chat_room` 不成立**：在那 5 个"成员未落库"的群里，
`chat_room` 的 `#3`/`#4` **仍然恒等**；而且两组取值**从不相等**（0/77），本就是两套编号。
所以"`#3 != #4` 是 pending 标志"这条**只对 `chat_room_info_detail` 的那一对成立**。
（另一种同样与数据相容的读法：三个存储——chat_room blob / detail blob / `chatroom_member` 表——
落后程度不同；**只有一次快照时区分不了**。别把这条读成结论。）

**②b 但从这些数据能看到一件确定的事：它俩会变，而且库里自带"变更前/变更后"两份。**
不需要等下一次变更：同一时刻库里就并排存着"成员比关系表多 1 个"和"detail 的 `#3` 比 `#4` 大 1"
这两种落后状态（5 个群，两个独立 loci 同时命中）。

**③ 去掉底数之后，那个数跟着"成员"走，不跟消息走。**

| 分组 | 房间数 | 取值范围 | 与成员数的秩相关 | 与消息数的秩相关 |
| --- | --- | --- | --- | --- |
| `10000 + x` | 47 | 10000 ~ 11379（x = 0 ~ 1379） | **0.937** | 0.043 |
| `700000000 + x` | 24 | 700000010 ~ 700015304（x = 10 ~ 15304） | **0.749** | 0.395 |
| 小值 | 3 | 1254 / 1304 / 2021 | 样本太少 | — |
| `0` | 3 | 0 | 样本太少 | — |

**④ 底数有两种，而且是"梯度"不是硬分界；两种底数的年龄差得很开。**

- 47 个群底数 `10000`、24 个底数 `7×10^8`、3 个是 1~2k（1254/1304/2021）。按 `chat_room.id`
  （≈ 进 `name2id` 的先后；`id == name2id.rowid` 已验 77/77）看：`7×10^8` 那批中位 id **1770**、
  `10000` 那批 **2865**；`Spearman(#3 − 底数, id) = **−0.420**`，最高那档 id 里 `7×10^8` **0 个**、
  `10000` **12 个**。⇒ 趋势明显，但**没有任何一条**（id / 公告时间 / 成员数 / status）能把两族干脆分开。
- **年龄**：用**公告发布时间**（真实墙钟；不用消息表的 `create_time`，那只是本机保留窗口的起点）——
  `7×10^8` 族最早的公告在 **2019-01-27**，`10000` 族最早只到 **2024-04-13**。⇒ `7×10^8` 那批**更老**。
- **第三种来源那 3 个群 = 企业微信/openim 互通群**：它们的 `owner` 与公告编辑者**都是 `@openim`**，
  且都带 `chat_room_status_` 位 17（= 与 openim 互通，见第 6 节）。但 openim **不是充分条件** ——
  另外 3 个沾 openim 的群落在 `7×10^8` 族。**为什么分成这样，本机定不了。**
- 3 个 `#3 = 0` 的群**正好**是 3 个 `owner` 为空的群（没初始化）。
- **底数不是"某个计数器的历史读数"，更像"固定种子/号段底"**：本机唯一另一处"服务端 seq 空间"是收藏库
  （`fav_db_item.update_seq ∈ [7.54e8, 8.88e8]`、`fav_tag.seq = 8.41e8`），它**2021-11 就已经是 8.41e8**；
  而一个**公告时间是 2024-05** 的房，底数仍是 `7×10^8`。⇒ 时间线对不上"历史读数"，
  只能读成**一个固定的号段底**（`10000` 与 `7×10^8` 同形：都是整值底）。

**⑦ 它不是服务端 seq，也不是"唯一序号"（2026-10-04，多智能体复核，两条都硬）。**

- **不是服务端 seq**（三条独立证据互相印证）：
  - 42/42 个 `10000` 族房满足 `#3 < 该房自己 MIN(非零 server_seq)`，差值中位 **8.72×10^8**；
    45 个"最后成员变更落在本机保留窗口内"的房里，变更当时的 `server_seq` 已是 **8.7e8** 量级，
    而它们的 `#3` 仍是 `10000~11379` —— 差 5 个数量级；
  - **`server_seq` 的取值空间里根本没有这一段**：全库 **84,279 行**消息中，`server_seq ∈ [10^4, 8×10^8)`
    的 **0 行**（全库唯一的小非零 seq 在 1 张非群会话表里，值 75~663）；
  - 2024~2026 年"出生"的房仍停在 `10000+x`，而这个账号的服务端 seq **2021-11 就已是 8.41e8**。
- **不是唯一序号**：`#3` **精确等于 `10000` 的房有 7 个**（外加其它重号）——服务端分配的序号不会这样。
  ⇒ 与"**本地从常量 `10000` 起算、随本地事件递增的每房计数器**"一致。
- 与它一致、**没被证伪**的读法是"每房一个本地计数器"；被证伪的是"服务端每房唯一版本号"。
  两个还算不上的（底数 `10000` 是客户端常量还是服务端给的种子、`7×10^8` 到底谁发的）**都需要机外对照源**。

**⑧ 它数的是"成员表的历史变更"，不是人数、也不是当前规模（2026-10-04）。**

- **不是"曾经出现过的人数"（硬）**：`name2id` **无洞**（`rowid ∈ [1, 4025]`、`COUNT = 4025`），
  且 `chatroom_member.member_id == name2id.rowid`（**4146/4146 全命中**）⇒ 本机历史上**可区分的人 ≤ 4025**；
  可是 `chat_room.id = 332` 的 offset 是 **15304**（3.8 倍）⇒ 不可能是人数。
- **不是当前成员数的函数（硬）**：同族同规模能差 9 倍 —— `id = 3968`（28 人）offset **6** vs
  `id = 326`（24 人）offset **54**；比值 `offset/成员数` 在同一族里从 **0 连续变到 6.38**。
- **正面证据（最硬的一条）**：offset **= 0 的 7 个房**（`#3` 精确等于底数），在 `chatroom_member` 里
  **各自只有一段连续 rowid、段长正好等于成员数**，且保留窗口内**没有任何成员变动系统消息**
  （唯一一条是"邀请你和…加入了群聊"——那是建群/入群通知）、**也没有公告**
  ⇒ **offset=0 正好落在"成员表自建群起从未动过"的房上**。这就是"计数器初值 = 底数"的正面证据。
- **它还随"变动跨的时间窗"增长**：用 `chatroom_member.rowid`（成员表插入先后）算时间窗，
  `ρ(offset, spread) = 0.815 / 0.801`，**控制住成员数后仍有 +0.477 / +0.386**。
- ⚠️ **方法坑（记下来免得再踩）**：用 `name2id.rowid` 当"成员进群先后"是**错的代理** ——
  那是"此人进**我的联系人库**"的时刻（很多房最早的成员是很早的老联系人），控制规模后 partial ≈ **0**，
  会得出"只跟当前人数走"的错结论；**要改用 `chatroom_member.rowid`**。
- 顺带验掉一个隐患：`chatroom_member` 的行**确实会被删**（`rowid ∈ [1, 4603]`、`COUNT = 4146` ⇒ **457 个洞**；
  表不是 AUTOINCREMENT）⇒ 它的 rowid-max 只能当"历史人数"的**下界**，不能当等号。

**⑤ 它会变。** 同一天里 `chat_room.id = 299` 那个群的值从 `700002082` 变成 `700002084`（约 1 小时，
+2）；同一房间 9 秒内连读三次不变。⇒ 它是客户端在维护的状态，不是冻在库里的 id。

**⑥ 它仍然只在那个 blob 里。** 第 4 节那条"大值在全部 24 个库的每一列里命中 0"依然成立。

**没定的还是"名字"和"底数从哪来"。** 上面证的是**行为**（跟成员规模走、两种底数、会变、
`#3`/`#4` 是同一个量写两遍 —— 最后这条由 detail 的那对证出来）；**类型的名字**有了
（`micromsg.ChatroomExtData`，见 3.1），但**字段的名字**在客户端里**不以明文出现**（见 3.1）。

**`chatroom_seq` 那条候选已经降级**：破掉字符串混淆后（3.2）它确实存在，但两轮独立追查都指向
**账号级的"群列表游标"**（出现在 `init_contact_manager.cc` 的 InitContact 收尾日志里，
与 `,contact_seq=`、` total_count_=`、`respCount` 并列，**日志里没有任何房间标识**）；
全池里"同时含 room 与 seq"的串**只有这一条**，没有任何一处把某个群和一个 seq 一起打印。
⇒ **它与"每群一个"的实测对不上，不能当名字。**

**`InfoVersion` 那条候选也撤了**（2026-10-04）。客户端里确实有一组**明文**字段名
`Announcement / InfoVersion / AnnouncementEditor / AnnouncementPublishTime / ChatRoomStatus`，
其中 `AnnouncementPublishTime` 与我们**已独立验证**的 `chat_room_info_detail.ext_buffer_` 的 `#6` 吻合
（25 行里 23 行）——看上去"同结构里 `#3`/`#4` 就是 `InfoVersion`"。**这个推断被两条独立证据否掉**：

1. **名字顺序 ≠ 字段号**：把这 5 个名字读成字段号 1..5 的话，`AnnouncementPublishTime` 应落在 **`#4`**；
   而库里它实际在 **`#6`**（`#4` 是个小 varint，且恒等于 `#3`）。⇒ 这张表**不能**用来给任何字段号命名。
   （那片 `.rdata` 里旁边就是匈牙利命名的 `strUsrName / nOrder / nUnReadCount / parentRef / nStatus / …`，
   像是 **V3 时代/镜像 message** 的字段清单，不是我们这个 blob 的。）
2. **行为对不上**：detail 那个 `#3` 跟**成员侧**走（ρ **0.889** / 0.773），跟公告侧 **≤0.55**；
   **控制住成员数之后，公告侧的解释力塌到 ≈0**（偏相关 +0.204 / +0.282 / **−0.013**，成员侧仍 **+0.700**）。
   唯一能抓到"多一次变更"的天然对照——`#3 = #4 + 1` 的那 5 个房——**正好**是
   "blob 成员比关系表多 1 人"的那 5 个房，**且这 5 个房公告内容全为空**。
   另外有**双向反例**：`id = 2764`（325 人、两条公告，`#3` 只有 **9**）同时反掉"跟成员数"和"跟公告数"
   两种简单读法 ⇒ 它**不是当前状态的函数**，更像**事件累计计数**（`id = 329`：46 人、零公告、`#3 = 1897` 同理）。

要坐实字段名仍得换环境（另一台机器 / 另一个微信版本 / 同一房间的两个时点快照）。
所以它**继续留在 `unrecognized` 里只报字段号，不编名字**（见 D-068、D-069、D-070、D-071）。

**顺带**：成员列表的顺序不是按名字排的（"我"在 76 个群里位置从 0 到 378 都有），
而"我在列表第一个"的 17 个群里 **16 个属于 `10000` 那一族**（按房间大小折算，随机也该有 5.4 个）——
顺序像是"加入先后"，且底数与它相关。这条只是相关性，不够下结论，记在这儿备用。

### 6.2 想要"第二时点"，试过这几条，都不通

要坐实"`#3` 跟着成员变动走"，最缺的是**同一房间在两个时刻的快照**。本机能想到的免费来源都试了：

- **`contact.db-wal`（1,071,232 字节 = 260 帧，当日）里 `chat_room` 一行都没改**：
  把 WAL 截到第 0 帧和第 260 帧各读一次，**77 个群的 `#3` 和成员列表完全相同**。
  ⇒ 这个窗口拿不到增量（也说明 `chat_room` 是"改一次就静默很久"的行）。复跑方式见第 9 节。
- **`contact.db-{first,last,incremental}.material`（4~8KB，头 16 字节与本库同一个盐）不是页快照**：
  把它们贴进 contact.db 副本的**任一页号**（1366 个位置全试过），`chat_room` 的行数与 blob 长度
  都不变、也不报错 ⇒ 里面装的不是这张表的数据。靠它拿"一年前"的旧快照这条路不通。
- **其余库没有这种字段**：`contact_fts.db` 的 `db_info` 只有 FTS 自己的 schema 版本
  （`chatroom_member_fts_table_version = 3` 之类）；`general.db` 的 `sqlite_sequence` 里只有
  `revokebatchmessage`（顺带说明 `chat_room` 不是 AUTOINCREMENT 表）。

所以"第二时点"只能来自机外（另一台机器 / 另一个微信版本），或者等客户端自己再改一次并**当场逮住**。

**2026-10-04 把"本机有没有第二个实例"也扫了一遍（负结果，附一条真推断）：**

- **本机只有一个真库**，而且它是**两条路径的同一份**：数据盘上那个目录是**用户目录下 `xwechat_files` 的软链**
  （不是第二份数据）。`Backup\`、`msg\migrate\`、
  `business\migrate\`、`temp\`、`config\` 里没有副本或导出；本机只有一个用户目录、只有 C:/D: 两个盘。
  （顺带：仓库的 `find_nt_databases()` 是"取第一个存在的根就 break"、从不并集多根 ⇒ 软链**不会**造成重复计数。）
- 企业微信（WXWork）**有本人 profile 的库**（3 个 corp + 1 个同日备份），但头不是 SQLite、
  是**自定义加密**，且结构里**没有 `chat_room`/`ext_buffer`** ⇒ 帮不上（按红线未解库、未读内容）。
- 唯一的"第二份"是本次留的**活库工作副本**（相差 35 分钟）：**77 个群的 `#3`/`#4` 与成员条数全等**，
  而同一窗口里 `contact`（好友侧）动了 **13 行** ⇒ 一条真推断：**offset 不随普通好友侧更新走**
  （排除"它是通用活动计数器"）。⚠️ 但 35 分钟且窗口内无成员变更，所以"数值相同"**不构成**
  "服务端同步"的证据 —— 只是与"只跟成员走"相容。

## 7. `stranger.extra_buffer` 的形状目录（本机只有 1 行，只能给"有哪些字段"）

本机 `stranger` 表只有 **1 行**，所以给不出取值范围，只能列出**存在哪些字段**：

- varint（wt0）：`#2 #3 #8 #10 #11 #12 #13 #16 #17 #18 #19 #22 #23 #24 #37 #38`（这行里 `#13` 与 `#18` 取值为 1，其余 0）
- 可解析的嵌套消息（wt2）：`#4 #5 #6 #7 #14 #15`
- 非嵌套载荷（wt2）：`#9`（50 字节），以及 `#20 #21 #25 #26 #…` 等

名字在没有对照源的情况下拿不到 —— 这是**结构性**的，不是没解：本机 24 个库里，
这些字段的值都不出现在别处（见第 4 节的同款结论）。

## 8. 公开圈研究到哪一步了（2026-10-03 查）

这类东西最容易白费力气，所以把"别人做到哪"记下来：

| 项目 | 星 | 与本表的关系 |
| --- | --- | --- |
| [Wing900/chatlog-export](https://github.com/Wing900/chatlog-export) | 31 | **唯一的公开 schema**：`internal/model/wxproto/{roomdata,bytesextra,packedinfo}.proto`。成员段与实测一致，`roomCap` 那行对不上（见第 2 节） |
| [sjzar/chatlog](https://github.com/sjzar/chatlog) | 9.2k | 支持 V4，但**不解析 ext_buffer**（文件树里没有任何 proto） |
| [LC044/WeChatMsg](https://github.com/LC044/WeChatMsg) | 42k | V3 时代：没有 proto/V4/schema 文件，README 不提 4.x |
| xaoyaoo/PyWxDump（9.7k）、0xlane/wechat-dump-rs | — | **已被 DMCA 下架**（`Repository access blocked`），取不到了 |
| [Ray0612/WeChat-v4-export-research](https://github.com/Ray0612/WeChat-v4-export-research) | 13 | 记的是**消息**级字段：记录区（键值对）里 `chatroom_id` = 键 `0x76`、`chatroom_name` = `0x77`（中文 UTF-8）。**已测：与本文的 `#3` 无关**（见下） |

**陷阱一处**：中文资料里那条"`ChatRoom` 表有 `RoomData`(BLOB) 列"说的是**微信机器人框架自己的库**，
不是微信的 `contact.db`（我们的表是 `chat_room(id, username, owner, ext_buffer)`）。别照抄那张表。

**据此新做的一条证伪**（比第 4 节更进一步，因为它扫的是**消息内容**而不只是表列）：把 74 个群各自的
`#3` 拿到该群消息表 `Msg_<md5(username)>` 的每一行、每一个非数值列里，按**两种编码**找
（十进制文本 / varint）。结果：

- **大值（≥1e8）命中 0 / 0**（文本 0、varint 0）—— 大整数不会在忙 blob 里撞车，所以这是硬的；
- 小值（如 `2021`/`10001`/`10087`）有若干命中，但那是**字节撞车**（两三字节的序列在几 KB 的 blob 里
  到处都是），不构成证据。

⇒ 同行记下的 `chatroom_id`（消息记录区 `0x76`）**不是**本文这个 `#3`。

**2026-10-04 补一次定向搜索**：我们后来才从客户端读出这层本地 message 的**类型名**，于是拿这些**很有辨识度**的
字符串去搜公开代码（`gh search code`）：

| 搜什么 | 结果 |
| --- | --- |
| `ChatroomExtData`、`ChatroomMemberLocalData` | **只命中我们自己的仓库**（就是这份文档），别处 0 |
| `win_local_define`、`ClientChatroomMemberData` | **0 命中** |
| `ClientChatroomData` | 命中的全是 Pokémon Showdex（无关） |

⇒ **公开圈里没有这层本地 proto 的字段定义。** 结合 3.3 的结论（这一版客户端里也没有可读的字段名存放处），
`#3`/`#4` 的名字**在本机 + 公开渠道两头都拿不到** —— 要它只剩"换一个参照实例"
（另一台机器的库 / 另一个微信版本，理想是 V3 时代的，因为 V3 的 `RoomData` 才是它的直系祖先）。

## 9. 复现方法

1. 只读打开：`PRAGMA key = "x'<key_hex><库文件头 16 字节的 hex>'"`（同 `scripts/nt_decrypt.py` 里
   `connect_message_shards` / `get_fav_schema` 的写法）；
2. 取 `SELECT ext_buffer FROM chat_room WHERE length(ext_buffer) > 0`；
3. 手写走线器（不装 protobuf 库也能解，约 30 行）：

```python
def varint(buf, i):
    val, shift = 0, 0
    while True:
        b = buf[i]; i += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80): return val, i
        shift += 7

def walk(buf):                      # [(字段号, wire type, 值)]
    i, out = 0, []
    while i < len(buf):
        tag, i = varint(buf, i)
        fno, wt = tag >> 3, tag & 7
        if wt == 0:
            v, i = varint(buf, i); out.append((fno, wt, v))
        elif wt == 2:
            ln, i = varint(buf, i); out.append((fno, wt, buf[i:i+ln])); i += ln
        elif wt == 5:
            out.append((fno, wt, buf[i:i+4])); i += 4
        elif wt == 1:
            out.append((fno, wt, buf[i:i+8])); i += 8
        else:
            raise ValueError('wt %d' % wt)
    return out
```

字段号对不上时先怀疑**这一层不是 message**（`#5` 在 chat_room 里就是 `string` 而不是 `int32`），
别急着改数据。

**6.1 那几条怎么复跑**（都是只读，不需要联网）：

4. 两族与取值：对所有行取顶层 `#3`，按 `v < 10^4` / `10^4 ≤ v < 10^5` / `v ≥ 10^8` 分桶；
5. 秩相关：`offset`（`v` 减去该族的底数）= 自变量，成员数取 `#1` 的条数、消息数取
   `SELECT COUNT(*) FROM Msg_<md5(username)>`，用 Spearman（不假设线性）；
6. "差 1"那 5 个群：把 `chat_room.ext_buffer` 里每个成员子消息的 `#1`（userName）抽出来，
   与 `SELECT n.username FROM chatroom_member cm JOIN name2id n ON cm.member_id = n.rowid
   WHERE cm.room_id = ?` 求差集 —— 差集非空的行，再去 `chat_room_info_detail.ext_buffer_` 里
   看它的 `#3`/`#4` 是否差 1。（**注意：** 内层查询要用**另一个 cursor**，否则会把外层
   `for ... in cursor.execute(...)` 的迭代顶掉、只跑第一行 —— 我第一版就栽在这儿。）
7. "它会变"那条靠**同一行隔一段时间重读**（本次是 ~1 小时）。
8. 3.2 那层字符串混淆（与 DB 无关，纯离线）：
   - 抓记录：正则 `\xa1([0-9A-F]{4})\xb1([0-9A-F]{2,400})`，长度字段是**小端**
     （`int(h[2:4]+h[0:2], 16)`，直接 `int(h,16)` 会把它当 0x0D00=3328，然后一条都取不到）；
   - 定密钥：逐位搜索（每位 0..255 试一遍，取"解出的字节落在标识符字符集里比例最高"的那档），
     前 30 位就够出人话；**注意逐位搜索会在"两个候选都是字母"时选错**（本机栽在第 0 位：
     `kernel` 被解成 `rernel`）——用一眼能认出的 crib 修（`rernel::`→`kernel::` 定出该位差 `^0x19`），
     再按同样办法往后扩位。
9. **6.1 ⑧ 那几条怎么复跑**（都只读）：
   - "不是人数"：`name2id` 查 `MIN(rowid)/MAX(rowid)/COUNT(*)` 看有没有洞；再确认
     `chatroom_member.member_id == name2id.rowid` 的命中率；拿 `offset` 最大的房跟 `COUNT(*)` 比；
   - "offset=0 的房 = 成员表没动过"：对这些房取 `chatroom_member` 的 rowid，**按 rowid 排序后数连续段**
     （段数=1 且段长=成员数 ⇒ 一次性写入），再去消息库看该房有没有成员变动系统消息；
   - "随变动时间窗"：用 `chatroom_member.rowid` 的 `max−min` 当 spread，与 `offset` 做 Spearman，
     **并同时算"控制成员数后的偏相关"**（只报 raw 相关会被"人多→跨度天然大"混淆）。
10. **想要"第二时点"时的可复制做法**（本机没有，但方法通用）：把库与它的 `-wal` **拷到临时目录**，
    按帧边界（`32 + k × (24 + page_size)`）**截断 WAL 副本**再打开 ⇒ 每截一次就是稍早的一个状态；
    或定期留一份**只读工作副本**，之后与现库对比（本机就是这么拿到"35 分钟内 77 房 `#3` 全等"的）。
    ⚠️ 两条前提都记在 6.2：**先确认 WAL 里真的有目标表的帧**、**`.material` 不是页快照**。
