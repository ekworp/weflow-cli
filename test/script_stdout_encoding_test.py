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


if __name__ == '__main__':
    unittest.main()
