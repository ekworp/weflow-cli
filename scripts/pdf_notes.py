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
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _utils import (SEPARATOR, TOPICS, call_deepseek, get_api_key,  # noqa: E402
                    get_dashscope_key, load_config,
                    note_path, parse_frontmatter, plain, write_with_frontmatter)

TZ = timezone(timedelta(hours=8))
OUTPUT_ROOT = 'output/pdf-notes'
# `--ocr-only` 的落点：**只有文字**，没有卡片。与卡片目录分开，免得 compile_wiki 把
# 没有 `[[概念]]` 的纯文本当成一份坏卡去扫（它按 `output/*-notes` 通配找目录）。
TEXT_ROOT = 'output/pdf-text'
# 中间产物（云端 OCR 缓存）。**必须和卡片目录分开**：`compile_wiki --source output/pdf-notes`
# 会把那个目录下的 .md 当卡片扫，缓存落进去就会被当成一张"没有概念的坏卡"。
# 实测踩过：缓存当时写在 `output/pdf-notes/.cache/cloud-ocr/` 下。
CACHE_ROOT = 'output/.cache'
DEFAULT_LIMIT = 5
# 进提示词的字数上限。PDF 的 OCR 全文可能几万字，3000 与文章线对齐。
MAX_PDF_CHARS = 3000
MIN_PDF_CHARS = 200
# 本机 OCR 引擎目录（Unlimited-OCR-2 的部署位置）。可用 --ocr-root 覆盖。
DEFAULT_OCR_ROOT = r'D:\github_project\ZhaoWen_GitHub维护\ocr2'
# OCR 一次喂几页。10 是官方默认（跨页缝合在这个窗口内生效）。
OCR_WINDOW = 10

