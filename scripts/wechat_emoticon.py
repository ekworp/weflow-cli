#!/usr/bin/env python3
"""Decrypt WeChat custom stickers (表情包) from the local cache.

WeChat 4.x keeps stickers in `cache/YYYY-MM/Emoticon/<md5[:2]>/<md5>` and
`business/emoticon/{Persist,Thumb,...}`. Each file is AES-128-CBC with the key
also used as the IV, where

    key = md5(f"{seed}{wxid}EMOTICON")[:16]

`seed` is a per-account constant held in WeChat's process memory (see
find_seed). Once known it is stable, so it only has to be scanned for once.

Most cached stickers are WeChat's own `wxgf` container - a small header
followed by a raw H.265 stream - which needs ffmpeg to turn into an image.
Decoded results are cached on disk because that is the expensive step.

Reference: CN-Grace/Wechat-Emoticon-Parser (v4.0-plus branch).
"""
import glob
import hashlib
import os
import re
import subprocess
import sys
import tempfile

# 手跑或被重定向时 stdout 走本机编码（Windows 是 GBK）：非 GBK 字符（本文件里的 `✓`）会
# UnicodeEncodeError、整次输出没了；桥接跑有 PYTHONIOENCODING=utf-8 所以看不出来。
# 这条让两条路的输出一致（同 docs/EXTENDING.md Recipe E，守它的测试是 test/script_stdout_encoding_test.py）。
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

try:
    from cryptography.hazmat.primitives import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    _HAVE_CRYPTO = True
except ImportError:
    _HAVE_CRYPTO = False

try:
    import zstandard
    _HAVE_ZSTD = True
except ImportError:
    _HAVE_ZSTD = False

IMAGE_MAGICS = (
    (b'\x89PNG', 'image/png', '.png'),
    (b'\xff\xd8\xff', 'image/jpeg', '.jpg'),
    (b'GIF8', 'image/gif', '.gif'),
    (b'RIFF', 'image/webp', '.webp'),
    (b'wxgf', 'image/hevc', '.hevc'),
)


def derive_key(seed, wxid):
    """Cache key for an account. Returns 16 bytes."""
    return hashlib.md5(f'{seed}{wxid}EMOTICON'.encode()).digest()[:16]


def account_wxid(account_dir_name):
    """`wxid_账号A_后缀` -> `wxid_账号A`."""
    parts = account_dir_name.rsplit('_', 1)
    return parts[0] if len(parts) == 2 and len(parts[1]) == 4 else account_dir_name


