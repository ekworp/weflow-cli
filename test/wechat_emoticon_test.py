# -*- coding: utf-8 -*-
"""`wechat_emoticon` 的回归测试。

**两条纪律先说清楚**：

1. 纯逻辑（`derive_key` / `account_wxid` / `sniff` / 明文直通 / 读配置）在本进程里测。
2. **凡是需要真 AES 的，都放到子进程里测**（`CryptoScenarioTests`）。原因：本项目的
   全量 `unittest discover` 进程里，`cryptography` 的 Rust 扩展会在**第一次** import 时
   就抛 `PyO3 modules ... may only be initialized once per interpreter process`
   （同一个错也出现在 `_utils.decrypt_lock` 解 `typesafeApiKey` 的那条 WARN 上），
   于是 `wechat_emoticon._HAVE_CRYPTO` 为 False。若此时用 `skipTest`，那些测试
   **一条都不会跑，报告还显示 OK** —— 那是最糟的一种绿。子进程是干净的，
   也正是这些脚本在生产里的真实运行方式。

关于明文直通那条的定位：它是**防御性**的，本机实测不改变任何结果
（`sticker_cache_dirs()` 那 5 个目录里 202 个文件没有一个是明文；1,974 张明文图都在
表情缓存之外的 `cache/<月>/` 与 `WeAppIcon` 里）。所以那些用例钉的是"这个分支按设计
工作"，**不是**"它修好了一个观测到的故障"。
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       'scripts')
sys.path.insert(0, SCRIPTS)

import wechat_emoticon as E  # noqa: E402

PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 32
JPEG = b'\xff\xd8\xff\xe0' + b'\x00' * 32
GIF = b'GIF89a' + b'\x00' * 32

#: **预置密文**：`PNG + 64 字节零`（104 字节）用 `derive_key('123456789', 'wxid_demo')`
#: 做 AES-128-CBC(key, iv=key) + PKCS7 填充后的结果（112 字节）。
FIXTURE_SEED = '123456789'
FIXTURE_WXID = 'wxid_demo'
FIXTURE_KEY_HEX = 'ee92e2669d2b53283e5dbf56cbfd3100'
FIXTURE_CT_B64 = (
    'YNxSu/4qFlTitE2WlYpbswtc4p6hDLkGPRGfaGLmzjZafeoPQ5ZyTxyrIJZyomswbhpmvxzN02ydHLvMpuO9D'
    'JfYgEoU6SUgT05m9AnaIOHCW0nD3bOh5txE9EGwMqZpVinSRbgtzgkTjGutXRMTdg==')
FIXTURE_CT = base64.b64decode(FIXTURE_CT_B64)
#: 104 字节明文 + 8 字节 PKCS7 填充 = 112。`E.decrypt` 会去掉填充，所以解出来是 104。
FIXTURE_PLAIN_LEN = 104


def _write_sticker(root, md5_hex, payload):
    """按微信的目录形状放一个缓存文件：`<root>/<md5[:2]>/<md5>`。"""
    d = os.path.join(root, md5_hex[:2])
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, md5_hex)
    with open(path, 'wb') as fh:
        fh.write(payload)
    return path


class PlainStickerTests(unittest.TestCase):
    """缓存里已经是图的那批：不解密也要能读出来（明文路径不需要真解密，本进程测）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_plain_png_is_returned_with_a_wrong_key(self):
        md5 = 'aa' * 16
        _write_sticker(self.root, md5, PNG)
        data, mime = E.load_sticker([self.root], md5, b'\x00' * 16)
        self.assertEqual(mime, 'image/png')
        self.assertTrue(data.startswith(b'\x89PNG'))

    def test_plain_jpeg_is_returned_with_a_wrong_key(self):
        md5 = 'bb' * 16
        _write_sticker(self.root, md5, JPEG)
        _data, mime = E.load_sticker([self.root], md5, b'\x11' * 16)
        self.assertEqual(mime, 'image/jpeg')

    def test_plain_gif_is_returned(self):
        md5 = 'cc' * 16
        _write_sticker(self.root, md5, GIF)
        _data, mime = E.load_sticker([self.root], md5, b'\x22' * 16)
        self.assertEqual(mime, 'image/gif')

    def test_plain_image_needs_no_key_at_all(self):
        """没有 seed 时 `key` 是空的 —— 明文那批不该因此读不到。"""
        md5 = 'dd' * 16
        _write_sticker(self.root, md5, PNG)
        _data, mime = E.load_sticker([self.root], md5, b'')
        self.assertEqual(mime, 'image/png')

    def test_missing_file_is_still_empty(self):
        self.assertEqual(E.load_sticker([self.root], 'ee' * 16, b'\x00' * 16),
                         (b'', ''))

    def test_empty_md5_is_still_empty(self):
        self.assertEqual(E.load_sticker([self.root], '', b'\x00' * 16), (b'', ''))


