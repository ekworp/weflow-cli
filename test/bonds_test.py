# -*- coding: utf-8 -*-
"""`bonds.py` 的判据。全是纯函数，不查库、不联网。

这一支的价值全在**判据能不能站住**：
  · "谁算人"错了 → 榜上出现服务号（真发生过：星巴克小助手排第一），或者**真人被静默砍掉**；
  · "冷却/变热"的阈值错了 → 名单要么空、要么全是噪声。

なので这里按**两个方向**钉：该进的进、该出的出，并且把"为什么不用 flag"这件事也钉住 ——
那是实测出来的（38 人里有 3 个 `flag != 3`，其中两个是真人）。
"""
import importlib.util
import os
import sys
import tempfile
import unittest

SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts')
sys.path.insert(0, SCRIPTS)


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(SCRIPTS, name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bd = load('bonds')


def texts(n, start, step, mine_ratio=0.5, is_send_cycle=2):
    """造 n 条文本消息：从 start 开始、每 step 秒一条。"""
    out = []
    for i in range(n):
        out.append({'localType': 1, 'createTime': start + i * step,
                    'isSend': (i % is_send_cycle == 0), 'parsedContent': '在的'})
    return out


class HumanFilterTests(unittest.TestCase):
    """"这条会话通往一个人吗"。判据是 **id 的形状**。"""

    def test_带圈的一律不是人(self):
        for username, why in (('123@chatroom', '群'), ('25984985788720569@openim', '服务号'),
                              ('wxid_x@weclaw', '机器人')):
            self.assertFalse(bd.is_human(username, 1, ''), why)

    def test_文件传输助手与公众号也不是(self):
        self.assertFalse(bd.is_human('filehelper', 1, ''))
        self.assertFalse(bd.is_human('gh_abcdef', 1, ''))

    def test_真人放行_包括有自定义微信号的(self):
        # 实测：真人是 `wxid_*`，也常有自定义微信号（`alias` 非空）—— 后者是关系的硬信号
        self.assertTrue(bd.is_human('wxid_irdqh3429ls422', 1, 'Devin_Long'))
        self.assertTrue(bd.is_human('pvh0susz5622', 0, ''), '不在联系人库里也该放行')

    def test_不用_flag_当判据(self):
        """**这条是拿真数据换来的。** 38 个人里 `flag` 分布是 {3: 35, 2563: 1, 2051: 1, 2049: 1}，
        多出来的那三个里只有 `微信ClawBot`(2049) 是机器人，`彪弟`(2051)、`平凡的世界`(2563) 是**真人** ——
        多出来的位来自"当初怎么加上的"。拿 `flag == 3` 当判据会一刀砍掉两个朋友，且砍得无声无息。
        所以这里钉住：**判断只看 id 形状**，不看 flag。
        """
        source = open(os.path.join(SCRIPTS, 'bonds.py'), encoding='utf-8').read()
        body = source[source.index('def is_human'):source.index('def load_skip')]
        # 只看**代码**，不看文档字符串 —— 那里正好写着"为什么不用 flag"（第一版这条断言
        # 就是把文档也算进去，于是自己把自己判红）
        code = body[body.index('"""', body.index('"""') + 3) + 3:]
        self.assertNotIn('flag', code)
        self.assertIn("'@' in username", code)

    def test_名字像服务号的只标不排(self):
        self.assertTrue(bd.looks_like_service('普华口腔门诊部'))
        self.assertTrue(bd.looks_like_service('中行小助手'))
        self.assertFalse(bd.looks_like_service('龙老师'))
        self.assertFalse(bd.looks_like_service('刘娟'))


class ShapeTests(unittest.TestCase):
    NOW = 1_800_000_000        # 固定"现在"，免得测试随日子变

    def test_形状算得出条数活跃天与静默天数(self):
        day = 86400
        msgs = texts(60, self.NOW - 30 * day, day // 2)     # 30 天里 60 条
        shape = bd.shape_of(msgs, self.NOW)
        self.assertEqual(shape['messages'], 60)
        self.assertGreaterEqual(shape['activeDays'], 1)
        self.assertLessEqual(shape['silentDays'], 0.5 + 1e-6)  # 最后一条就是"现在"

    def test_冷却判据_历史厚加静默久(self):
        day = 86400
        old = texts(200, self.NOW - 300 * day, day)          # 300 天前，200 条
        self.assertIn('cooling', bd.classify(bd.shape_of(old, self.NOW), True))
        # 反向：条数不够厚的（只有几十条）不算"冷却" —— 那只是没怎么聊过
        thin = texts(30, self.NOW - 300 * day, day)
        self.assertNotIn('cooling', bd.classify(bd.shape_of(thin, self.NOW), True))

    def test_变热判据_近七天明显高于平时日均(self):
        day = 86400
        # "变热"要有**平时**可比：先 300 天里 200 条（日均 ~0.67），再来近 7 天 35 条
        base = texts(200, self.NOW - 300 * day, day)
        burst = texts(35, self.NOW - 6 * day, day // 8)
        self.assertIn('heating', bd.classify(bd.shape_of(base + burst, self.NOW), True))
        # 反向：**匀速**长期联系不算变热。夹具要卡在"近 7 天够多、但没超过平时日均的 2 倍"——
        # 第一版写的是"700 天里 35 条"，那种近 7 天一条都没有，是被 `recent7 >= 10` 挡住的，
        # 倍数阈值压根没被考到（变异没变红才发现的）。
        steady = texts(600, self.NOW - 300 * day, day // 2)   # 日均 2 条，近 7 天 14 条
        shape = bd.shape_of(steady, self.NOW)
        self.assertGreaterEqual(shape['recent7'], 10, '夹具要过 recent7 那道闸')
        self.assertNotIn('heating', bd.classify(shape, True))

    def test_只有微信这一条线_按对话里出没出现过别的渠道(self):
        day = 86400
        msgs = texts(60, self.NOW - 30 * day, day // 2)
        self.assertIn('only-wechat', bd.classify(bd.shape_of(msgs, self.NOW), other_channel=False))
        self.assertNotIn('only-wechat', bd.classify(bd.shape_of(msgs, self.NOW), other_channel=True))


class SkipListTests(unittest.TestCase):
    def test_名单一行一个_井号是注释(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'skip.txt')
            with open(path, 'w', encoding='utf-8') as handle:
                handle.write('# 这是注释\n普华口腔门诊部\n\nwxid_abc\n')
            names = bd.load_skip(path)
        self.assertEqual(names, {'普华口腔门诊部', 'wxid_abc'})

    def test_命令行给的也认(self):
        names = bd.load_skip(os.path.join('__not_exist__', 'nope.txt'), extra=['某某店'])
        self.assertEqual(names, {'某某店'})

    def test_文件不存在不炸(self):
        self.assertEqual(bd.load_skip(os.path.join('__not_exist__', 'nope.txt')), set())


if __name__ == '__main__':
    unittest.main()
