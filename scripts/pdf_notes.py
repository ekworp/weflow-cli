#!/usr/bin/env python3
"""
PDF 知识卡 — 把 PDF（本机 OCR 转文字）提炼成知识卡，喂给 wiki compile。

用法:
  python scripts/pdf_notes.py --dry-run --json          # 看代价（只读本地、零出境）
  python scripts/pdf_notes.py --pdf a.pdf --yes
  python scripts/pdf_notes.py --dir ./pdfs --limit 5 --yes
  python scripts/compile_wiki.py --source output/pdf-notes

## 这条线与其它三条线的不同（必须写清）

文章线 `article_notes.py` / 收藏线 `fav_notes.py` / 对话线 `chat_notes.py`：
材料**已经是文字**，这条线要**先变文字**——所以多了两步：

1. **PDF → Markdown**：本机 OCR（Unlimited-OCR-2，默认 `D:\\...\\ocr2`），**不出网**；
   OCR 引擎不存在时可用 `--ocr none` 走 PDF 内嵌文本（要求 PDF 本身是文字版）。
2. **Markdown → 摘要 + 概念**：一次模型调用，形状与收藏线 `fav_notes` **同款**
   （一次问出 `summary` + `concepts`），不额外多问。

卡片格式与 `article-card` 对齐（`type: pdf-card` + `## AI 摘要` + `## 概念`），
`compile_wiki --source output/pdf-notes` 直接能吃。

## 为什么摘要**由模型写**

文章线的摘要是**照抄**原笔记的；PDF 没有"原笔记"可抄——OCR 出来的是全文，
摘要必须重新生成。卡片 frontmatter 用 `summary_by: model` 标出来（与收藏线一致），
免得它看起来像抄来的原文。

## 隐私边界

PDF **不出网**：OCR 在本机跑；只有 OCR 之后的**文字**（截断到 3000 字）会发给模型，
与其它三条线同一边界。`--dry-run` 会把这个代价报出来。
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _utils import (SEPARATOR, call_deepseek, get_api_key, load_config,  # noqa: E402
                    note_path, parse_frontmatter, plain, write_with_frontmatter)

TZ = timezone(timedelta(hours=8))
OUTPUT_ROOT = 'output/pdf-notes'
DEFAULT_LIMIT = 5
# 进提示词的字数上限。PDF 的 OCR 全文可能几万字，3000 与文章线对齐。
MAX_PDF_CHARS = 3000
MIN_PDF_CHARS = 200
# 本机 OCR 引擎目录（Unlimited-OCR-2 的部署位置）。可用 --ocr-root 覆盖。
DEFAULT_OCR_ROOT = r'D:\github_project\ZhaoWen_GitHub维护\ocr2'
# OCR 一次喂几页。10 是官方默认（跨页缝合在这个窗口内生效）。
OCR_WINDOW = 10

# 形状与收藏线同款：**一次**问出摘要与概念。抄一份文章线的提示词会让两边分叉，
# 而收藏线那份（summary + concepts 一起问）正是这个形状。
PDF_PROMPT = """你是知识库的**编译者，不是作者**。下面是一份 PDF 文档的正文。

请只依据它，返回一个 JSON 对象（不要解释、不要代码块围栏）：
{{"summary": "这份文档在说什么（2-3 句，只写文档里有的）",
  "concepts": [{{"name": "概念名（2-12 字，不要带书名号引号方括号）", "desc": "这份文档关于它说了什么（一句话，具体）"}}]}}

要求：
1. **只写文档里有的**。没讲到的不许补；拿不准的宁可不写。
2. `concepts` 2-6 条、按重要度排序；**概念要具体**（"MCP 协议"可以，"技术"不行），
   也不是分类词（"AI"、"新闻"这种主题标签不算概念）。
3. 每条 desc 是"这份文档关于它的说法"，不是百科定义。
4. 全部中文，不要 markdown 语法（不要 #、*、-）。

文档：{title}