class DeriveKeyTests(unittest.TestCase):
    def test_key_is_md5_of_seed_wxid_and_suffix(self):
        import hashlib
        seed, wxid = '12345678', 'wxid_demo'
        expect = hashlib.md5(('%s%sEMOTICON' % (seed, wxid)).encode()).digest()[:16]
        self.assertEqual(E.derive_key(seed, wxid), expect)
        self.assertEqual(len(E.derive_key(seed, wxid)), 16)

    def test_different_seed_gives_different_key(self):
        self.assertNotEqual(E.derive_key('1', 'wxid_x'), E.derive_key('2', 'wxid_x'))

    def test_account_dir_suffix_is_stripped(self):
        self.assertEqual(E.account_wxid('wxid_abc_4c8e'), 'wxid_abc')
        self.assertEqual(E.account_wxid('wxid_abc'), 'wxid_abc')
        # 后缀不是 4 位时不剥（宁可留原名，也不要猜错）
        self.assertEqual(E.account_wxid('wxid_abc_longer'), 'wxid_abc_longer')

    def test_fixture_key_matches_derive(self):
        """预置密文那把 key 必须真的等于 `derive_key(FIXTURE_SEED, FIXTURE_WXID)`。

        这条把夹具和被测公式绑在一起：公式一改，夹具立刻失效而不是悄悄测别的东西。
        """
        self.assertEqual(E.derive_key(FIXTURE_SEED, FIXTURE_WXID).hex(), FIXTURE_KEY_HEX)


class SniffTests(unittest.TestCase):
    def test_recognizes_the_magics_we_measured(self):
        self.assertEqual(E.sniff(PNG)[0], 'image/png')
        self.assertEqual(E.sniff(JPEG)[0], 'image/jpeg')
        self.assertEqual(E.sniff(GIF)[0], 'image/gif')
        self.assertEqual(E.sniff(b'wxgf\x00\x00')[0], 'image/hevc')

    def test_unknown_bytes_are_none(self):
        self.assertEqual(E.sniff(b'\x00\x01\x02\x03'), (None, None))
        self.assertEqual(E.sniff(b''), (None, None))


class SeedFromConfigTests(unittest.TestCase):
    """`emoticonSeed` 的读取本身不需要 AES，所以本进程测。"""

    def test_reads_the_key_and_strips(self):
        import unittest.mock as mock
        with mock.patch('_utils.load_config',
                        return_value={'emoticonSeed': '  87654321  '}):
            self.assertEqual(E.seed_from_config(), '87654321')

    def test_missing_key_is_empty(self):
        import unittest.mock as mock
        with mock.patch('_utils.load_config', return_value={}):
            self.assertEqual(E.seed_from_config(), '')

    def test_config_read_failure_does_not_crash(self):
        """读配置抛异常要返回空串（退回别的来源），不能把整条路带崩。"""
        import unittest.mock as mock
        with mock.patch('_utils.load_config', side_effect=OSError('boom')):
            self.assertEqual(E.seed_from_config(), '')


