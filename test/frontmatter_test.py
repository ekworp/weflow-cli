"""`_utils.write_with_frontmatter` / `parse_frontmatter` 的往返。

为什么值得单独有一份：这两个函数是**16 个脚本共用的**，而在此之前没有一条测试盯着它们。
它们的失效方式是**静默改字** —— 写出去的值读回来少一个字符、或者多两个，不报错，
下游只是"这个名字对不上""那条链接连不起来"。2026-10-01 就是这么发现的：一张概念页的
别名 `AI 长出"手脚"` 读回来变成 `AI 长出"手脚`，于是卡片里那条链接永远不算入链。

**往返**是这里唯一站得住的判据：不比对字符串形状（形状由它们自己说了算），而是
"写下去再读回来，必须一模一样"。
"""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))

spec = importlib.util.spec_from_file_location('_utils', SCRIPTS / '_utils.py')
utils = importlib.util.module_from_spec(spec)
spec.loader.exec_module(utils)


def roundtrip(frontmatter, tmp):
    path = str(Path(tmp) / 't.md')
    utils.write_with_frontmatter(path, dict(frontmatter), '正文')
    fm, body = utils.parse_frontmatter(Path(path).read_text(encoding='utf-8'))
    return fm, body


class RoundTripTests(unittest.TestCase):
    def test_标量值原样回来(self):
        with tempfile.TemporaryDirectory() as tmp:
            for value in ('普通标题', '带:冒号', '带#井号', 'AI 长出"手脚"', "单引号'在内",
                          '两侧都"有"引号'):
                fm, _ = roundtrip({'title': value}, tmp)
                self.assertEqual(fm.get('title'), value, '标量 %r 往返坏了' % value)

    def test_列表项原样回来(self):
        """**这条是踩出来的。** 列表项的解析原来写成 `v.strip().strip('"\\'')`，
        那是"把首尾所有引号字符都剥掉"——于是项**内部**末尾的引号也被吃掉：
        `AI 长出"手脚"` 读回成 `AI 长出"手脚`。一个字符之差，不报错。"""
        with tempfile.TemporaryDirectory() as tmp:
            for value in (['AI 长出"手脚"'], ['普通别名'], ['带:冒号'],
                          ['两个', 'AI 长出"手脚"'], ["带'单引号'的项"]):
                fm, _ = roundtrip({'aliases': value}, tmp)
                self.assertEqual(fm.get('aliases'), value, '列表 %r 往返坏了' % value)

    def test_成对的外层引号仍然会被拆掉(self):
        """修正不能走到另一个极端：外层那对引号是**语法**，该拆。
        （库里确实有写成 `["AI"]` 的旧文件，读出来要是 `"AI"` 就会全线对不上。）"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 't.md'
            path.write_text('---\naliases: ["AI", \'学术\']\n---\n正文\n', encoding='utf-8')
            fm, _ = utils.parse_frontmatter(path.read_text(encoding='utf-8'))
        self.assertEqual(fm.get('aliases'), ['AI', '学术'])

    def test_空列表与单元素边界(self):
        with tempfile.TemporaryDirectory() as tmp:
            for value in ([], ['只有一个']):
                fm, _ = roundtrip({'tags': value}, tmp)
                self.assertEqual(fm.get('tags'), value)

    def test_正文一字不动(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 't.md'
            body = '第一行\n\n- [[某概念]]\n\n  缩进也要留着\n'
            utils.write_with_frontmatter(str(path), {'title': 'x'}, body)
            _, back = utils.parse_frontmatter(path.read_text(encoding='utf-8'))
        self.assertEqual(back, body)


if __name__ == '__main__':
    unittest.main()
