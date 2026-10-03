# -*- coding: utf-8 -*-
"""布局缓存 key 必须覆盖**一切影响输出的东西**。

2026-10-03 踩的坑：改了两张 2D 图的力参数，重跑却打印"图没变，沿用已有布局" —— 因为 key 只哈希了
数据。于是页面上一点变化都没有，**而没有任何东西会报错**：静默给出旧结果。所以这里把每一项都钉一遍。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
import graph_3d as g  # noqa: E402


class LayoutKeyTest(unittest.TestCase):
    def test_same_inputs_same_key(self):
        self.assertEqual(g.layout_key('{"nodes":[]}', 2, 250), g.layout_key('{"nodes":[]}', 2, 250))

    def test_data_changes_the_key(self):
        self.assertNotEqual(g.layout_key('A', 2, 250), g.layout_key('B', 2, 250))

    def test_dims_change_the_key(self):
        # 2D 与 3D 是两张不同的图，坐标不通用
        self.assertNotEqual(g.layout_key('A', 2, 250), g.layout_key('A', 3, 250))

    def test_ticks_change_the_key(self):
        self.assertNotEqual(g.layout_key('A', 2, 250), g.layout_key('A', 2, 500))

    def test_force_params_change_the_key(self):
        """换一组力参数，key 必须变 —— 这就是 2026-10-03 那个 bug。"""
        before = g.layout_key('A', 2, 250)
        saved = dict(g.LAYOUT_PARAMS['2'])
        try:
            g.LAYOUT_PARAMS['2'] = dict(saved, charge=saved['charge'] * 3)
            after = g.layout_key('A', 2, 250)
        finally:
            g.LAYOUT_PARAMS['2'] = saved
        self.assertNotEqual(before, after)

    def test_two_dims_do_not_share_params(self):
        # 2D 沿用 3D 的斥力会把 5 万个点压成一坨没有结构的"饼"（实测），所以两组参数必须不同
        self.assertNotEqual(g.LAYOUT_PARAMS['2'], g.LAYOUT_PARAMS['3'])


if __name__ == '__main__':
    unittest.main()