# 形状与收藏线同款：**一次**问出主题、摘要与概念，不额外多问。
# `topic` 是这一版加的：原来所有 PDF 卡都写死 `文档`，于是概念页「来源」栏里
# PDF 和文章永远归不进同一个主题（`来源 · 主题` 那句要靠它）。分类口径直接取
# `_utils.TOPICS`，免得两处各写一份六类名字。
PDF_PROMPT = """你是知识库的**编译者，不是作者**。下面是一份 PDF 文档的正文。

请只依据它，返回一个 JSON 对象（不要解释、不要代码块围栏）：
{{"topic": "从这些里选一个：{topics}",
  "summary": "这份文档在说什么（2-3 句，只写文档里有的）",
  "concepts": [{{"name": "概念名（2-12 字，不要带书名号引号方括号）", "desc": "这份文档关于它说了什么（一句话，具体）"}}]}}

要求：
1. **只写文档里有的**。没讲到的不许补；拿不准的宁可不写。
2. `topic` 只能取上面列出的那几个词之一，**不要自创**；实在判断不了就用"学术"。
3. `concepts` 2-6 条、按重要度排序；**概念要具体**（"MCP 协议"可以，"技术"不行），
   也不是分类词（"AI"、"新闻"这种主题标签不算概念）。
4. 每条 desc 是"这份文档关于它的说法"，不是百科定义。
5. 全部中文，不要 markdown 语法（不要 #、*、-）。

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


# 云端 OCR 的默认模型。实测（2026-10-27，同一张 1600px 图）：
#   qwen3.5-ocr  0.8s   qwen-vl-ocr 0.8s   qwen3-vl-plus 1.8s  —— 三个都读对了，
# 取最快且专做 OCR 的那个。可用 `--ocr-model` 或配置键 `ocrCloudModel` 覆盖。
DEFAULT_CLOUD_MODEL = 'qwen3.5-ocr'
CLOUD_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
# 一页一张图、一次请求。并发 3：实测单请求 0.8s，串行跑 300 页要 4 分钟，
# 而再高容易撞账号级限流（429 会让整页失败，代价比慢更贵）。
CLOUD_WORKERS = 3


def cloud_available() -> bool:
    """云端 OCR 能不能用：**有 DashScope key 就行**（不复用 deepseekApiKey——
    那是另一家服务，混用会让人以为"我有 key 所以能 OCR"，实际请求会 401）。"""
    try:
        return bool(get_dashscope_key(load_config()))
    except Exception:
        return False


def choose_source(mode: str, local_ok: bool, cloud_ok: bool) -> tuple:
    """选路：`(来源, 理由)`。纯函数，便于测顺序。

    `auto` = **云端优先、本地兜底**（2026-10-27 按用户要求改过一次，原来是本地优先）。
    改的依据是实测：同一份 5 页 PDF——本地 270 s（54 s/页，8 GB 卡上 crop 切块很慢），
    云端 6.1 s（1.2 s/页），**44 倍**，而且云端多读出 608 字。页面图片出境换来的是
    快两个数量级、且成本约 ¥0.002/页。

    显式指定 `local`/`cloud` 时**不偷偷换路**——用户说了算，做不到就报错。
    """
    if mode == 'local':
        return ('local', '') if local_ok else ('', '指定了 --ocr local，但本机引擎不完整')
    if mode == 'cloud':
        return ('cloud', '') if cloud_ok else ('', '指定了 --ocr cloud，但没配置 DashScope key')
    if mode == 'none':
        return 'embedded', ''
    # auto：云端优先，本地兜底
    if cloud_ok:
        return 'cloud', '云端优先（实测 1.2s/页 vs 本地 54s/页；页面图片会出境）'
    if local_ok:
        return 'local', '没有云端 key，改用本机引擎（不出网）'
    return 'embedded', '本机引擎与云端 key 都没有，退回 PDF 内嵌文本（扫描件会读不出字）'


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


def ocr_cache_path(pdf: Path, root: str, dpi: int, window: int, pages: str) -> Path:
    """OCR 结果的缓存路径——**参数变了就是另一份**（同一条 PDF、不同 dpi 不能混用）。

    目录名用 `hashlib` 而不是内置 `hash()`：后者对 `str` **每个进程都不同**
    （`PYTHONHASHSEED` 随机），于是每次运行都新建一个目录——既留垃圾，也永远命中不了缓存。
    实测这个 bug：连跑两次同一份 PDF，`ocr2/` 下多了两个 `ocr-out-*` 目录。
    """
    key = '%s|%d|%d|%s' % (pdf.resolve(), dpi, window, pages)
    digest = hashlib.md5(key.encode('utf-8')).hexdigest()[:10]
    stem = ''.join(ch for ch in pdf.stem if ch.isalnum() or ch in '-_')[:40] or 'doc'
    return Path(root) / ('ocr-out-%s-%s' % (stem, digest)) / (pdf.stem + '.md')


def run_ocr(pdf: Path, root: str, pages: str, dpi: int, window: int,
            reuse: bool = True) -> tuple:
    """调本机 OCR 把 PDF 转 Markdown。返回 (markdown, 来源说明)。

    **只跑本机**：调的是 `ocr2/.venv` 里的 python，脚本与权重都在本地目录，不联网。
    失败不吞：返回错误字符串，让上层如实报出来。

    `reuse=True` 时先看缓存：**OCR 比模型调用贵得多**（一页约 1.5 秒，一本 300 页的书
    要七八分钟），而换提示词重出卡、或某一篇调用失败后重跑，都不该把 OCR 重做一遍
    （实测动机：重跑一次 60 页的 PDF，OCR 12 分钟、模型调用 2 秒）。
    缓存的判据是 **mtime 不早于 PDF** —— PDF 被改过（重新导出）就重做。
    """
    py = Path(root) / '.venv' / 'Scripts' / 'python.exe'
    script = Path(root) / 'ocr2_pdf.py'
    if not py.exists() or not script.exists():
        return '', 'ocr-engine-missing'
    out = ocr_cache_path(pdf, root, dpi, window, pages)
    if reuse and out.exists():
        try:
            if out.stat().st_mtime >= pdf.stat().st_mtime:
                return out.read_text(encoding='utf-8'), 'local-ocr-cached'
        except OSError:
            pass
    out_name = out.parent.name
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
    if proc.returncode != 0 or not out.exists():
        tail = (proc.stderr or proc.stdout or '').strip().splitlines()
        return '', 'ocr-exit-%d: %s' % (proc.returncode, tail[-1] if tail else 'no output')
    return out.read_text(encoding='utf-8'), 'local-ocr'


def cloud_cache_path(pdf: Path, dpi: int, pages: str, model: str) -> Path:
    """云端 OCR 的缓存：**模型也算进键**（换模型就是另一份文字，不能混）。"""
    key = 'cloud|%s|%d|%s|%s' % (pdf.resolve(), dpi, pages, model)
    digest = hashlib.md5(key.encode('utf-8')).hexdigest()[:10]
    return Path(CACHE_ROOT) / 'cloud-ocr' / ('%s-%s.md' % (pdf.stem, digest))


def _render_pages(pdf: Path, idx: list, dpi: int) -> list:
    """把指定页渲染成 PNG 的 base64。返回 [(页号, b64)]。"""
    import base64
    import fitz
    doc = fitz.open(str(pdf))
    mat = fitz.Matrix(dpi / 72, dpi / 72)
    out = []
    for i in idx:
        if i >= doc.page_count:
            continue
        png = doc[i].get_pixmap(matrix=mat).tobytes('png')
        out.append((i + 1, base64.b64encode(png).decode()))
    doc.close()
    return out


def _cloud_ocr_page(b64: str, key: str, model: str, timeout: int = 120) -> str:
    """一页 → 文字。失败抛异常，由上层计数（**不静默当空页**）。"""
    import urllib.request
    payload = {
        'model': model, 'max_tokens': 4000,
        'messages': [{'role': 'user', 'content': [
            {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + b64}},
            {'type': 'text',
             'text': 'OCR识别这一页，保持原始段落与阅读顺序，直接输出纯文本；'
                     '不要解释、不要加标题或代码块。'}
        ]}],
    }
    req = urllib.request.Request(
        CLOUD_ENDPOINT, data=json.dumps(payload).encode('utf-8'),
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    return (data['choices'][0]['message']['content'] or '').strip()


def run_cloud_ocr(pdf: Path, pages: str, dpi: int, model: str, reuse: bool = True):
    """云端 OCR：逐页渲染 → 并发调用 → 拼成与本地同款 Markdown。

    为什么按**页**而不是整个 PDF：DashScope 的对话接口一次一张图，而且失败只影响一页
    （本地那套是整份文档一个进程，中途挂了全丢）。

    缓存：同一份 PDF + 同样的 dpi/页范围/模型 → 直接复用（判断依据同本地那条）。
    """
    from concurrent.futures import ThreadPoolExecutor
    out = cloud_cache_path(pdf, dpi, pages, model)
    if reuse and out.exists():
        try:
            if out.stat().st_mtime >= pdf.stat().st_mtime:
                return out.read_text(encoding='utf-8'), 'cloud-ocr-cached'
        except OSError:
            pass
    key = get_dashscope_key(load_config())
    if not key:
        return '', 'cloud-no-key'
    try:
        idx = parse_page_spec(pages, pdf_page_count(pdf))
        rendered = _render_pages(pdf, idx, dpi)
    except Exception as error:
        return '', 'cloud-render-failed: %s' % type(error).__name__
    if not rendered:
        return '', 'cloud-no-pages'

    failed = []

    def one(item):
        page_no, b64 = item
        try:
            return page_no, _cloud_ocr_page(b64, key, model), None
        except Exception as error:
            return page_no, '', type(error).__name__

    results = []
    try:
        with ThreadPoolExecutor(max_workers=CLOUD_WORKERS) as pool:
            for page_no, text, err in pool.map(one, rendered):
                if err:
                    failed.append('%d:%s' % (page_no, err))
                results.append((page_no, text))
    except Exception as error:
        return '', 'cloud-failed: %s' % type(error).__name__

    if not any(text.strip() for _n, text in results):
        return '', 'cloud-all-failed（%s）' % '; '.join(failed[:3] or ['无输出'])

    parts = ['# %s\n' % pdf.stem]
    for page_no, text in sorted(results):
        parts.append('\n### 第 %d 页\n\n%s\n' % (page_no, text or '（本页识别失败）'))
    body = ''.join(parts)
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(body, encoding='utf-8')
    except OSError:
        pass
    via = 'cloud-ocr'
    if failed:
        via = 'cloud-ocr-partial:%d页失败' % len(failed)
    return body, via


def parse_page_spec(spec: str, total: int) -> list:
    """`1-50` / `3` / `1,5,9` / 空 → 页号列表（0 基）。与 OCR 脚本的语义保持一致。"""
    if not spec or not total:
        return list(range(total))
    out = []
    for part in str(spec).split(','):
        part = part.strip()
        if not part:
            continue
        if '-' in part:
            a, b = part.split('-', 1)
            out += list(range(int(a) - 1, min(int(b), total)))
        else:
            out.append(int(part) - 1)
    return [i for i in out if 0 <= i < total]


def read_text_by_source(pdf: Path, source: str, args) -> tuple:
    """按选定的来源取正文。**一处分发**，两个调用点（--ocr-only 与出卡）共用。

    放成一个函数是踩出来的教训：同一段 if/else 抄两遍，改一处忘另一处时症状是
    "`--ocr-only` 走了云端、出卡却还走本地"，而两条路都能跑通、不报错。
    """
    if source == 'local':
        return run_ocr(pdf, args.ocr_root, args.pages, args.dpi, args.window,
                       reuse=not args.no_reuse_ocr)
    if source == 'cloud':
        model = getattr(args, 'ocr_model', '') or DEFAULT_CLOUD_MODEL
        return run_cloud_ocr(pdf, args.pages, args.dpi, model,
                             reuse=not args.no_reuse_ocr)
    return extract_text_pdf(pdf)


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


def list_chat_pdfs(limit: int = 0) -> tuple:
    """聊天里收到的 PDF：读微信自己的 `hardlink.db`（`file` 表 → 本地路径）。

    为什么走 hardlink 而不是扫 `msg/` 目录：那个索引是微信自己维护的 `md5 → (目录, 文件名)`，
    转发的副本、被改过名的也认；扫目录会漏。实测本机：1,978 条文件记录、**279 个 .pdf**，
    其中 **199 个**本地还在（80 个已被微信清理）。

    返回 `(文件列表, 说明)`；说明非空表示**一条都没取到**的原因（配置缺、库打不开、全是清理过的）。
    排序按文件 mtime 倒序——hardlink 表里没有"收到时间"，mtime 是能拿到的最接近的代理。
    """
    try:
        import media_index as mi
    except Exception as error:
        return [], '读不到 media_index（%s）' % type(error).__name__
    try:
        config = load_config()
        if not config.get('ntDbPath'):
            return [], '配置里没有 ntDbPath（先跑 weflow-cli init）'
        got = mi.open_db(config)
        conn = got[0] if isinstance(got, tuple) else got
        rows = mi.load_rows(conn, 'file')
    except SystemExit as error:
        return [], str(error) or 'hardlink.db 不可用'
    except Exception as error:
        return [], '读 hardlink.db 失败（%s: %s）' % (type(error).__name__, error)

    found, cleaned, duplicates = [], 0, 0
    seen_md5 = set()
    for row in rows:
        if not str(row.get('file', '')).lower().endswith('.pdf'):
            continue
        path = mi.resolve(config, row)
        if not path.exists():
            cleaned += 1
            continue
        # **按 md5 去重**：微信给同一份文件存了多个副本（转发/重复保存），文件名带 (1)(2)。
        # 实测本机 199 个本地 PDF 里 **23 个是重复副本**（22 组）。不去重的后果是
        # 白花 23 次 OCR + 生成 23 张内容一样的卡，概念页里同一个来源出现两遍。
        md5 = str(row.get('md5') or '').lower()
        if md5:
            if md5 in seen_md5:
                duplicates += 1
                continue
            seen_md5.add(md5)
        try:
            found.append((path.stat().st_mtime, path))
        except OSError:
            continue
    found.sort(reverse=True)
    files = [p for _mt, p in found]
    if limit:
        files = files[:limit]
    notes = []
    if cleaned:
        notes.append('另有 %d 个 PDF 已被微信清理，跳过' % cleaned)
    if duplicates:
        notes.append('跳过 %d 个重复副本（同一个 md5）' % duplicates)
    note = '；'.join(notes)
    if not files:
        note = note or '聊天记录里没有 PDF 文件'
    return files, note


def sample_body(body: str, limit: int = MAX_PDF_CHARS) -> str:
    """长文档的采样：**头部 + 尾部**，中间标出省略了多少字。

    为什么不硬截前 `limit` 字：实测一份 **96 页**的论文，摘要只看了前 3 页——
    摘要、方法都在开头，但结论、讨论、审稿回复在最后，硬截等于把它们全丢了。
    尾部的"结论"恰恰是判断这篇在讲什么最值钱的部分。

    比例 6:4（头多尾少）：开头有摘要与问题定义，结尾有结论与展望。
    短文档（≤ limit）原样返回，不插标记。
    """
    body = (body or '').strip()
    if len(body) <= limit:
        return body
    head_n = int(limit * 0.6)
    tail_n = limit - head_n
    omitted = len(body) - head_n - tail_n
    return '%s\n\n……（中间省略 %d 字）……\n\n%s' % (
        body[:head_n], omitted, body[-tail_n:])


def build_prompt(title: str, body: str) -> str:
    """PDF 正文 → 提示词。抽出来是为了让测试能断言"喂给模型的串"是什么。

    长文档走 `sample_body`（头尾采样），不硬截前 N 字——见那个函数的注释。
    """
    return PDF_PROMPT.format(title=title, body=sample_body(body),
                             topics='、'.join(TOPICS))


def parse_note(raw: str):
    """解出 `{topic, summary, concepts}`。解不出来返回 None（**不猜**）。

    `topic` 宽松处理：**不在六类里就当没给**（落到 `文档`），不因为一个分类词把整张卡丢掉——
    摘要与概念才是卡的主体。但也不接受自创词：那会让 `compile_wiki` 的主题统计里
    多出一个只出现一次的怪名字。
    """
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
    topic = plain(data.get('topic')).strip().strip('[]')
    if topic not in TOPICS:
        topic = ''
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
    return {'topic': topic, 'summary': summary, 'concepts': concepts}


def build_card(title: str, note: dict, source_name: str, pages: int, body_len: int,
               saved: str, updated: str, via: str):
    """卡片 → (frontmatter, body)。格式与 `article-card` 对齐。"""
    frontmatter = {
        'title': title,
        'type': 'pdf-card',
        'source': source_name,
        # 模型能判断就用它的六类主题（和文章卡同一套口径，概念页的「来源 · 主题」才对得上）；
        # 判断不出才落到 `文档`——它是"未分类"的位置，不是第七类。
        'topic': note.get('topic') or '文档',
        'tags': ['PDF', note.get('topic') or '文档'],
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
    parser.add_argument('--from-chat', action='store_true',
                        help='从聊天记录里找别人发过的 PDF（读微信 hardlink.db，按文件时间倒序）')
    parser.add_argument('--out', default=OUTPUT_ROOT, help='卡片输出目录')
    parser.add_argument('--ocr-root', default=DEFAULT_OCR_ROOT, help='本机 OCR 引擎目录（Unlimited-OCR-2）')
    parser.add_argument('--ocr', choices=['auto', 'local', 'cloud', 'none'], default='auto',
                        help='auto=本地引擎在就用本地、不在就上云端、都没有才抽内嵌文本；'
                             'local/cloud 强制指定（做不到就报错，不偷偷换路）；none=只抽内嵌文本')
    parser.add_argument('--ocr-model', default='',
                        help='云端 OCR 用的模型（默认 %s）' % DEFAULT_CLOUD_MODEL)
    parser.add_argument('--pages', default='', help='只处理这些页（例 1-50），OCR 用')
    parser.add_argument('--dpi', type=int, default=200, help='OCR 渲染精度（默认 200）')
    parser.add_argument('--window', type=int, default=OCR_WINDOW, help='OCR 一次喂几页（默认 %d）' % OCR_WINDOW)
    parser.add_argument('--limit', type=int, default=DEFAULT_LIMIT,
                        help='最多处理几个 PDF（默认 %d）' % DEFAULT_LIMIT)
    parser.add_argument('--dry-run', action='store_true', help='只报要做什么，不调用')
    parser.add_argument('--refresh', action='store_true', help='已有卡的也重做')
    parser.add_argument('--ocr-only', action='store_true',
                        help='只做识别、只写文字（不调用模型、不花钱、不需要 --yes/API key）——'
                             '可以先挂着过夜跑完，白天再出卡')
    parser.add_argument('--no-reuse-ocr', action='store_true',
                        help='不复用缓存的 OCR 文字，强制重新识别（默认复用：PDF 没改过就不重做）')
    parser.add_argument('--yes', action='store_true', help='确认调用云端模型')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    if args.limit < 1:
        print(json.dumps({'success': False, 'error': '--limit 要 ≥ 1'}), file=sys.stdout)
        return 1

    if args.from_chat:
        pdfs, chat_note = list_chat_pdfs(limit=0)     # 截断留给 --limit（它同时是花费闸门）
        if chat_note:
            print('[聊天 PDF] %s' % chat_note, file=sys.stderr)
        if not pdfs:
            message = chat_note or '聊天记录里没有可读的 PDF'
            print(json.dumps({'success': False, 'error': message}) if args.json else message,
                  file=sys.stdout if args.json else sys.stderr)
            return 1
    else:
        pdfs = list_pdfs(args.dir, args.pdf)
    if not pdfs:
        message = '没找到 PDF（--pdf %s / --dir %s）' % (args.pdf or '-', args.dir or '-')
        print(json.dumps({'success': False, 'error': message}) if args.json else message,
              file=sys.stdout if args.json else sys.stderr)
        return 1

    # 选路：本地优先，本地不在才上云端，两边都没有退回内嵌文本。
    # `choose_source` 是纯函数，顺序由它一处决定（测试钉在那里）。
    source, why = choose_source(args.ocr, ocr_available(args.ocr_root), cloud_available())
    if not source:
        message = why
        print(json.dumps({'success': False, 'error': message}) if args.json else message,
              file=sys.stdout if args.json else sys.stderr)
        return 1
    use_ocr = source in ('local', 'cloud')
    if why and source != 'local':
        print('[OCR] %s' % why, file=sys.stderr)

    runnable, existing = [], []
    for pdf in pdfs:
        (runnable if args.refresh or not already_carded(pdf, args.out) else existing).append(pdf)
    runnable = runnable[:args.limit] if args.limit else runnable

    if args.dry_run:
        preview = {
            'success': True, 'dryRun': True, 'action': 'pdf-notes',
            'mode': 'ocr-only' if args.ocr_only else 'card',
            'pdfs': len(runnable),
            # 这次**实际**走哪条路：`auto` 的结果要报出来，否则用户以为"没上传"、
            # 实际页面图片已经出境了（云端那条的隐私差别就在这里）。
            'ocrSource': source, 'ocrWhy': why or None,
            'ocr': {'local': 'local', 'cloud': 'cloud', 'embedded': 'embedded-text'}[source],
            'ocrEngine': args.ocr_root if source == 'local' else None,
            'ocrModel': (args.ocr_model or DEFAULT_CLOUD_MODEL) if source == 'cloud' else None,
            'sendsImages': source == 'cloud',
            'alreadyCarded': len(existing),
            'model': None if args.ocr_only else 'DeepSeek（生成摘要与概念）',
            'calls': 0 if args.ocr_only else len(runnable),
            'readsLocalData': True, 'invokesAI': False, 'writesFiles': True,
            'note': ('只做 OCR、只写文字，不调用生成模型（%s）' % TEXT_ROOT
                     if args.ocr_only else
                     ('PDF 文字在本机 OCR（不出网）；每篇一次模型调用，同时问摘要与概念'
                      if source == 'local' else
                      'PDF **页面图片会发给云端**做 OCR；每篇另一次模型调用问摘要与概念'
                      if source == 'cloud' else
                      '只抽 PDF 内嵌文本（扫描件会读不出字）')),
        }
        if args.json:
            print(json.dumps(preview, ensure_ascii=False, indent=2))
        elif args.ocr_only:
            print('%d 个 PDF 只做识别（不出境、不花钱），文字写到 %s'
                  % (len(runnable), TEXT_ROOT))
            if existing:
                print('已有卡 %d 个（--ocr-only 不看卡片，照样识别）' % len(existing))
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

    if args.ocr_only:
        # 只识别、不调用模型：**零出境、零花费**，所以不需要 --yes，也不需要 API key。
        # 为什么值得单独一步：一本 300 页的书 OCR 要七八分钟，而调用只要几秒——
        # 把贵的、慢的、不出网的那一步单独跑完（可以挂着过夜），白天再出卡。
        updated = datetime.now(TZ).strftime('%Y-%m-%d %H:%M')
        written, failed = [], []
        for pdf in runnable:
            body, via = read_text_by_source(pdf, source, args)
            if not body:
                failed.append({'title': pdf.stem[:30], 'reason': via or 'no-text'})
                continue
            frontmatter = {
                'title': pdf.stem, 'type': 'pdf-text', 'source': pdf.name,
                'pages': pdf_page_count(pdf), 'text_via': via,
                'bodyChars': len(body), 'saved': updated, 'updated': updated,
            }
            target = note_path(TEXT_ROOT, pdf.stem)
            target.parent.mkdir(parents=True, exist_ok=True)
            write_with_frontmatter(str(target), frontmatter, body)
            written.append({'title': pdf.stem[:30], 'file': str(target), 'textVia': via,
                            'chars': len(body)})
        result = {'success': True, 'action': 'pdf-notes.ocr-only', 'model': None,
                  'ocrSource': source, 'ocrEngine': args.ocr_root if source == 'local' else None,
                  'written': written, 'failed': failed, 'pdfs': len(runnable),
                  'calls': 0, 'invokesAI': False}
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            for item in written:
                print('✓ %s（%d 字，来自 %s）→ %s'
                      % (item['title'], item['chars'], item['textVia'], item['file']))
            for item in failed:
                print('✗ %s：%s' % (item['title'], item['reason']), file=sys.stderr)
            print('\n共 %d 份文字 → %s（未调用模型，未出境）；之后可跑 pdf-notes 出卡'
                  % (len(written), TEXT_ROOT))
        return exit_code(len(written))

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
        body, via = read_text_by_source(pdf, source, args)
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
        'ocrSource': source, 'ocrEngine': args.ocr_root if source == 'local' else None,
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
