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
| `contact.extra_buffer` | `#3`(varint)，2 字节上下 | ❓ 取值几乎全是 0（306/400），少数 3（62）、1、515；与 `chat_room_type` **无相关性** |
| `stranger.extra_buffer` | 38 个顶层字段（`#2`…`#38`，varint 与 length-delimited 混排，含嵌套） | ❓ 形状清楚，字段含义**一个都没定** |
| `openim_appid.ext_buffer` / `openim_acct_type.ext_buffer` | 各约 200~340 字节，顶层 3~4 个字段、含嵌套 | ❓ 与上面几套**都不一样** |

## 4. 明确证伪的猜测（省得后人再试一遍）

对 `chat_room.ext_buffer` 顶层那个 `#3`（每个群一个数、与 `#4` 相等）：

- ❌ 不是 `max(chatroom_member.member_id)`、也不是 min —— 20 个群 0 命中；
- ❌ 不是 `chat_room.id`；
- ❌ 不是消息库（`message_*.db`）里任何 id 列的值 —— 37 个群 0 命中；
- ❓ 剩下最像的解释是"V4 新 id 空间里的某个会话标识"，但**本机数据不足以判定**，
  别再照着猜往下写代码。

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

## 6. 复现方法

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
