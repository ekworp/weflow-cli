#!/usr/bin/env python3
"""关系温度 — 谁在冷却、谁在变热、以及"只有微信这一条线"的人。

不是在排"我最常跟谁聊"（那个排行榜没有信息量），而是看**形状**：
  · 历史很厚但正在静默 —— 一年里聊了几百条，最近几个月一句话没有；
  · 最近突然变热 —— 近 7 天的量是平时日均的几倍；
  · 只有微信这一条线 —— 整段对话里从没出现过电话/邮箱/约见面。

## 为什么"不可替代"要用两条硬判据，而不是感觉

第一版我拿"对话里没出现过其它联系方式"当不可替代的判据，结果前几名全是
**星巴克小助手、天天神券福利君、串掌门（南村店）、文件传输助手** —— 服务号。
原因很直白：机器人**必然**满足这个判据，它没有别的渠道可提。方向正好反了。

所以现在先按联系人库里的**硬标记**把非人剔除：
  · `username` 以 `@openim` 结尾（企业微信/服务号那类）；
  · `username == 'filehelper'`；
  · `username` 以 `gh_` 开头（公众号）；
  · `local_type != 1`（不是好友）。
真人都是 `wxid_*`；另外**互换过微信号**（`alias` 非空）本身就是关系的硬信号。

## 边界

只读本地库，不联网、不调用模型、不发送任何东西，也不生成"该说什么"——
后者是 `draft_reply` 的活儿。它给的是**一份可以每周扫一眼的名单**。

口径与 `chat_lines`/`chat_notes` 一致：只算**文本**消息（`localType == 1`），
因为图片/表情/转账的条数比的是习惯，不是关系。
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import nt_decrypt                                   # noqa: E402
import sqlcipher3.dbapi2 as sqlcipher               # noqa: E402
from _utils import load_config, decrypt_lock        # noqa: E402
from reply_debt import collect_conversations        # noqa: E402
from chat_notes import fetch_all_messages           # noqa: E402

TZ = timezone(timedelta(hours=8))
TYPE_TEXT = 1
DEFAULT_DAYS = 365
DEFAULT_LIMIT = 400
# 少于这么多条文本的会话不进榜：两三句话说明不了关系，只会带来噪声
MIN_MESSAGES = 20
# 静默多久算"冷却"。按"会不会让你意外"定，不是按统计：一个月没说话在多数关系里正常，
# 三个月就值得看一眼了。
COOL_DAYS = 60
# 近 7 天比平时日均快这么多倍才算"变热"
HOT_RATIO = 2.0
# 真人常用的一批词，用来判"还有没有别的通道"
OTHER_CHANNEL = ('打电话', '手机号', '电话号', '邮箱', '邮件', '短信', '见个面',
                 '见面', '约个饭', '聚餐', '发你邮箱')

# 名字里带这些的，**只标出来、不自动排除**。
#
# 为什么只标不排：实测有个「普华口腔门诊部」的 id 是 `wxid_示例号`、`local_type=1`、
# 还有自定义微信号 —— 它**和真人长得一模一样**，结构上没有任何标记能区分（`@openim` 那种是另一类）。
# 所以"谁算人"这一手，工具摆出可疑的、由人决定；名单在 `output/bonds-skip.txt` 或 `--skip` 里。
SERVICE_NAME_HINTS = ('门诊', '口腔', '医院', '客服', '小助手', '福利', '旗舰店', '专营店',
                      '专卖店', '营业厅', '有限公司', '学社', '助理', 'Bot', 'bot')
# 自定名单的默认位置（一行一个名字或 id，`#` 开头是注释）
SKIP_FILE = os.path.join('output', 'bonds-skip.txt')


def is_human(username, local_type, alias):
    """这条会话通往一个**人**吗。

    判据是 **id 的形状**，不是备注名，也不是 `flag`：

    - 带 `@` 的一律不是人：`@chatroom` 是群、`@openim` 是服务号、`@weclaw` 是机器人
      （实测 `微信ClawBot` 就是这个后缀 —— 只挡 `@openim` 会漏它）；
    - `filehelper`（文件传输助手）与 `gh_*`（公众号）也都不是。

    为什么**不用 `flag`**：它看着更硬（真朋友大多 `flag=3`），但实测 38 个人里有三个不是 3 ——
    `微信ClawBot`(2049, 机器人)、`彪弟`(2051)、`平凡的世界`(2563)。后两个是**真人**，
    多出来的位来自"当初怎么加上的"。拿 `flag == 3` 当判据会一刀砍掉两个朋友，
    而且砍得无声无息。
    """
    if not username:
        return False
    if '@' in username or username == 'filehelper' or username.startswith('gh_'):
        return False
    # 不在联系人库里的（0）放行：那是"读不到那一侧"，不是"不是人"。
    return local_type in (0, 1)


def load_contact_meta(db):
    """`username -> (local_type, alias)`。读不了一律返回空表（调用方据此少判一手）。"""
    path = nt_decrypt.find_contact_db_path(db)
    if not path:
        return {}
    try:
        conn = sqlcipher.connect(path)
        cursor = conn.cursor()
        cursor.execute('PRAGMA key = "x' + chr(39) + decrypt_lock(load_config().get('contactKey', ''))
                       + load_config().get('contactSalt', '') + chr(39) + '";')
        meta = {u: (lt, al or '') for u, lt, al in
                cursor.execute('SELECT username, local_type, alias FROM contact').fetchall()}
        conn.close()
        return meta
    except Exception as error:
        print('联系人库读不了（%s）：只能用会话列表判断' % str(error)[:60], file=sys.stderr)
        return {}


def load_skip(path=None, extra=()):
    """自定名单：一行一个名字或 id，`#` 开头是注释。读不了就当空表（少排除比多排除安全）。"""
    names = {str(x).strip() for x in extra if str(x).strip()}
    target = path or SKIP_FILE
    try:
        with open(target, encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if line and not line.startswith('#'):
                    names.add(line)
    except OSError:
        pass
    return names


def looks_like_service(name):
    """名字像不像服务号/门店。**只是标记**，排不排由人定（见 SERVICE_NAME_HINTS）。"""
    return any(hint in (name or '') for hint in SERVICE_NAME_HINTS)


def shape_of(messages, now):
    """一段对话的形状。`messages` 只含文本消息。"""
    stamps = sorted(m.get('createTime') or 0 for m in messages)
    days = {datetime.fromtimestamp(t, TZ).date() for t in stamps}
    last = max(stamps) if stamps else 0
    silent_days = (now - last) / 86400 if last else 0
    span_days = max(1, ((last - min(stamps)) / 86400)) if len(stamps) > 1 else 1
    per_day = len(stamps) / span_days                    # 平时日均
    recent = sum(1 for t in stamps if (now - t) / 86400 <= 7)
    return {
        'messages': len(stamps),
        'activeDays': len(days),
        'silentDays': round(silent_days, 1),
        'perDay': round(per_day, 2),
        'recent7': recent,
        'mine': round(100.0 * sum(1 for m in messages if m.get('isSend')) / max(1, len(stamps))),
        'last': datetime.fromtimestamp(last, TZ).strftime('%Y-%m-%d') if last else '',
    }


def classify(shape, other_channel):
    """这条关系现在是什么状态。四条判据都是**可复现**的阈值，不靠感觉。"""
    tags = []
    if shape['silentDays'] >= COOL_DAYS and shape['messages'] >= MIN_MESSAGES * 5:
        tags.append('cooling')          # 历史厚 + 静默久
    if shape['recent7'] >= 10 and shape['perDay'] > 0 and shape['recent7'] / 7 >= shape['perDay'] * HOT_RATIO:
        tags.append('heating')
    if not other_channel:
        tags.append('only-wechat')      # 整段历史里没出现过别的渠道
    if 0 < shape['silentDays'] <= 7:
        tags.append('active')
    return tags


def collect(days=DEFAULT_DAYS, limit=DEFAULT_LIMIT, skip=()):
    """算一份名单。**不联网、不调模型、不写文件。**"""
    config = load_config()
    db = config.get('ntDbPath', '')
    if not db:
        return None, 'no-db'
    conns = nt_decrypt.connect_message_shards(
        db, decrypt_lock(config.get('ntKey', '')), config.get('ntSalt', ''),
        decrypt_lock(config.get('favPassphrase') or config.get('decryptKey') or ''))
    if not conns:
        return None, 'no-conn'
    try:
        name_map = {}
        contact_db = nt_decrypt.find_contact_db_path(db)
        if contact_db:
            name_map = nt_decrypt.load_contact_names(
                contact_db, decrypt_lock(config.get('contactKey', '')),
                config.get('contactSalt', ''))
        meta = load_contact_meta(db)
        own = config.get('wxid', '')
        now = int(datetime.now(TZ).timestamp())
        people = []
        dropped = []                # 排除了谁、为什么 —— 绝不静默少几个人
        for item in collect_conversations(conns, name_map, own, days, limit):
            talker = item['talker']
            name = item.get('name') or talker
            if talker.endswith('@chatroom'):
                continue                       # 群不是"通往某个人"的通道
            local_type, alias = meta.get(talker, (1 if not meta else 0, ''))
            if not is_human(talker, local_type, alias):
                dropped.append({'name': name, 'why': 'id 形状不是人'})
                continue
            if talker in skip or name in skip:
                dropped.append({'name': name, 'why': '在自定名单里'})
                continue
            all_messages, _ = fetch_all_messages(conns, talker, name_map, own)
            messages = [m for m in all_messages if m.get('localType') == TYPE_TEXT]
            if len(messages) < MIN_MESSAGES:
                dropped.append({'name': name, 'why': '文本不足 %d 条' % MIN_MESSAGES})
                continue
            other = any(any(word in (m.get('parsedContent') or '') for word in OTHER_CHANNEL)
                        for m in messages)
            shape = shape_of(messages, now)
            tags = classify(shape, other)
            if looks_like_service(name):
                # **只标不排**：这种账号与真人在结构上无法区分（见 SERVICE_NAME_HINTS）
                tags.append('suspect-service')
            people.append({
                'name': name,
                'talker': talker,
                'swappedIds': bool(alias),
                'otherChannel': other,
                'tags': tags,
                **shape,
            })
        return {'people': people, 'days': days, 'dropped': dropped}, None
    finally:
        for conn in conns:
            conn.close()


def budget(people, limit=12):
    """把名单切成报告要的那几组。`cooling` 按"会失去多少"排（条数 × 静默天数）。"""
    cooling = [p for p in people if 'cooling' in p['tags']]
    cooling.sort(key=lambda p: -(p['messages'] * p['silentDays']))
    heating = [p for p in people if 'heating' in p['tags']]
    heating.sort(key=lambda p: -p['recent7'])
    only = [p for p in people if 'only-wechat' in p['tags']]
    only.sort(key=lambda p: -p['activeDays'])
    return {
        'cooling': cooling[:limit],
        'heating': heating[:limit],
        'onlyWechat': only[:limit],
        'counts': {'people': len(people), 'cooling': len(cooling),
                   'heating': len(heating), 'onlyWechat': len(only)},
    }


def render(payload, limit=12):
    view = budget(payload['people'], limit)
    lines = []
    counts = view['counts']
    lines.append('看过的单聊（≥%d 条文本，最近 %d 天）: %d 人；其中只有微信这一条线的: %d 人'
                 % (MIN_MESSAGES, payload['days'], counts['people'], counts['onlyWechat']))
    if view['cooling']:
        lines.append('')
        lines.append('冷却中（历史厚、静默 ≥%d 天；按"条数 × 静默天数"排）:' % COOL_DAYS)
        for p in view['cooling']:
            lines.append('  %-16s %5d 条 / %3d 个活跃天 / 已静默 %6.0f 天（最后一次 %s）%s'
                         % (p['name'][:16], p['messages'], p['activeDays'], p['silentDays'], p['last'],
                            '  ⚠只有微信这一条线' if 'only-wechat' in p['tags'] else ''))
    if view['heating']:
        lines.append('')
        lines.append('最近变热（近 7 天 ≥ 平时日均的 %.1f 倍）:' % HOT_RATIO)
        for p in view['heating']:
            lines.append('  %-16s 近 7 天 %3d 条（平时日均 %.2f）/ 共 %d 条' % (p['name'][:16], p['recent7'],
                                                                              p['perDay'], p['messages']))
    if view['onlyWechat']:
        lines.append('')
        lines.append('只有微信这一条线（历史里从没出现过电话/邮箱/约见面；按活跃天数排）:')
        for p in view['onlyWechat']:
            lines.append('  %-16s 活跃 %3d 天 / %5d 条 / 最近 %6.0f 天前'
                         % (p['name'][:16], p['activeDays'], p['messages'], p['silentDays']))
    suspects = [p for p in payload['people'] if 'suspect-service' in p['tags']]
    if suspects:
        lines.append('')
        lines.append('名字像服务号/门店（**工具不替你决定**；要排除就写进 %s 或加 --skip）:' % SKIP_FILE)
        for p in suspects[:limit]:
            lines.append('  %-16s %5d 条 / 最近 %6.0f 天前'
                         % (p['name'][:16], p['messages'], p['silentDays']))
    dropped = payload.get('dropped') or []
    if dropped:
        lines.append('')
        reasons = {}
        for item in dropped:
            reasons.setdefault(item['why'], []).append(item['name'])
        for why, names in sorted(reasons.items(), key=lambda kv: -len(kv[1])):
            shown = '、'.join(names[:6]) + ('…' if len(names) > 6 else '')
            lines.append('已排除（%s）共 %d 个：%s' % (why, len(names), shown))
    if not (view['cooling'] or view['heating']):
        lines.append('（没有正在冷却或变热的关系）')
    return '\n'.join(lines)


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(
        description='关系温度：谁在冷却、谁在变热、谁只有微信这一条线（只读、不联网、不调模型）')
    parser.add_argument('--days', type=int, default=DEFAULT_DAYS, help='看最近多少天（默认 %d）' % DEFAULT_DAYS)
    parser.add_argument('--limit', type=int, default=DEFAULT_LIMIT,
                        help='最多扫几个会话（默认 %d）' % DEFAULT_LIMIT)
    parser.add_argument('--top', type=int, default=12, help='每组列几条（默认 12）')
    parser.add_argument('--skip', action='append', default=[], metavar='NAME',
                        help='把某个名字或 id 排除掉（可重复）；' + SKIP_FILE + ' 里也能写，一行一个')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    if args.days < 1:
        print(json.dumps({'success': False, 'error': '--days 要 ≥ 1'}) if args.json else '--days 要 ≥ 1')
        return 1

    payload, failure = collect(args.days, args.limit, skip=load_skip(extra=args.skip))
    if payload is None:
        message = {'no-db': '配置里没有 ntDbPath，先运行 weflow-cli init',
                   'no-conn': '无法打开消息数据库，请检查密钥（weflow-cli check）'}.get(failure, failure)
        print(json.dumps({'success': False, 'error': message}, ensure_ascii=False) if args.json else message)
        return 1

    view = budget(payload['people'], args.top)
    if args.json:
        print(json.dumps({'success': True, 'action': 'bonds', 'days': payload['days'],
                          'counts': view['counts'],
                          'cooling': view['cooling'], 'heating': view['heating'],
                          'onlyWechat': view['onlyWechat'],
                          'suspectService': [p for p in payload['people']
                                             if 'suspect-service' in p['tags']],
                          'dropped': payload.get('dropped') or [],
                          'readsLocalData': True, 'invokesAI': False, 'writesFiles': False,
                          'note': '只读本地库；不发送、不生成话术'},
                         ensure_ascii=False, indent=2))
    else:
        print(render(payload, args.top))
    return 0


if __name__ == '__main__':
    sys.exit(main())
