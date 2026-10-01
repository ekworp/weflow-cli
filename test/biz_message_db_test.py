# -*- coding: utf-8 -*-
"""订阅号（公众号）消息库的钥匙只能有**一处**派生。

为什么值得写：这把钥匙原来有**三份**实现 —— `biz_daily` 那份用全库 passphrase 派生（本机可用），
`chat_stats` 与 `mcp_bridge` 那两份只认配置里的 `bizKey`/`bizSalt`，而那两个键在本机**根本不存在**，
所以那两条路必然报「缺少 biz_message_0.db 密钥」；更糟的是照它们的提示去 `config set bizKey`
还会撞上「该键不在 CLI 可写白名单里」——越修越远。

2026-10-01 统一到 `_utils.biz_message_db()`。这条测试盯的是**别再长出第二处**：
它检查的是"还有没有别的脚本自己读 bizKey"，所以**以后新增的脚本也管得住**，
而不是把当前三个文件名写死。
"""
import os
import unittest

SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts')


def read(name):
    with open(os.path.join(SCRIPTS, name), encoding='utf-8') as fh:
        return fh.read()


class BizMessageKeyTest(unittest.TestCase):

    def test_只有_utils_里那一处读_bizKey(self):
        offenders = []
        for name in sorted(os.listdir(SCRIPTS)):
            if not name.endswith('.py') or name == '_utils.py':
                continue
            src = read(name)
            if "config.get('bizKey'" in src or 'config.get("bizKey"' in src:
                offenders.append(name)
        self.assertEqual(
            offenders, [],
            '这些脚本又自己读 bizKey 了 —— 钥匙派生只该在 _utils.biz_message_db() 里: %s' % offenders)

    def test_两个调用点用的是共享函数(self):
        for name in ('chat_stats.py', 'mcp_bridge.py'):
            self.assertIn('biz_message_db(', read(name),
                          '%s 应当调 _utils.biz_message_db()' % name)

    def test_共享函数确实在_utils里(self):
        self.assertIn('def biz_message_db(', read('_utils.py'))


if __name__ == '__main__':
    unittest.main()
