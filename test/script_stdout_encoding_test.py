# -*- coding: utf-8 -*-
"""`scripts/*.py` 的输出编码守卫（`docs/EXTENDING.md` Recipe E 的那条规矩）。

为什么要有它：**手跑或被重定向时 stdout 走本机编码**（Windows 是 GBK），此时打出 GBK 编不出来的字符
（`⚠️`、`✓`、`⇒`）会 `UnicodeEncodeError` —— 整次输出就没了。桥接跑有 `PYTHONIOENCODING=utf-8`，
所以**这种坑只在人手上出现**：测试不盯，就没人盯。本机实测到的两处是
`quality_eval.py` 的 `⚠️` 与 `wechat_emoticon.py` 的 `✓`。

判据（纯 AST，**不 import 也不运行任何脚本**）：
  1. 找出所有 `print(...)` / `...stdout.write(...)` 调用里的**字面量**（含 f-string 的字面段）；
  2. 字面量里出现"GBK 编不出来的字符" ⇒ 该文件必须调用 `sys.stdout.reconfigure`；
  3. 有 reconfigure 时非 GBK 字符**允许**（重定向输出统一成 UTF-8，与桥接一致）。

**为什么必须静态查、不能用"跑一遍子进程"来验**：本机（和桥接）都设了 `PYTHONIOENCODING=utf-8`，
于是 `python scripts/x.py > out.txt` 在这里**永远不崩**；真实处境要用 `python -E` 才看得见 —— 实测
`-E` 下重定向的 `sys.stdout.encoding` 是 **gbk**（locale cp936），`print('✓')` 直接
`UnicodeEncodeError: 'gbk' codec can't encode character '✓'`、退出码 1。
也就是说：**一个"跑一遍看崩不崩"的测试在这台机器上是假阴性**（同 `AGENTS.md` 那条"负结论要配正对照"）。
CI 的 python job 只装 zstandard/pycryptodome，也是这条不能 import 脚本的原因之一。

按 `AGENTS.md` 的规矩，扫描器**自带正对照**：先证明"该报的会报、不该报的不报"，
再去扫真脚本 —— 否则扫描器失灵时它会安静地全绿。
"""
import ast
import glob
import io
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, 'scripts')


def unencodable(text):
    """text 里 GBK 编不出来的字符（去重、排序后的串）。"""
    bad = set()
    for ch in text:
        try:
            ch.encode('gbk')
        except UnicodeEncodeError:
            bad.add(ch)
    return ''.join(sorted(bad))


def _literals(node):
    """调用里出现的字面量字符串（含 f-string 的字面段）。"""
    out = []
    for sub in ast.walk(node):
        if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
            out.append((sub.value, getattr(sub, 'lineno', 0)))
        elif isinstance(sub, ast.JoinedStr):
            for part in sub.values:
                if isinstance(part, ast.Constant) and isinstance(part.value, str):
                    out.append((part.value, getattr(part, 'lineno', 0)))
    return out


