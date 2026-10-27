# -*- coding: utf-8 -*-
"""`wechat_emoticon.load_sticker` 的回归测试。

**先说清这批测试的定位**：`sniff(raw)` 先跑那一步是**防御性**的，本机实测不改变任何
结果——`sticker_cache_dirs()` 那 5 个目录里 202 个文件没有一个是明文。
（我一度把 `cache/<月>/` 下的消息媒体当成表情缓存，数出"502 张明文表情读不到"，
那是错的；明文图 1,974 张全在表情缓存之外。）
所以下面这些用例钉的是"这个分支按设计工作"，**不是**"它修好了一个观测到的故障"。

判据用"**错误的 key 也必须能读出明文图**"：如果代码偷偷先解密，坏 key 必然解不出。
加密那批则相反（只有对的 key 解得开），那是不能被顺手改坏的对照。
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                'scripts'))

import wechat_emoticon as E  # noqa: E402

PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 32
JPEG = b'\xff\xd8\xff\xe0' + b'\x00' * 32
GIF = b'GIF89a' + b'\x00' * 32


def _write_sticker(root, md5_hex, payload):
    """按微信的目录形状放一个缓存文件：`<root>/<md5[:2]>/<md5>`。"""
    d = os.path.join(root, md5_hex[:2])
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, md5_hex)
    with open(path, 'wb') as fh:
        fh.write(payload)
    return path


class PlainStickerTests(unittest.TestCase):
    """缓存里已经是图的那批：不解密也要能读出来。"""

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


class EncryptedStickerTests(unittest.TestCase):
    """加密那批：只有**对的** key 才解得开（这条是上个修复的对照，不能被顺手改坏）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        try:
            from cryptography.hazmat.primitives import padding
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        except ImportError:
            self.skipTest('没有 cryptography，跳过加密路径')
        self._pad = padding
        self._Cipher = Cipher
        self._algorithms = algorithms
        self._modes = modes

    def tearDown(self):
        self.tmp.cleanup()

    def _encrypt(self, plain, key):
        """与 `decrypt` 对称：AES-128-CBC，IV = key。"""
        padder = self._pad.PKCS7(128).padder()
        body = padder.update(plain) + padder.finalize()
        enc = self._Cipher(self._algorithms.AES(key),
                           self._modes.CBC(key)).encryptor()
        return enc.update(body) + enc.finalize()

    def test_right_key_decrypts(self):
        key = bytes(range(16))
        md5 = 'ff' * 16
        # 用长度足够的内容，`decrypt` 对 <32 字节直接返回空
        _write_sticker(self.root, md5, self._encrypt(PNG + b'\x00' * 64, key))
        data, mime = E.load_sticker([self.root], md5, key)
        self.assertEqual(mime, 'image/png')
        self.assertTrue(data.startswith(b'\x89PNG'))

    def test_wrong_key_returns_nothing(self):
        key = bytes(range(16))
        md5 = '12' * 16
        _write_sticker(self.root, md5, self._encrypt(PNG + b'\x00' * 64, key))
        self.assertEqual(E.load_sticker([self.root], md5, b'\x99' * 16), (b'', ''))


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


class SniffTests(unittest.TestCase):
    def test_recognizes_the_magics_we_measured(self):
        self.assertEqual(E.sniff(PNG)[0], 'image/png')
        self.assertEqual(E.sniff(JPEG)[0], 'image/jpeg')
        self.assertEqual(E.sniff(GIF)[0], 'image/gif')
        self.assertEqual(E.sniff(b'wxgf\x00\x00')[0], 'image/hevc')

    def test_unknown_bytes_are_none(self):
        self.assertEqual(E.sniff(b'\x00\x01\x02\x03'), (None, None))
        self.assertEqual(E.sniff(b''), (None, None))


class SeedResolutionTests(unittest.TestCase):
    """`emoticonSeed` 配置 → seed 候选链。

    这个键以前**没有任何读取方**（能 `config set`，但设了等于没设），现在接回候选链
    的第一位。**关键判据：配置里的值必须被证明，不能直接采用**——否则一个过期的值会
    让整条路静默解不开，而用户以为自己已经配好了。
    """

    SEED = '12345678'
    WXID = 'wxid_demo'

    def setUp(self):
        try:
            from cryptography.hazmat.primitives import padding
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        except ImportError:
            self.skipTest('没有 cryptography，跳过')
        self._pad, self._Cipher = padding, Cipher
        self._algorithms, self._modes = algorithms, modes
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def _sample_encrypted_with(self, seed):
        """写一个用 `derive_key(seed, wxid)` 加密的样本文件，返回它的路径。"""
        key = E.derive_key(seed, self.WXID)
        padder = self._pad.PKCS7(128).padder()
        body = padder.update(PNG + b'\x00' * 64) + padder.finalize()
        enc = self._Cipher(self._algorithms.AES(key),
                           self._modes.CBC(key)).encryptor()
        payload = enc.update(body) + enc.finalize()
        path = os.path.join(self.tmp.name, 'sample')
        with open(path, 'wb') as fh:
            fh.write(payload)
        return path

    def test_configured_seed_is_used_when_it_proves_out(self):
        sample = self._sample_encrypted_with(self.SEED)
        seed, source = E.resolve_seed(self.WXID, sample, configured=self.SEED)
        self.assertEqual(seed, self.SEED)
        self.assertEqual(source, 'config')

    def test_wrong_configured_seed_is_not_trusted(self):
        """配置里是错值时必须退回内存路径，而不是直接采信。"""
        sample = self._sample_encrypted_with(self.SEED)
        seed, source = E.resolve_seed(self.WXID, sample, configured='99999999')
        # 内存里扫不到（微信没运行/pymem 不在），所以最终没有 seed
        self.assertIsNone(seed)
        self.assertEqual(source, 'config-invalid',
                         '配置值无效要能区分出来，不能和"什么都没配"混成一句话')

    def test_no_configured_seed_and_no_memory_means_none(self):
        sample = self._sample_encrypted_with(self.SEED)
        seed, source = E.resolve_seed(self.WXID, sample, configured='')
        self.assertIsNone(seed)
        self.assertIsNone(source)

    def test_seed_from_config_reads_the_key_and_strips(self):
        """读配置失败不该崩；读到就去空白。"""
        import unittest.mock as mock
        fake_cfg = {'emoticonSeed': '  87654321  '}
        with mock.patch.dict('sys.modules', {}):
            with mock.patch('_utils.load_config', return_value=fake_cfg):
                self.assertEqual(E.seed_from_config(), '87654321')
        # 缺这个键 = 空串
        with mock.patch('_utils.load_config', return_value={}):
            self.assertEqual(E.seed_from_config(), '')
        # 读配置抛异常也要返回空串（退回扫内存），不能把整条路带崩
        with mock.patch('_utils.load_config', side_effect=OSError('boom')):
            self.assertEqual(E.seed_from_config(), '')


if __name__ == '__main__':
    unittest.main()