def decrypt(raw, key):
    """AES-128-CBC(key=IV) with PKCS7. Returns plaintext (best effort)."""
    if not _HAVE_CRYPTO or not raw or len(raw) < 32:
        return b''
    body = raw[:len(raw) // 16 * 16]
    dec = Cipher(algorithms.AES(key), modes.CBC(key)).decryptor()
    out = dec.update(body) + dec.finalize()
    try:
        unp = padding.PKCS7(128).unpadder()
        return unp.update(out) + unp.finalize()
    except Exception:
        return out


def sniff(data):
    """(mime, extension) for decrypted bytes, or (None, None)."""
    for magic, mime, ext in IMAGE_MAGICS:
        if data.startswith(magic):
            return mime, ext
    return None, None


def find_seed_candidates():
    """Decimal strings scraped from WeChat's process memory (seed candidates)."""
    try:
        import ctypes
        from ctypes import (byref, c_size_t, c_void_p, create_string_buffer,
                            sizeof, wintypes)
        import pymem
        import re as _re
    except ImportError:
        return []

    class MBI(ctypes.Structure):
        _fields_ = [
            ('BaseAddress', ctypes.c_void_p), ('AllocationBase', ctypes.c_void_p),
            ('AllocationProtect', wintypes.DWORD), ('PartitionId', wintypes.WORD),
            ('RegionSize', ctypes.c_size_t), ('State', wintypes.DWORD),
            ('Protect', wintypes.DWORD), ('Type', wintypes.DWORD),
        ]

    k32 = ctypes.windll.kernel32
    rpm = k32.ReadProcessMemory
    rpm.argtypes = [wintypes.HANDLE, wintypes.LPCVOID, wintypes.LPVOID,
                    ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    vqe = k32.VirtualQueryEx
    vqe.argtypes = [wintypes.HANDLE, wintypes.LPCVOID, ctypes.c_void_p, ctypes.c_size_t]
    vqe.restype = ctypes.c_size_t

    pid = None
    for p in pymem.process.list_processes():
        try:
            name = p.szExeFile
            if isinstance(name, bytes):
                name = name.decode('utf-8', 'ignore')
            if name.lower() == 'weixin.exe':
                pid = p.th32ProcessID
                break
        except Exception:
            pass
    if not pid:
        return []

    h = k32.OpenProcess(0x0010 | 0x0400, False, pid)
    if not h:
        return []

    pat = _re.compile(rb'\d{5,20}')
    seen = set()
    addr = 0x10000
    try:
        while addr < 0x7FFFFFFFFFFF:
            mbi = MBI()
            if vqe(h, c_void_p(addr), byref(mbi), sizeof(mbi)) == 0:
                break
            ba, rs = mbi.BaseAddress or 0, mbi.RegionSize or 0
            if rs == 0:
                break
            if (mbi.State == 0x1000 and 256 < rs < 200 * 1024 * 1024
                    and mbi.Protect not in (0, 0x01, 0x100)):
                pos, end = ba, ba + rs
                while pos < end:
                    n = min(65536, end - pos)
                    buf = create_string_buffer(n)
                    br = c_size_t(0)
                    if rpm(h, c_void_p(pos), buf, n, byref(br)) and br.value:
                        for m in pat.finditer(buf.raw[:br.value]):
                            s = m.group(0).decode()
                            if s not in seen:
                                seen.add(s)
                                yield s
                    pos += 65536
            addr = ba + rs
    finally:
        k32.CloseHandle(h)


def _sample_head(sample_file, n=64):
    """样本文件的前 `n` 字节。以前每处各写一遍 `open(...).read()`（句柄不关）。"""
    if not sample_file:
        return b''
    try:
        with open(sample_file, 'rb') as fh:
            return fh.read(n)
    except OSError:
        return b''


def find_seed(wxid, sample_file, candidates=None):
    """The seed that decrypts `sample_file`, or None.

    Proven per candidate by decrypting the sample and looking for a known
    image magic - so a false positive is essentially impossible.

    `candidates` 给了就只试这些；**空列表等同于没给**（会退回扫内存）。
    """
    raw = _sample_head(sample_file)
    if not raw:
        return None
    for seed in (candidates if candidates else find_seed_candidates()):
        if sniff(decrypt(raw, derive_key(seed, wxid)))[0]:
            return seed
    return None


#: 种子候选的最大数量。实测（2026-10-28）101 个日志 5.1 MB 里只有 **3479** 个唯一
#: 数字串，测试阶段 <0.1 s；这个上限是给"日志被灌爆"的异常情况兜底的。
SEED_LOG_MAX_CANDIDATES = 200_000
#: 单个日志文件的读取上限（再大就不是日志了）。
SEED_LOG_MAX_BYTES = 4 * 1024 * 1024

_SEED_DIGITS = re.compile(r'\d{5,20}')


def emoticon_log_roots():
    """微信写日志的目录（seed 会出现在里面）。

    实测位置（2026-10-28）：
    `%APPDATA%\\Tencent\\xwechat\\radium\\users\\<hash>\\applet\\local\\<appid>\\usr\\miniprogramLog\\log1..5`

    也就是说 **seed 会落在一个小程序的日志里**。这不好看，但比扫内存好：
    不需要微信正在运行。日志会被轮转/清理，所以这只是**一条**来源，不是保证。
    """
    roots = []
    appdata = os.environ.get('APPDATA') or ''
    if appdata:
        base = os.path.join(appdata, 'Tencent', 'xwechat')
        if os.path.isdir(base):
            roots.append(base)
    # 让测试与别的安装布局能覆盖它（冒号分隔）
    extra = os.environ.get('WEFLOW_EMOTICON_LOG_DIRS') or ''
    for piece in extra.split(os.pathsep):
        piece = piece.strip()
        if piece and os.path.isdir(piece):
            roots.append(piece)
    return roots


def _iter_log_files(roots):
    """`roots` 下所有看起来是日志的文件（按名字像 `log`，且不太大）。"""
    for root in roots:
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                lower = name.lower()
                if not lower.startswith('log'):
                    continue
                path = os.path.join(dirpath, name)
                try:
                    if os.path.getsize(path) > SEED_LOG_MAX_BYTES:
                        continue
                except OSError:
                    continue
                yield path


def seed_from_logs(wxid, sample_file, roots=None,
                   max_candidates=SEED_LOG_MAX_CANDIDATES):
    """从微信的**日志文件**里找 seed。找到返回 seed，否则 None。

    为什么这条路值得有：内存扫描要求微信**正在运行**，而日志一直在磁盘上。
    判据与 `find_seed` 完全相同（拿候选去解样本、看能否解出图片 magic），
    所以**命中即真 seed**，代价只是把日志里的数字串过一遍。

    实测（2026-10-28，本机）：101 个日志 / 5.1 MB / 3479 个唯一候选，
    提取 0.1 s、测试 <0.1 s 就命中；跨样本验证 359/359 全部解开，
    而把 seed 改一位的 26 个变体一个都解不出。

    **限界**：日志会被轮转/清理，`log1..5` 之后老的可能被删——所以它不是永久来源；
    找到之后应当存进 `emoticonSeed`（`resolve_seed` 会提示）。
    """
    raw = _sample_head(sample_file)
    if not raw:
        return None
    seen = set()
    for path in _iter_log_files(roots if roots is not None else emoticon_log_roots()):
        try:
            with open(path, 'rb') as fh:
                blob = fh.read()
        except OSError:
            continue
        # 日志不保证是纯 UTF-8（可能混了截断的多字节），所以要 errors='ignore'：
        # 用严格解码会整份跳过，而 seed 可能就在这一份里
        for match in _SEED_DIGITS.finditer(blob.decode('utf-8', 'ignore')):
            candidate = match.group(0)
            if candidate in seen:
                continue
            seen.add(candidate)
            if sniff(decrypt(raw, derive_key(candidate, wxid)))[0]:
                return candidate
            if len(seen) >= max_candidates:
                return None
    return None


def _ffmpeg_exe():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


_FFMPEG = None
_FFMPEG_CHECKED = False


WXGF_MAX_FRAMES = 4

# Below this share of non-dominant pixels a frame is treated as blank rather
# than as artwork. Line drawings on white still score well above it; the blank
# transition frames and truncated payloads sit at essentially 0.
BLANK_FRAME_SCORE = 0.005

# Animation output. The page shows a sticker at ~240px, and uncapped frame
# rates on a 50-frame clip produce a multi-megabyte GIF.
GIF_MAX_SIDE = 240
GIF_FPS = 10


def _frame_score(path):
    """How much artwork a decoded frame carries, in [0, 1].

    The share of pixels that are not the frame's dominant colour. Sticker
    streams routinely open with a blank transition frame, which scores ~0.01
    while the drawn frame scores several times that.
    """
    try:
        from PIL import Image
        from collections import Counter
    except ImportError:
        return None
    try:
        with Image.open(path) as image:
            pixels = list(image.convert('RGB').getdata())
        if not pixels:
            return 0.0
        dominant = Counter(pixels).most_common(1)[0][1]
        return 1.0 - dominant / len(pixels)
    except Exception:
        return None


def _encode_animated_gif(source, target):
    """Animated GIF from an H.265 stream, scaled for a chat bubble.

    The stream is a sticker animation, not a still. Frames are capped at
    `GIF_FPS` and `GIF_MAX_SIDE`, and quantised through a generated palette -
    without that a 50-frame clip runs to megabytes instead of a few hundred KB.
    """
    try:
        subprocess.run(
            [_FFMPEG, '-y', '-loglevel', 'error', '-f', 'hevc', '-i', source,
             '-vf', (f'fps={GIF_FPS},scale={GIF_MAX_SIDE}:-1:flags=lanczos,'
                     'split[a][b];[a]palettegen[p];[b][p]paletteuse'),
             '-loop', '0', target],
            capture_output=True, timeout=120,
        )
        return os.path.isfile(target) and os.path.getsize(target) > 0
    except Exception:
        return False


def decode_wxgf(data):
    """A `wxgf` payload as image bytes (animated GIF or PNG), or b''.

    The container is 'wxgf' + a small header, then a raw H.265 stream. Multi
    frame streams are sticker animations and are re-encoded as an animated GIF;
    taking a single frame from those - which is what this used to do - shows a
    still of what the sender saw moving.

    Single frame streams are handled by picking the frame with the most
    artwork rather than frame 1: many begin with a blank transition frame, so
    frame 1 yields a white square.
    """
    global _FFMPEG, _FFMPEG_CHECKED
    if not _FFMPEG_CHECKED:
        _FFMPEG = _ffmpeg_exe()
        _FFMPEG_CHECKED = True
    if not _FFMPEG:
        return b''
    tmp_in = None
    tmp_dir = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.hevc', delete=False) as fh:
            fh.write(data[4:])
            tmp_in = fh.name
        tmp_dir = tempfile.mkdtemp(prefix='weflow-wxgf-')
        # Probe the frame count cheaply: all frames, no scaling.
        subprocess.run(
            [_FFMPEG, '-y', '-loglevel', 'error', '-f', 'hevc', '-i', tmp_in,
             '-vsync', '0', os.path.join(tmp_dir, 'f%04d.png')],
            capture_output=True, timeout=120,
        )
        frames = sorted(glob.glob(os.path.join(tmp_dir, 'f*.png')))
        if not frames:
            return b''
        if len(frames) > 1:
            gif_path = os.path.join(tmp_dir, 'anim.gif')
            if _encode_animated_gif(tmp_in, gif_path):
                with open(gif_path, 'rb') as fh:
                    return fh.read()
            # Fall through to a still frame if the animation could not be built.
        best = frames[0]
        best_score = None
        for frame in frames[:WXGF_MAX_FRAMES]:
            score = _frame_score(frame)
            if score is None:
                break
            if best_score is None or score > best_score:
                best, best_score = frame, score
        # Every frame blank means the cached payload is not decodable (a
        # truncated download, typically). Report failure so the caller tries
        # another source rather than embedding a white square.
        if best_score is not None and best_score < BLANK_FRAME_SCORE:
            return b''
        with open(best, 'rb') as fh:
            return fh.read()
    except Exception:
        return b''
    finally:
        if tmp_in:
            try:
                os.remove(tmp_in)
            except OSError:
                pass
        if tmp_dir:
            import shutil
            shutil.rmtree(tmp_dir, ignore_errors=True)


def load_sticker(cache_dirs, md5_hex, key, decode_cache_dir=''):
    """(image bytes, mime) for a sticker by md5, or (b'', '').

    Decoding wxgf needs ffmpeg and is slow, so results are cached under
    `decode_cache_dir` keyed by md5.

    **`sniff(raw)` 先跑，认得出就不解密。** 这是**防御性**的一步，本机实测它不改变
    任何结果——2026-10-27 数过：`sticker_cache_dirs()` 那 5 个目录里 202 个文件
    **没有一个是明文**（全是解不开的 `<other>`）；1,974 张明文图（JPEG 1220 / PNG 727 /
    HEIC 15 / GIF 11 / WebP 1）都在表情缓存**之外**（`cache/<月>/` 的消息媒体、
    `WeAppIcon` 的小程序图标）。
    留着它的理由不是"修好了什么"，而是：本函数的 `decode_cache_dir` 那一支已经
    把"磁盘上直接 sniff 出图"当成合法状态，源文件这一支跟它保持一致；而且别的
    版本/账号把明文放在这儿时不必先有 seed。
    **别把这段注释读成"这里曾经读不到明文表情"——那句话是错的，我一度写错过。**
    """
    if not md5_hex:
        return b'', ''
    if decode_cache_dir:
        cached = os.path.join(decode_cache_dir, md5_hex)
        if os.path.isfile(cached):
            try:
                with open(cached, 'rb') as fh:
                    data = fh.read()
                mime, _ = sniff(data)
                if mime:
                    return data, mime
            except OSError:
                pass

    src = ''
    for base in cache_dirs:
        candidate = os.path.join(base, md5_hex[:2], md5_hex)
        if os.path.isfile(candidate):
            src = candidate
            break
    if not src:
        return b'', ''

    try:
        with open(src, 'rb') as fh:
            raw = fh.read()
    except OSError:
        return b'', ''

    # ① 原文就是图（或本来就是 wxgf 容器）→ 不解密
    mime, _ = sniff(raw)
    if mime == 'image/hevc':
        data = decode_wxgf(raw)
        mime = sniff(data)[0] or ''
    elif mime:
        data = raw
    else:
        # ② 认不出才解密（需要 key）
        if not key:
            return b'', ''
        data = decrypt(raw, key)
        mime, _ = sniff(data)
        if mime == 'image/hevc':
            # Re-sniff rather than assuming PNG: an animated stream decodes to a
            # GIF, and labelling that `image/png` sent it down the JPEG path
            # downstream, flattening the animation this was meant to preserve.
            data = decode_wxgf(data)
            mime = sniff(data)[0] or ''
    if not mime:
        return b'', ''

    # Sticker art is often 512-1024px; the reader renders it at ~240px, so
    # embedding it untouched is pure weight.
    try:
        from wechat_image import shrink
        data, mime = shrink(data, mime, max_side=360)
    except Exception:
        pass

    if decode_cache_dir and data:
        try:
            os.makedirs(decode_cache_dir, exist_ok=True)
            with open(os.path.join(decode_cache_dir, md5_hex), 'wb') as fh:
                fh.write(data)
        except OSError:
            pass
    return data, mime


def sticker_cache_dirs(account_root):
    """Where WeChat stores cached stickers for this account."""
    dirs = []
    cache_root = os.path.join(account_root, 'cache')
    if os.path.isdir(cache_root):
        for month in sorted(os.listdir(cache_root)):
            d = os.path.join(cache_root, month, 'Emoticon')
            if os.path.isdir(d):
                dirs.append(d)
    for sub in ('Persist', 'Thumb', 'Temp'):
        d = os.path.join(account_root, 'business', 'emoticon', sub)
        if os.path.isdir(d):
            dirs.append(d)
    return dirs


def any_sticker_file(dirs):
    """Some cached sticker, used as the verification sample."""
    for base in dirs:
        for sub in sorted(os.listdir(base)) if os.path.isdir(base) else []:
            path = os.path.join(base, sub)
            if os.path.isdir(path):
                for name in sorted(os.listdir(path)):
                    f = os.path.join(path, name)
                    if os.path.isfile(f) and os.path.getsize(f) > 32:
                        return f
    return ''


def seed_from_config():
    """`config set emoticonSeed <值>` 存下来的 seed；没配返回 `''`。

    这个配置键**一直在 `configurableKeys` 里、可以设置**，但以前**没有任何读取方**——
    用户设了它，程序照样每次扫内存，等于静默无效（和已删掉的 `cacheDbEnabled`
    是同一类问题）。这里把它接回候选链的第一位。

    **读出来不等于信它**：调用方必须仍用 `find_seed` 去证明（解密样本看 magic），
    因为配置里可能是个过期的/别人的值。`emoticonSeed` 不在 `ENCRYPTED_KEYS` 里，
    所以磁盘上是明文。
    """
    try:
        from _utils import load_config
        cfg = load_config() or {}
        return str(cfg.get('emoticonSeed') or '').strip()
    except Exception:
        # 读不到配置不该让整条路崩；返回空串 = 退回扫内存
        return ''


def resolve_seed(wxid, sample_file, configured=None, log_roots=None):
    """按 **配置 → 日志 → 内存** 的顺序找 seed。返回 `(seed, source)`。

    `source` ∈ `'config'` / `'logs'` / `'memory'` / `'config-invalid'` / `None`。
    把来源说出来是为了让调用方能给出**不同的下一步**：
      · `config` —— 什么都没扫，可以直接用；
      · `logs` —— 没扫内存，但这个值**该存进配置**（日志会被轮转）；
      · `memory` —— 扫了内存才拿到，同样该存配置；
      · `config-invalid` —— 配置里那个值是错的，**要清掉**，否则每次都会白试一遍。

    三条来源都用同一个判据证明（解密样本、看能否解出图片 magic），
    所以配置里的过期值不会静默生效，日志里的数字也不会被误当 seed。
    """
    candidate = configured if configured is not None else seed_from_config()
    invalid_configured = False
    if candidate:
        if find_seed(wxid, sample_file, candidates=[candidate]):
            return candidate, 'config'
        invalid_configured = True

    from_logs = seed_from_logs(wxid, sample_file, roots=log_roots)
    if from_logs:
        return from_logs, 'logs'

    found = find_seed(wxid, sample_file)
    if found:
        return found, 'memory'
    return None, ('config-invalid' if invalid_configured else None)


def _main():
    import argparse
    ap = argparse.ArgumentParser(description='WeChat sticker cache helper')
    ap.add_argument('--find-seed', metavar='ACCOUNT_ROOT',
                    help='Scan WeChat memory for the sticker seed of this account')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    if not args.find_seed:
        ap.print_help()
        return

    account_root = args.find_seed
    wxid = account_wxid(os.path.basename(os.path.normpath(account_root)))
    dirs = sticker_cache_dirs(account_root)
    sample = any_sticker_file(dirs)
    if not sample:
        print('未找到可用的表情缓存文件，请先在微信里查看几个表情包')
        return

    seed, source = resolve_seed(wxid, sample)
    if not seed:
        if source == 'config-invalid':
            print('配置里的 emoticonSeed 解不开样本，且内存里也没扫到。'
                  '请确认微信正在运行、并曾在微信里查看过表情包；'
                  '或清掉它：weflow-cli config set emoticonSeed ""')
        else:
            print('未找到 seed：日志里没扫到、内存也没扫到。')
            print('  若微信确实在运行，本进程的**进程视图可能被隔离**'
                  '（沙箱/容器里常常连 System/lsass 都看不到）——')
            print('  这时内存扫描必然失败，而"扫不到"并不代表微信没在运行。')
            print('  两条替代：① 让微信里打开一次表情包，日志里会带上 seed；'
                  '② 从别处拿到 seed 后 weflow-cli config set emoticonSeed <值>')
        return

    import json as _json
    if args.json:
        print(_json.dumps({'success': True, 'seed': seed, 'wxid': wxid,
                           'sample': sample, 'seedSource': source}))
    else:
        print(f'✓ seed = {seed}')
        print(f'  账号: {wxid}')
        print(f'  样本: {sample}')
        # 说出 seed 是哪来的：这条决定用户的下一步（要不要存起来 / 要不要清掉）
        if source == 'config':
            print('  来源: 配置 emoticonSeed（本次**没有**扫内存、也没读日志）')
        elif source == 'logs':
            print('  来源: 微信日志（本次**没有**扫内存，微信不必在运行）')
            print(f'  日志会被轮转，建议存下来：weflow-cli config set emoticonSeed {seed}')
        else:
            print('  来源: 内存扫描')
            print(f'  想省掉以后每次的内存扫描：weflow-cli config set emoticonSeed {seed}')


if __name__ == '__main__':
    _main()