正文：
{body}
"""


def ocr_available(root: str) -> bool:
    """本机 OCR 引擎能不能用（目录 + 脚本 + venv + 权重 四样都要在）。"""
    base = Path(root)
    return (base.is_dir()
            and (base / 'ocr2_pdf.py').exists()
            and (base / '.venv' / 'Scripts' / 'python.exe').exists()
            and (base / 'model-00001-of-00002.safetensors').exists())


def pdf_page_count(pdf: Path) -> int:
    """PDF 有几页（拿不到就 0，不猜）。"""
    try:
        import fitz
        doc = fitz.open(str(pdf))
        count = doc.page_count
        doc.close()
        return count
    except Exception:
        return 0


def run_ocr(pdf: Path, root: str, pages: str, dpi: int, window: int) -> tuple:
    """调本机 OCR 把 PDF 转 Markdown。返回 (markdown, 来源说明)。

    **只跑本机**：调的是 `ocr2/.venv` 里的 python，脚本与权重都在本地目录，不联网。
    输出目录用**每次独立的临时目录**——OCR 脚本按 PDF 名写文件，共用一个目录会撞车。
    失败不吞：返回错误字符串，让上层如实报出来。
    """
    py = Path(root) / '.venv' / 'Scripts' / 'python.exe'
    script = Path(root) / 'ocr2_pdf.py'
    if not py.exists() or not script.exists():
        return '', 'ocr-engine-missing'
    # OCR 脚本按 PDF 名写文件，共用一个输出目录会撞车——每次用独立目录。
    # 目录名用 PDF 文件名 + 短哈希（hash 要固定种子，否则同名文件每次都是新目录）。
    stem = ''.join(ch for ch in pdf.stem if ch.isalnum() or ch in '-_')[:40] or 'doc'
    out_name = 'ocr-out-%s-%08x' % (stem, abs(hash(str(pdf.resolve()))) % 0xFFFFFFFF)
    cmd = [str(py), str(script), str(pdf.resolve()), '--dpi', str(dpi),
           '--window', str(window), '--out', out_name]
    if pages:
        cmd += ['--pages', pages]
    env = dict(os.environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    try:
        proc = subprocess.run(cmd, cwd=str(root), capture_output=True, text=True,
                              encoding='utf-8', errors='replace', env=env, timeout=7200)
    except subprocess.TimeoutExpired:
        return '', 'ocr-timeout'
    except Exception as error:
        return '', 'ocr-failed: %s' % type(error).__name__
    out = Path(root) / out_name / (pdf.stem + '.md')
    if proc.returncode != 0 or not out.exists():
        tail = (proc.stderr or proc.stdout or '').strip().splitlines()
        return '', 'ocr-exit-%d: %s' % (proc.returncode, tail[-1] if tail else 'no output')
    return out.read_text(encoding='utf-8'), 'local-ocr'


def extract_text_pdf(pdf: Path) -> tuple:
    """不依赖 OCR 的兜底：PDF 本身是文字版时直接抽文本。

    抽出来的**没有版面结构**（没有标题层级、没有表格），质量比 OCR 差一截——
    来源说明里标成 `embedded-text`，卡片 frontmatter 也照标。
    """
    try:
        import fitz
    except Exception:
        return '', 'no-fitz'
    try:
        doc = fitz.open(str(pdf))
        parts = [page.get_text() for page in doc]
        doc.close()
        return '\n\n'.join(p for p in parts if p.strip()), 'embedded-text'
    except Exception as error:
        return '', 'extract-failed: %s' % type(error).__name__


def list_pdfs(source: str, pdf: str) -> list:
    """要处理哪些 PDF。`--pdf` 给单文件，`--dir` 给目录（递归找 *.pdf）。"""
    if pdf:
        path = Path(pdf)
        return [path] if path.exists() else []
    root = Path(source)
    if not root.exists():
        return []
    return sorted(root.rglob('*.pdf'))


def build_prompt(title: str, body: str) -> str:
    """PDF 正文 → 提示词。抽出来是为了让测试能断言"喂给模型的串"是什么。"""
    return PDF_PROMPT.format(title=title, body=body[:MAX_PDF_CHARS])


def parse_note(raw: str):
    """解出 `{summary, concepts}`。解不出来返回 None（**不猜**）。"""
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip()
    start, end = text.find('{'), text.rfind('}')
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start:end + 1])
    except Exception:
        return None
    if not isinstance(data, dict) or not isinstance(data.get('concepts'), list):
        return None
    summary = plain(data.get('summary')).strip()
    if not summary:
        return None
    concepts = []
    for item in data['concepts']:
        if not isinstance(item, dict):
            continue
        name = plain(item.get('name')).strip().strip('[]')
        desc = plain(item.get('desc')).strip()
        if name and desc:
            concepts.append({'name': name, 'desc': desc})
        if len(concepts) >= 6:
            break
    return {'summary': summary, 'concepts': concepts}


def build_card(title: str, note: dict, source_name: str, pages: int, body_len: int,
               saved: str, updated: str, via: str):
    """卡片 → (frontmatter, body)。格式与 `article-card` 对齐。"""
    frontmatter = {
        'title': title,
        'type': 'pdf-card',
        'source': source_name,
        'topic': '文档',
        'tags': ['PDF', '文档'],
        'saved': saved,
        'pages': pages,
        # 这条线的摘要**是模型写的**（PDF 没有原笔记可抄），标出来
        'summary_by': 'model',
        # 正文从哪来的：本机 OCR 还是 PDF 内嵌文本
        'text_via': via,
        'bodyChars': body_len,
        'updated': updated,
    }
    parts = ['# %s\n' % title, '## AI 摘要\n', note['summary'] + '\n']
    if note['concepts']:
        parts.append('## 概念\n')
        for concept in note['concepts']:
            parts.append('- [[%s]] %s %s' % (concept['name'], SEPARATOR, concept['desc']))
        parts.append('')
    return frontmatter, '\n'.join(parts)


def already_carded(pdf: Path, out_dir: str) -> bool:
    """这个 PDF 已经有卡了吗（按文件名落卡）。"""
    return note_path(out_dir, pdf.stem).exists()


def exit_code(written: int) -> int:
    """部分成功算成功——与其它三条线同一个约定。"""
    return 0 if written else 1


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description='PDF 知识卡（PDF → 本机 OCR → 摘要与概念，喂给 wiki compile）')
    parser.add_argument('--pdf', default='', help='单个 PDF 路径')
    parser.add_argument('--dir', default='', help='PDF 目录（递归找 *.pdf）')
    parser.add_argument('--out', default=OUTPUT_ROOT, help='卡片输出目录')
    parser.add_argument('--ocr-root', default=DEFAULT_OCR_ROOT, help='本机 OCR 引擎目录（Unlimited-OCR-2）')
    parser.add_argument('--ocr', choices=['auto', 'none'], default='auto',
                        help='auto=用本机 OCR；none=只抽 PDF 内嵌文本（不调 OCR 引擎）')
    parser.add_argument('--pages', default='', help='只处理这些页（例 1-50），OCR 用')
    parser.add_argument('--dpi', type=int, default=200, help='OCR 渲染精度（默认 200）')
    parser.add_argument('--window', type=int, default=OCR_WINDOW, help='OCR 一次喂几页（默认 %d）' % OCR_WINDOW)
    parser.add_argument('--limit', type=int, default=DEFAULT_LIMIT,
                        help='最多处理几个 PDF（默认 %d）' % DEFAULT_LIMIT)
    parser.add_argument('--dry-run', action='store_true', help='只报要做什么，不调用')
    parser.add_argument('--refresh', action='store_true', help='已有卡的也重做')
    parser.add_argument('--yes', action='store_true', help='确认调用云端模型')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    if args.limit < 1:
        print(json.dumps({'success': False, 'error': '--limit 要 ≥ 1'}), file=sys.stdout)
        return 1

    pdfs = list_pdfs(args.dir, args.pdf)
    if not pdfs:
        message = '没找到 PDF（--pdf %s / --dir %s）' % (args.pdf or '-', args.dir or '-')
        print(json.dumps({'success': False, 'error': message}) if args.json else message,
              file=sys.stdout if args.json else sys.stderr)
        return 1

    use_ocr = args.ocr == 'auto'
    if use_ocr and not ocr_available(args.ocr_root):
        message = ('本机 OCR 引擎不在 %s（缺 ocr2_pdf.py / .venv / 权重）。'
                   '要么把引擎装到那个目录，要么用 --ocr none 走 PDF 内嵌文本。'
                   % args.ocr_root)
        print(json.dumps({'success': False, 'error': message}) if args.json else message,
              file=sys.stdout if args.json else sys.stderr)
        return 1

    runnable, existing = [], []
    for pdf in pdfs:
        (runnable if args.refresh or not already_carded(pdf, args.out) else existing).append(pdf)
    runnable = runnable[:args.limit] if args.limit else runnable

    if args.dry_run:
        preview = {
            'success': True, 'dryRun': True, 'action': 'pdf-notes',
            'pdfs': len(runnable), 'ocr': 'local' if use_ocr else 'embedded-text',
            'ocrEngine': args.ocr_root if use_ocr else None,
            'alreadyCarded': len(existing),
            'model': 'DeepSeek（生成摘要与概念）', 'calls': len(runnable),
            'readsLocalData': True, 'invokesAI': False, 'writesFiles': True,
            'note': 'PDF 文字在本机 OCR（不出网）；每篇一次模型调用，同时问摘要与概念',
        }
        if args.json:
            print(json.dumps(preview, ensure_ascii=False, indent=2))
        else:
            print('%d 个 PDF 待处理（文字在本机 OCR，不出境）；每篇一次模型调用同时问摘要与概念'
                  % len(runnable))
            if existing:
                print('已有卡、跳过 %d 个（要重做加 --refresh）' % len(existing))
            print('卡片写到 %s；之后跑 python scripts/compile_wiki.py --source %s'
                  % (args.out, args.out))
        return 0

    if not runnable:
        print('没有待处理的 PDF（都已有卡）', file=sys.stderr)
        return 1

    if not args.yes:
        print('会把 %d 个 PDF 的文字发给 DeepSeek（只问摘要与概念，每篇一次）。加 --yes 确认。'
              % len(runnable), file=sys.stderr)
        return 1

    config = load_config()
    api_key = get_api_key(config)
    if not api_key:
        print('没有配置 deepseekApiKey（weflow-cli config set deepseekApiKey "..."）', file=sys.stderr)
        return 1

    updated = datetime.now(TZ).strftime('%Y-%m-%d %H:%M')
    written, failed, skipped = [], [], []
    for pdf in runnable:
        title = pdf.stem
        if use_ocr:
            body, via = run_ocr(pdf, args.ocr_root, args.pages, args.dpi, args.window)
        else:
            body, via = extract_text_pdf(pdf)
        if not body:
            failed.append({'title': title[:30], 'reason': via or 'no-text'})
            continue
        if len(body.strip()) < MIN_PDF_CHARS:
            skipped.append({'title': title[:30], 'chars': len(body.strip())})
            continue
        try:
            raw = call_deepseek(build_prompt(title, body), api_key, max_tokens=800, timeout=90)
        except Exception as error:
            failed.append({'title': title[:30], 'reason': '调用失败：%s' % error})
            continue
        note = parse_note(raw)
        if note is None:
            failed.append({'title': title[:30], 'reason': '模型没返回可用 JSON'})
            continue
        frontmatter, card_body = build_card(
            title, note, source_name=pdf.name, pages=pdf_page_count(pdf),
            body_len=len(body), saved=updated, updated=updated, via=via)
        target = note_path(args.out, pdf.stem)
        target.parent.mkdir(parents=True, exist_ok=True)
        write_with_frontmatter(str(target), frontmatter, card_body)
        written.append({'title': title[:30], 'file': str(target),
                        'concepts': len(note['concepts']), 'textVia': via})

    result = {
        'success': True, 'action': 'pdf-notes', 'model': 'DeepSeek（生成摘要与概念）',
        'ocrEngine': args.ocr_root if use_ocr else None,
        'written': written, 'failed': failed, 'skipped': skipped,
        'pdfs': len(runnable), 'calls': len(runnable),
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for item in written:
            print('✓ %s（%d 个概念，文字来自 %s）→ %s'
                  % (item['title'], item['concepts'], item['textVia'], item['file']))
        for item in skipped:
            print('- %s：太短（%d 字）跳过' % (item['title'], item['chars']))
        for item in failed:
            print('✗ %s：%s' % (item['title'], item['reason']), file=sys.stderr)
        print('\n共 %d 张卡；接着跑 python scripts/compile_wiki.py --source %s'
              % (len(written), args.out))
    return exit_code(len(written))


if __name__ == '__main__':
    sys.exit(main())
