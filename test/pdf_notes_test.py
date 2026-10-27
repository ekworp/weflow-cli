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
import os
import subprocess
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


class OcrCacheTests(unittest.TestCase):
    """OCR 缓存：**OCR 比模型调用贵几百倍**（一页约 1.5 秒，300 页的书七八分钟），
    所以重出卡（换提示词、某篇调用失败重跑）不该把识别重做一遍。

    这里钉住三件事：路径**跨进程稳定**（内置 `hash()` 对 str 每进程不同——那个 bug 让缓存
    永远命中不了、还每次留一个新目录）、参数变了算另一份、PDF 改了就重做。
    """

    def _engine(self, tmp) -> str:
        """造一个"目录结构齐全"的假引擎；脚本是空的，所以真跑必失败——正好用来区分有无命中。"""
        root = Path(tmp) / 'ocr2'
        (root / '.venv' / 'Scripts').mkdir(parents=True)
        (root / '.venv' / 'Scripts' / 'python.exe').write_text('', encoding='utf-8')
        (root / 'ocr2_pdf.py').write_text('', encoding='utf-8')
        return str(root)

    def _pdf(self, tmp, mtime=1000, name='doc.pdf') -> Path:
        path = Path(tmp) / name
        path.write_bytes(b'%PDF-1.4')
        os.utime(path, (mtime, mtime))
        return path

    def test_路径跨进程稳定(self):
        import subprocess
        code = ('import sys; sys.path.insert(0, %r); import pdf_notes as p, pathlib; '
                'print(p.ocr_cache_path(pathlib.Path(%r), %r, 200, 10, ""))'
                % (str(SCRIPTS), 'D:/x/doc.pdf', 'D:/root'))
        runs = [subprocess.run([sys.executable, '-c', code], capture_output=True, text=True,
                               env={**os.environ, 'PYTHONHASHSEED': seed})
                for seed in ('1', '2')]
        self.assertTrue(runs[0].stdout.strip(), runs[0].stderr[-400:])
        self.assertEqual(runs[0].stdout.strip(), runs[1].stdout.strip(),
                         '两个进程算出的缓存路径不同 —— 又用了内置 hash()？')

    def test_参数不同算两份(self):
        pdf = Path('D:/x/doc.pdf')
        a = pn.ocr_cache_path(pdf, 'D:/root', dpi=200, window=10, pages='')
        b = pn.ocr_cache_path(pdf, 'D:/root', dpi=300, window=10, pages='')
        c = pn.ocr_cache_path(pdf, 'D:/root', dpi=200, window=5, pages='1-20')
        self.assertNotEqual(a, b, 'dpi 变了却复用同一份缓存')
        self.assertNotEqual(a, c, '窗口/页范围变了却复用同一份缓存')

    def test_缓存命中时不再跑_OCR(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self._engine(tmp)
            pdf = self._pdf(tmp, mtime=1000)
            cached = pn.ocr_cache_path(pdf, root, 200, 10, '')
            cached.parent.mkdir(parents=True)
            cached.write_text('缓存里的正文', encoding='utf-8')
            os.utime(cached, (2000, 2000))
            body, via = pn.run_ocr(pdf, root, '', 200, 10, reuse=True)
            self.assertEqual(body, '缓存里的正文')
            self.assertEqual(via, 'local-ocr-cached')

    def test_PDF_改过就要重做(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self._engine(tmp)
            pdf = self._pdf(tmp, mtime=3000)
            cached = pn.ocr_cache_path(pdf, root, 200, 10, '')
            cached.parent.mkdir(parents=True)
            cached.write_text('旧正文', encoding='utf-8')
            os.utime(cached, (1000, 1000))
            body, via = pn.run_ocr(pdf, root, '', 200, 10, reuse=True)
            self.assertNotEqual(body, '旧正文', 'PDF 更新了却还在用旧缓存')
            self.assertNotEqual(via, 'local-ocr-cached')

    def test_关掉复用就一定重跑(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self._engine(tmp)
            pdf = self._pdf(tmp, mtime=1000)
            cached = pn.ocr_cache_path(pdf, root, 200, 10, '')
            cached.parent.mkdir(parents=True)
            cached.write_text('缓存里的正文', encoding='utf-8')
            os.utime(cached, (2000, 2000))
            _, via = pn.run_ocr(pdf, root, '', 200, 10, reuse=False)
            self.assertNotEqual(via, 'local-ocr-cached', '--no-reuse-ocr 没生效')


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
