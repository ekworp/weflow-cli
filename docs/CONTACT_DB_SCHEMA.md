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

## 2. `chat_room.ext_buffer` = protobuf（已验）

顶层：`#1`（长度分隔，重复）× N，加 `#3`/`#4`（varint，**两者恒相等**）、有时 `#5`/`#6`。

```
RoomData {
  repeated RoomDataUser users = 1;   // ✅ 成员列表
  // 下面是实测到的、上游定义里没有的：
  //  3 = varint, 4 = varint（每个群 #3 == #4，值如 700002082 / 10054 / 2021）
  //  5 = 长度分隔，重复（实测是 wxid_… / xxx@openim 这类**附加参与者 id**）
  //  6 = varint（少见）
}
RoomDataUser {
  string userName    = 1;  // ✅
  string displayName = 2;  // ✅ 本机 85.2% 的成员有值，其余缺省
  int32  status      = 3;  // ⚠️ **不是 0-9**，是位标志：实测 0/1/9/17/25/2057/2073/
                           //    8193/2097153/3145729/6291457/7340049
  string inviter     = 4;  // ✅ 邀请人
}
```

**验过的对照**：`#1` 的条数与 `chatroom_member` 里该群的行数**逐群相等**（30 个群里 29 个相等，
`chat_room.id=331` 差 1：blob 31 / 表 30 —— 以 blob 还是表为准**没定论**）。

**与上游定义的差异**（[Wing900/chatlog-export](https://github.com/Wing900/chatlog-export) 的
`internal/model/wxproto/roomdata.proto`，声称 v3/v4 通用）：成员那一段**完全对得上** ✅；
但它写的 `optional int32 roomCap = 5` ❌（实测 `#5` 是长度分隔的字符串列表）；
顶层的 `#3`/`#4`/`#6` 它也没有 ❌。它的注释"syntax v3 & v4 通用，可能会有部分字段差异"
——差异比注释里说的大。

## 3. 其余几处 protobuf（形状已验，语义多半未定）

| 列 | 形状 | 状态 |
| --- | --- | --- |
| `chat_room_info_detail.ext_buffer_` | `#1(wt2)` + `#3`/`#4`(varint) + 有时 `#6` | ❓ **另一套**：`#3` 与该群 `chat_room.ext_buffer` 的 `#3` **不相等**（15/15 不等），`#1` 多数为空、少数是一大块二进制 |
| `contact.extra_buffer` | `#3`(varint)，2 字节上下 | ❌ **追到边界了**：4014 行里 **3072 行根本没有这个字段**（77%，列是空的）；有值的只有 0(520)/3(418)/9(2)/1(1)/515(1)。与同行 21 列**没有一列一一对应** —— `local_type`/`flag`/`verify_flag`/`is_in_chat_room`/`chat_room_type` 逐张列联表都试过（`verify_flag` 的 0/8/24 三种取值下 `#3` 都同时有 0 和 3）。唯一稳定的关系是**存在性**：`local_type = 3` 的 3028 行全部为空，有值的基本只在别的类型上 —— 存在性与类型相关，**取值本身无从判定** |
| `stranger.extra_buffer` | 38 个顶层字段（`#2`…`#38`，varint 与 length-delimited 混排，含嵌套） | ❓ 形状清楚，字段含义**一个都没定** |
| `openim_appid.ext_buffer` / `openim_acct_type.ext_buffer` | 各约 200~340 字节，顶层 3~4 个字段、含嵌套 | ❓ 与上面几套**都不一样** |

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
大整数不可能与别处的 id 撞车，所以结论是硬的：

> `#3` 只存在于 `chat_room.ext_buffer` 这个 blob 里；本机可见的任何表都不存它。

**能说到的程度**：它是一个**每群固定**的、只出现在该 blob 里的标识；`#4` 与它恒等（同一值被写两遍，
这在"某个 id 被两处代码各写一次"时很常见）。是不是服务端群号，本机数据**判定不了** ——
那需要另一台机器 / 另一个微信版本 / V3 的库来对照。**别再照着猜往下写代码。**

（`contact.extra_buffer` 的 `#3` 是同一种形状：取值在同行各列里找不到对应物。两张表的结论一样 ——
**这些 blob 字段不与本地 schema 镜像**，它们是厂商自己状态机里的位/标识，本地不存第二份。
所以"能不能解出来"这件事，卡点不在解码，而在**没有对照源**。）
（第一版扫描曾报"22 个库打不开"，那是**我自己传错了钥匙**：把配置里的原始 key 当成了派生后的
hexKey。修对之后 24/24 全能打开 —— 这类"打不开"要先怀疑自己。）

## 5. 实用替代（不用解 blob 也能拿到大部分东西）

只要成员与显示名：`chatroom_member`（`room_id` → `member_id`）join `name2id` / `contact` 即可，
本地就能做。**blob 多出来的是**：每个人的 `status`（位标志）、`inviter`，以及 `#5` 那串
附加参与者 id —— 这三样库里的表**没有**。

本仓库现在**只解已验证的那部分**：`weflow-cli contact-schema`（脚本 `scripts/contact_schema.py`，只读本地）
输出每个群的成员（`userName` / `displayName` / `status` / `inviter`）与 `#5` 的附加参与者 id，
以及该群里**未识别**的字段号。

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

**这解释了为什么它们找不到对应列**：位标志是**集合**，不会与任何单一列镜像 ——
所以"跟每列做列联表"这种找法注定失败，不是我没找到。

## 7. `stranger.extra_buffer` 的形状目录（本机只有 1 行，只能给"有哪些字段"）

本机 `stranger` 表只有 **1 行**，所以给不出取值范围，只能列出**存在哪些字段**：

- varint（wt0）：`#2 #3 #8 #10 #11 #12 #13 #16 #17 #18 #19 #22 #23 #24 #37 #38`（这行里 `#13` 与 `#18` 取值为 1，其余 0）
- 可解析的嵌套消息（wt2）：`#4 #5 #6 #7 #14 #15`
- 非嵌套载荷（wt2）：`#9`（50 字节），以及 `#20 #21 #25 #26 #…` 等

名字在没有对照源的情况下拿不到 —— 这是**结构性**的，不是没解：本机 24 个库里，
这些字段的值都不出现在别处（见第 4 节的同款结论）。

## 8. 复现方法

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
