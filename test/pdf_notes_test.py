"""`pdf_notes.py`：PDF → 本机 OCR → 摘要与概念 → 知识卡（纯函数，不联网、不调 OCR）。

重点是**对下游的契约**：产出的卡要能被 `compile_wiki` 读出概念与描述，
格式与 `article-card` 对齐（`## AI 摘要` + `## 概念`）。

另外三条纪律在这里也要成立：
- `[[…]]` 只由我们的代码渲染（模型写的会被拆掉）；
- 摘要**由模型写**（PDF 没有原笔记可抄），所以 frontmatter 标 `summary_by: model`；
- OCR 引擎缺失要**如实报错**，不静默降级成"没正文"。
"""
import importlib.util
import json
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


pn = load('pdf_notes')
cw = load('compile_wiki')


class ParseTests(unittest.TestCase):
    def test_正常_JSON(self):
        raw = json.dumps({'summary': '这是一份讲 MCP 的文档。',
                          'concepts': [{'name': 'MCP 协议', 'desc': '把时间线开放给 Agent'}]},
                         ensure_ascii=False)
        note = pn.parse_note(raw)
        self.assertEqual(note['summary'], '这是一份讲 MCP 的文档。')
        self.assertEqual(note['concepts'],
                         [{'name': 'MCP 协议', 'desc': '把时间线开放给 Agent'}])

    def test_容忍代码块与前言(self):
        raw = '好：\n```json\n' + json.dumps(
            {'summary': '摘要', 'concepts': [{'name': '甲', 'desc': '在说甲'}]},
            ensure_ascii=False) + '\n```'
        self.assertIsNotNone(pn.parse_note(raw))

    def test_解不出来就_None_不猜(self):
        for raw in ['', '  ', '没有概念', '[]', '{"concepts": {}}', None, '{坏']:
            self.assertIsNone(pn.parse_note(raw), repr(raw)[:30])

    def test_没有摘要就当没解出来(self):
        # 摘要这一节是卡片正文的一部分，缺了卡片就是空壳
        raw = json.dumps({'concepts': [{'name': '甲', 'desc': '在说甲'}]}, ensure_ascii=False)
        self.assertIsNone(pn.parse_note(raw))

    def test_空概念列表是合法的(self):
        # "这份文档确实没有概念"与"模型没按形状答"是两件事，不许混
        note = pn.parse_note('{"summary": "短文", "concepts": []}')
        self.assertEqual(note['concepts'], [])

    def test_概念最多六条(self):
        many = [{'name': '概念%d' % i, 'desc': '描述%d' % i} for i in range(10)]
        raw = json.dumps({'summary': '摘要', 'concepts': many}, ensure_ascii=False)
        self.assertEqual(len(pn.parse_note(raw)['concepts']), 6)


class CardTests(unittest.TestCase):
    """卡片格式要对齐 `article-card`，`compile_wiki` 才吃得下。"""

    def _card(self, **kw):
        note = {'summary': '一份讲 MCP 的文档。',
                'concepts': [{'name': 'MCP 协议', 'desc': '把时间线开放给 Agent'}]}
        params = dict(title='某文档.pdf', note=note, source_name='某文档.pdf', pages=12,
                      body_len=4000, saved='2026-10-27 18:00', updated='2026-10-27 18:00',
                      via='local-ocr')
        params.update(kw)
        return pn.build_card(**params)

    def test_摘要与概念两节都在(self):
        _, body = self._card()
        self.assertIn('## AI 摘要', body)
        self.assertIn('## 概念', body)

    def test_概念链接是_我们渲染的(self):
        _, body = self._card()
        self.assertIn('- [[MCP 协议]] — 把时间线开放给 Agent', body)

    def test_摘要标成模型写的(self):
        # PDF 没有"原笔记"可抄，摘要必须重新生成——标出来免得它看起来像原文
        frontmatter, _ = self._card()
        self.assertEqual(frontmatter['summary_by'], 'model')

    def test_正文来源被记下来(self):
        frontmatter, _ = self._card(via='local-ocr')
        self.assertEqual(frontmatter['text_via'], 'local-ocr')
        self.assertEqual(frontmatter['pages'], 12)

    def test_下游能读出概念与描述(self):
        """**对下游的契约**：`compile_wiki` 要能读出概念名和描述。"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'card.md'
            frontmatter, body = self._card()
            pn.write_with_frontmatter(str(path), frontmatter, body)
            _, card_body = pn.parse_frontmatter(path.read_text(encoding='utf-8'))
            links = cw.concept_links(card_body, topic='文档')
            self.assertTrue(links, 'compile_wiki 没读出概念')
            names = [name for name, _ in links]
            self.assertIn('MCP 协议', names)

    def test_没有概念时卡里不出现概念节(self):
        note = {'summary': '短文', 'concepts': []}
        _, body = self._card(note=note)
        self.assertNotIn('## 概念', body)
        self.assertIn('## AI 摘要', body)


class OcrContractTests(unittest.TestCase):
    """OCR 引擎那一侧：缺了要**如实报错**，不静默降级。"""

    def test_引擎缺失时报错(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(pn.ocr_available(tmp))

    def test_引擎齐全时认得出来(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / '.venv' / 'Scripts').mkdir(parents=True)
            (base / '.venv' / 'Scripts' / 'python.exe').write_text('', encoding='utf-8')
            (base / 'ocr2_pdf.py').write_text('', encoding='utf-8')
            (base / 'model-00001-of-00002.safetensors').write_text('x', encoding='utf-8')
            self.assertTrue(pn.ocr_available(tmp))

    def test_缺权重不算_可用(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / '.venv' / 'Scripts').mkdir(parents=True)
            (base / '.venv' / 'Scripts' / 'python.exe').write_text('', encoding='utf-8')
            (base / 'ocr2_pdf.py').write_text('', encoding='utf-8')
            self.assertFalse(pn.ocr_available(tmp), '缺权重却报可用')


class ListTests(unittest.TestCase):
    def test_目录递归找_PDF(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / 'sub').mkdir()
            (base / 'a.pdf').write_bytes(b'%PDF-1.4')
            (base / 'sub' / 'b.pdf').write_bytes(b'%PDF-1.4')
            (base / 'note.txt').write_text('x', encoding='utf-8')
            found = pn.list_pdfs(str(base), '')
            self.assertEqual([p.name for p in found], ['a.pdf', 'b.pdf'])

    def test_单文件优先(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'x.pdf'
            path.write_bytes(b'%PDF-1.4')
            self.assertEqual(pn.list_pdfs('', str(path)), [path])

    def test_文件不存在时是空列表(self):
        self.assertEqual(pn.list_pdfs('', '/no/such/file.pdf'), [])


class PromptTests(unittest.TestCase):
    def test_正文超长会被截断(self):
        body = '字' * (pn.MAX_PDF_CHARS + 5000)
        prompt = pn.build_prompt('标题', body)
        self.assertLess(len(prompt), pn.MAX_PDF_CHARS + 2000)

    def test_提示词里同时要摘要和概念(self):
        prompt = pn.build_prompt('标题', '正文')
        self.assertIn('summary', prompt)
        self.assertIn('concepts', prompt)


if __name__ == '__main__':
    unittest.main()