def stdout_literals(src):
    """→ [(行号, 编不出的字符)]：所有会打到 stdout/stderr 的字面量里的非 GBK 字符。"""
    hits = []
    for node in ast.walk(ast.parse(src)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = getattr(func, 'id', None) or getattr(func, 'attr', None)
        if name == 'write':
            if 'stdout' not in ast.unparse(func):
                continue
        elif name != 'print':
            continue
        for text, lineno in _literals(node):
            bad = unencodable(text)
            if bad:
                hits.append((lineno, bad))
    return sorted(set(hits))   # f-string 的字面段会被外层与内层各访问一次，去重


def violations(src):
    """违反守卫的 (行号, 字符)；有 `sys.stdout.reconfigure` 的脚本一律通过。"""
    if 'sys.stdout.reconfigure' in src:
        return []
    return stdout_literals(src)


def _text_io_calls(src):
    """→ [(行号, 描述, 有没有 encoding)]：**文本模式**的 open / write_text / read_text。

    口径收紧的一点：`open(p)` 不写 mode 时默认是**文本** 'r'，所以也按文本算
    （早一版审计把它跳过了，等于漏掉一整类）。
    """
    out = []
    for node in ast.walk(ast.parse(src)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        # **只认内置 `open`**：`Image.open()` / `tarfile.open()` / `zipfile.open()` 都是属性调用，
        # 它们是二进制的解码器/封装，给它们加 encoding= 才是错的（第一版判据在这里报了 10 处误报）。
        if isinstance(func, ast.Name) and func.id == 'open':
            name = 'open'
        elif isinstance(func, ast.Attribute) and func.attr in ('write_text', 'read_text'):
            name = func.attr
        else:
            continue
        enc = any(k.arg == 'encoding' for k in node.keywords)
        if name == 'open':
            mode = 'r'
            if len(node.args) >= 2 and isinstance(node.args[1], ast.Constant):
                mode = node.args[1].value
            for k in node.keywords:
                if k.arg == 'mode' and isinstance(k.value, ast.Constant):
                    mode = k.value.value
            if 'b' in (mode or ''):
                continue
            out.append((node.lineno, 'open(mode=%r)' % mode, enc))
        elif name in ('write_text', 'read_text'):
            out.append((node.lineno, name + '()', enc))
    return out


def text_io_without_encoding(src):
    return [(ln, what) for ln, what, enc in _text_io_calls(src) if not enc]


class ScannerControlsTest(unittest.TestCase):
    """先证明扫描器本身是活的（该报的报、不该报的不报）。"""

    def test_flags_a_non_gbk_print(self):
        self.assertEqual(violations("print('✓ seed = 1')\n"), [(1, '✓')])
        # f-string 的字面段也要抓到
        self.assertTrue(violations("print(f'⚠️ 少于 20 条')\n"))

    def test_does_not_flag_ascii_or_chinese(self):
        # 纯 ASCII 与**纯中文**都不该报：中文在 GBK 里有对应，只是可能乱码，不会崩
        self.assertEqual(violations("print('hello %d' % n)\n"), [])
        self.assertEqual(violations("print('标注少于 20 条')\n"), [])

    def test_reconfigure_makes_the_same_print_acceptable(self):
        src = "import sys\nsys.stdout.reconfigure(encoding='utf-8')\nprint('✓ seed = 1')\n"
        self.assertEqual(violations(src), [])

    def test_scanner_actually_sees_prints_in_the_repo(self):
        # 反"空扫"：一条都没找到说明扫描器坏了，不能当"全绿"
        seen = 0
        for path in glob.glob(os.path.join(SCRIPTS, '*.py')):
            seen += len(stdout_literals(io.open(path, encoding='utf-8').read()))
        self.assertGreater(seen, 20, '扫到的 print 字面量太少，扫描器可能失灵')


class ScriptsStdoutEncodingTest(unittest.TestCase):
    def test_no_script_prints_a_non_gbk_char_without_reconfigure(self):
        bad = []
        for path in sorted(glob.glob(os.path.join(SCRIPTS, '*.py'))):
            src = io.open(path, encoding='utf-8').read()
            for lineno, chars in violations(src):
                bad.append('%s:%d 打出 %r（GBK 编不出来）' % (
                    os.path.relpath(path, ROOT), lineno, chars))
        self.assertEqual(
            bad, [],
            '这些行在"重定向/管道"下会 UnicodeEncodeError（桥接跑有 PYTHONIOENCODING 所以看不出来）；'
            '修法是在模块顶部加 sys.stdout.reconfigure(encoding="utf-8", errors="replace")：\n  '
            + '\n  '.join(bad))


class ScriptsFileEncodingTest(unittest.TestCase):
    """同一件事的另一半：**读写文件**也不许依赖调用方的 locale。

    2026-10-07 审计：60 个脚本里文本模式 `open()/write_text()/read_text()` **186 处全部带 `encoding=`、0 处遗漏**
    （正对照在下面那条：连"带 encoding"的都数不到就说明扫描器坏了）。漏了 `encoding=` 时，中文 Windows 会按
    **GBK** 读/写，而下游（HTML / Vault / 日报）按 UTF-8 解 —— 静默乱码，不报错。

    判据本身踩过一个坑，记在这儿：第一版按"函数名是 `open`"匹配，把 **PIL 的 `Image.open()`** 也算成文本读，
    报了 10 处误报 —— 它其实是**二进制解码器**，给它 `encoding=` 才是错的。现在只认**内置** `open`，
    属性调用只认 `write_text/read_text`，并把 `Image.open/tarfile.open/zipfile.open` 写进对照用例。
    另外 3 处 `open(f'/proc/<pid>/...')` 是 Linux 分支读的 ASCII 内核文件（不是真风险），也一并写明 encoding，
    免得判据要开白名单。
    """

    def test_text_mode_io_declares_its_encoding(self):
        bad = []
        seen = 0
        for path in sorted(glob.glob(os.path.join(SCRIPTS, '*.py'))):
            src = io.open(path, encoding='utf-8').read()
            seen += len(_text_io_calls(src))
            for lineno, what in text_io_without_encoding(src):
                bad.append('%s:%d %s' % (os.path.relpath(path, ROOT), lineno, what))
        # 正对照：数到 0 说明扫描器坏了，那时的"没有违反"不作数
        self.assertGreater(seen, 50, '正对照失败：连"带 encoding"的调用都没数到，扫描器有问题')
        self.assertEqual(
            bad, [],
            '文本模式读写必须写明 encoding="utf-8"（否则走 locale，中文 Windows = GBK）：\n  '
            + '\n  '.join(bad))

    def test_guard_controls(self):
        # 该报的报：不带 encoding 的读、写、以及省略 mode 的 open（默认文本）
        for src in ("open(p, 'w')\n", "open(p)\n", "p.write_text('x')\n", "p.read_text()\n"):
            self.assertTrue(text_io_without_encoding(src), src)
        # 不该报的不报：二进制、写了 encoding 的、以及**属性上的** open（PIL/tarfile/zipfile 的解码器）
        for src in ("open(p, 'rb')\n", "open(p, 'w', encoding='utf-8')\n",
                    "p.write_text('x', encoding='utf-8')\n",
                    "Image.open(p)\n", "tarfile.open(p)\n", "zipfile.open(p)\n"):
            self.assertEqual(text_io_without_encoding(src), [], src)


if __name__ == '__main__':
    unittest.main()
