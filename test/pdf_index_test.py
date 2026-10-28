"""`collect_pdf_text`：让 PDF 进语义索引（`search` 能搜到）。

背景：索引原来只覆盖公众号文章与聊天，**用户手上的 PDF 完全搜不到**——而 PDF 恰恰是
"存了就再也找不着"的那类材料。这里钉住四件事：切块不跨页（页码要能引用）、
页码标记缺失时整篇一块（不丢）、`--pdf-chunks` 能限流（书太大时先试水）、
以及 `load_record_text` 认 `pdf:` 的 id（短语索引那条线要用）。
"""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ss = load('semantic_search')


def write_pdf_text(root: Path, name: str, pages: dict, saved='2026-10-27'):
    """造一份 `pdf-notes --ocr-only` 形状的文件。"""
    root.mkdir(parents=True, exist_ok=True)
    body = [f'---\ntitle: {name}\ntype: pdf-text\nsource: {name}.pdf\n'
            f'pages: {len(pages)}\ntext_via: local-ocr\nsaved: "{saved}"\n---\n']
    for n, text in pages.items():
        body.append(f'\n### 第 {n} 页\n\n{text}\n')
    (root / f'{name}.md').write_text(''.join(body), encoding='utf-8')


class SplitTests(unittest.TestCase):
    def test_按页切开(self):
        body = '前言\n### 第 1 页\n甲甲甲\n### 第 2 页\n乙乙乙\n'
        pages = ss.split_pdf_pages(body)
        self.assertEqual([label for label, _ in pages], ['第 1 页', '第 2 页'])
        self.assertIn('甲甲甲', pages[0][1])

    def test_没有页码标记时整篇一块(self):
        pages = ss.split_pdf_pages('只有正文没有页码')
        self.assertEqual(len(pages), 1)
        self.assertEqual(pages[0][0], '')

    def test_短页会合并_页标记留在正文里(self):
        # 一页几百字，一页一条向量太贵；合并后仍要能说清"在第几页"
        pages = [('第 1 页', '甲' * 50), ('第 2 页', '乙' * 50)]
        chunks = ss.merge_page_chunks(pages, chunk_chars=1200)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0][0], '第 1 页')
        self.assertIn('### 第 1 页', chunks[0][1])
        self.assertIn('### 第 2 页', chunks[0][1])

    def test_超大页不被拆开(self):
        chunks = ss.merge_page_chunks([('第 1 页', '甲' * 5000)], chunk_chars=1200)
        self.assertEqual(len(chunks), 1)


class CollectTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self._old = ss.OUTPUT_ROOT
        ss.OUTPUT_ROOT = str(self.root)

    def tearDown(self):
        ss.OUTPUT_ROOT = self._old
        self.tmp.cleanup()

    def test_收进索引并带页码标题(self):
        # 每页塞满 1300 字，超过 chunk 上限 → 一页一块，便于断言页码
        write_pdf_text(self.root / 'pdf-text', '合同A',
                       {1: '甲' * 1300, 2: '乙' * 1300})
        items = ss.collect_pdf_text()
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]['type'], 'pdf')
        self.assertIn('第 1 页', items[0]['title'])
        self.assertTrue(items[0]['id'].startswith('pdf:合同A#'))
        self.assertEqual(items[0]['date'], '2026-10-27')

    def test_没有目录时是空表(self):
        self.assertEqual(ss.collect_pdf_text(), [])

    def test_pdf_chunks_能限流(self):
        write_pdf_text(self.root / 'pdf-text', '厚书',
                       {i: ('第%d页正文' % i) * 400 for i in range(1, 9)})
        self.assertEqual(len(ss.collect_pdf_text()), 8)
        self.assertEqual(len(ss.collect_pdf_text(pdf_chunks=3)), 3)

    def test_空页不算一条(self):
        write_pdf_text(self.root / 'pdf-text', '有空白页', {1: '甲' * 30, 2: '   '})
        items = ss.collect_pdf_text()
        self.assertEqual(len(items), 1)

    def test_读不到目录不抛异常(self):
        ss.OUTPUT_ROOT = str(self.root / '不存在')
        self.assertEqual(ss.collect_pdf_text(), [])


class LoadRecordTests(unittest.TestCase):
    def test_pdf_的_id_直接返回那块正文(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = ss.OUTPUT_ROOT
            ss.OUTPUT_ROOT = tmp
            try:
                item = {'id': 'pdf:合同A#3', 'text': '命中块的正文', 'type': 'pdf'}
                text, path, url = ss.load_record_text(item)
                self.assertEqual(text, '命中块的正文')
                self.assertIn('pdf-text', path)
                self.assertTrue(path.endswith('合同A.md'))
                self.assertIsNone(url)
            finally:
                ss.OUTPUT_ROOT = old

    def test_未知_id_退回索引摘录(self):
        item = {'id': 'chat:abc', 'text': '消息原文'}
        text, path, _ = ss.load_record_text(item)
        self.assertEqual(text, '消息原文')
        self.assertIsNone(path)


if __name__ == '__main__':
    unittest.main()