#: 在**干净子进程**里跑的场景脚本，输出一行 JSON。
_HELPER = r'''
import base64, json, os, sys, tempfile
sys.path.insert(0, os.environ['WEFLOW_TEST_SCRIPTS'])
import wechat_emoticon as E

PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 32
CT = base64.b64decode(os.environ['WEFLOW_TEST_CT'])
SEED = os.environ['WEFLOW_TEST_SEED']
WXID = os.environ['WEFLOW_TEST_WXID']
KEY = bytes.fromhex(os.environ['WEFLOW_TEST_KEY_HEX'])

out = {'haveCrypto': E._HAVE_CRYPTO}
tmp = tempfile.mkdtemp()

def sticker(md5, payload):
    d = os.path.join(tmp, md5[:2]); os.makedirs(d, exist_ok=True)
    p = os.path.join(d, md5)
    with open(p, 'wb') as fh: fh.write(payload)
    return p

# 1 对的 key 能解出图
sticker('ff' * 16, CT)
out['rightKeyMime'] = E.load_sticker([tmp], 'ff' * 16, KEY)[1]

# 2 错的 key 解不出（这是明文直通那条的对照，不能被顺手改坏）
sticker('12' * 16, CT)
out['wrongKeyEmpty'] = E.load_sticker([tmp], '12' * 16, b'\x99' * 16) == (b'', '')

# 3 全文件解密：以 PNG magic 开头、长度 = 明文长（填充已去掉）
raw = open(sticker('34' * 16, CT), 'rb').read()
plain = E.decrypt(raw, KEY)
out['plainLen'] = len(plain)
out['plainHead'] = plain[:3].hex()

# 4 seed_from_logs：对的能找到
logdir = os.path.join(tmp, 'logs', 'applet', 'usr', 'miniprogramLog')
os.makedirs(logdir, exist_ok=True)
sample = sticker('56' * 16, CT)
log1 = os.path.join(logdir, 'log1')
with open(log1, 'w', encoding='utf-8') as fh:
    fh.write('boot seed=%s\n' % SEED)
out['fromLogs'] = E.seed_from_logs(WXID, sample, roots=[os.path.join(tmp, 'logs')]) == SEED

# 5 错的数字不能被采信
with open(log1, 'w', encoding='utf-8') as fh:
    fh.write('boot seed=999999999\n')
out['wrongInLogsRejected'] = (
    E.seed_from_logs(WXID, sample, roots=[os.path.join(tmp, 'logs')]) is None)

# 6 混了坏字节的日志仍要被扫
with open(log1, 'wb') as fh:
    fh.write(b'\xff\xfe junk \x80 seed=' + SEED.encode() + b'\n')
out['badUtf8LogScanned'] = (
    E.seed_from_logs(WXID, sample, roots=[os.path.join(tmp, 'logs')]) == SEED)

# 7 只扫名字像 log 的文件
with open(os.path.join(logdir, 'config.json'), 'w', encoding='utf-8') as fh:
    fh.write('{"seed": "%s"}' % SEED)
os.remove(log1)
out['nonLogFileIgnored'] = (
    E.seed_from_logs(WXID, sample, roots=[os.path.join(tmp, 'logs')]) is None)

# 8 候选上限：上限 2 时第 3 个才是真 seed → 找不到
with open(log1, 'w', encoding='utf-8') as fh:
    fh.write('a=111111 b=222222 c=%s\n' % SEED)
out['capRespected'] = (
    E.seed_from_logs(WXID, sample, roots=[os.path.join(tmp, 'logs')],
                     max_candidates=2) is None)

# 9 resolve_seed 顺序：配置对 → config；配置错 → logs
out['sourceConfig'] = E.resolve_seed(WXID, sample, configured=SEED,
                                     log_roots=['/nonexistent'])[1]
out['sourceLogs'] = E.resolve_seed(WXID, sample, configured='999999999',
                                   log_roots=[os.path.join(tmp, 'logs')])[1]

# 10 三条来源都失败时给出 config-invalid（要能区分"配错了"和"什么都没配"）
out['sourceInvalid'] = E.resolve_seed(WXID, sample, configured='999999999',
                                      log_roots=['/nonexistent'])[1]

print(json.dumps(out))
'''


class CryptoScenarioTests(unittest.TestCase):
    """需要真 AES 的场景：放到**干净子进程**里跑。

    本进程的 `cryptography` 已被别的测试弄坏（见文件头），所以这里不 skip、也不假装
    测过——直接换一个干净解释器，那也是这些脚本在生产里的真实运行方式。
    """

    def test_scenarios_in_a_clean_interpreter(self):
        env = dict(os.environ)
        env.update({
            'WEFLOW_TEST_SCRIPTS': SCRIPTS,
            'WEFLOW_TEST_CT': FIXTURE_CT_B64,
            'WEFLOW_TEST_SEED': FIXTURE_SEED,
            'WEFLOW_TEST_WXID': FIXTURE_WXID,
            'WEFLOW_TEST_KEY_HEX': FIXTURE_KEY_HEX,
            'PYTHONIOENCODING': 'utf-8',
        })
        proc = subprocess.run([sys.executable, '-X', 'utf8', '-c', _HELPER],
                              capture_output=True, text=True, encoding='utf-8',
                              errors='replace', env=env, timeout=180)
        self.assertEqual(proc.returncode, 0,
                         '子进程失败：%s\n%s' % (proc.stdout[-600:], proc.stderr[-900:]))
        at = proc.stdout.find('{')
        self.assertGreaterEqual(at, 0, '子进程没输出 JSON：%s' % proc.stdout[-600:])
        got = json.loads(proc.stdout[at:])

        # 子进程里 cryptography 必须真的可用，否则下面每条都是在验空气
        self.assertTrue(got['haveCrypto'], '子进程也没有 cryptography，测试无意义')

        self.assertEqual(got['rightKeyMime'], 'image/png')
        self.assertTrue(got['wrongKeyEmpty'], '错的 key 必须解不出')
        self.assertEqual(got['plainLen'], FIXTURE_PLAIN_LEN,
                         '解开后应当是 %d 字节（填充已被去掉）' % FIXTURE_PLAIN_LEN)
        self.assertEqual(got['plainHead'], '89504e', '明文应以 PNG magic 开头')
        self.assertTrue(got['fromLogs'], '日志里放对的 seed 应当能找到')
        self.assertTrue(got['wrongInLogsRejected'], '日志里放错的数字不能被采信')
        self.assertTrue(got['badUtf8LogScanned'], '混了坏字节的日志仍要被扫')
        self.assertTrue(got['nonLogFileIgnored'], '只扫名字像 log 的文件')
        self.assertTrue(got['capRespected'], '候选上限要真的截断')
        self.assertEqual(got['sourceConfig'], 'config')
        self.assertEqual(got['sourceLogs'], 'logs')
        self.assertEqual(got['sourceInvalid'], 'config-invalid')


if __name__ == '__main__':
    unittest.main()
