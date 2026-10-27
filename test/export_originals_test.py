"""`--save-originals`: originals on disk, thumbnails in the bubble, click-through.

Separate file from the rendering tests on purpose: those 31 stay untouched and
guard the behaviour this feature is layered on. Nothing here touches a real
WeChat directory - every source file is a temp-dir synthetic.
"""
import base64
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'export_chat_html.py'
spec = importlib.util.spec_from_file_location('export_chat_html_originals', SCRIPT)
export = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'sqlcipher3': types.SimpleNamespace(dbapi2=sqlite3)}):
    spec.loader.exec_module(export)

GIF = b'GIF89a' + b'\x00' * 16 + b'original-pixels'
MD5 = 'b' * 32


def item(local_id=7, create_time=1_700_000_000, media_key=None, media_md5s=None):
    """One formatted message, shaped like `format_message` returns it."""
    blob = base64.b64encode(GIF).decode()
    return {
        'local_id': local_id,
        'create_time': create_time,
        'image_b64': blob,
        'media': {'mediaKey': media_key or f'pair:{local_id}:{create_time}',
                  'kind': 'image'},
        'media_md5s': list(media_md5s or []),
        'sender': '联系人A',
        'is_self': False,
        'display': f'<img src="data:image/gif;base64,{blob}" loading="lazy" />',
    }


class OriginalTests(unittest.TestCase):
    def setUp(self):
        export.ORIGINAL_STATE.update({
            'paths': {}, 'by_digest': {}, 'v2_key': None, 'dir': '',
            'saved': 0, 'reused': 0, 'failed': 0,
        })

    def source(self, directory, name='source.dat', payload=GIF):
        path = Path(directory) / name
        path.write_bytes(payload)
        return str(path)

    def test_the_original_is_written_once_and_reused_for_a_repeated_photo(self):
        """A forwarded picture is one file on disk, not one per message."""
        with tempfile.TemporaryDirectory() as directory:
            path = self.source(directory)
            export.remember_original('pair:7:1700000000', path, 'cache-image')
            first, second = item(), item()

            assets = export.save_originals([first, second], directory, '示例群')

            self.assertEqual(first['original_status'], 'saved')
            self.assertEqual(second['original_status'], 'reused')
            self.assertEqual(first['original_rel'], second['original_rel'])
            # Content-addressed and relative to the page, not an absolute path.
            self.assertRegex(first['original_rel'],
                             r'^示例群_assets/originals/img_[0-9a-f]{12}\.gif$')
            written = sorted(p.name for p in Path(assets).iterdir())
            self.assertEqual(len(written), 1)
            self.assertEqual((Path(assets) / written[0]).read_bytes(), GIF)
            self.assertEqual(export.original_summary(), {'saved': 1, 'reused': 1, 'failed': 0})

    def test_a_second_run_reuses_the_file_instead_of_rewriting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.source(directory)
            export.remember_original('pair:7:1700000000', path, 'cache-image')
            first = item()
            export.save_originals([first], directory, '示例群')
            stored = Path(directory) / first['original_rel']
            before = stored.stat().st_mtime_ns

            again = item()
            export.save_originals([again], directory, '示例群')

            self.assertEqual(again['original_status'], 'reused')
            self.assertEqual(again['original_rel'], first['original_rel'])
            self.assertEqual(stored.stat().st_mtime_ns, before)

    def test_a_thumbnail_is_reported_rather_than_saved_as_an_original(self):
        """120-210px is what the bubble already shows; naming it "original" lies."""
        with tempfile.TemporaryDirectory() as directory:
            path = self.source(directory)
            export.remember_original('pair:7:1700000000', path, 'thumb')
            message = item()

            assets = export.save_originals([message], directory, '示例群')

            self.assertEqual(message['original_status'], 'thumbnail-only')
            self.assertIsNone(message.get('original_rel'))
            self.assertFalse(Path(assets).exists())

    def test_an_original_the_cache_never_had_says_so(self):
        with tempfile.TemporaryDirectory() as directory:
            message = item()
            export.save_originals([message], directory, '示例群')
            self.assertEqual(message['original_status'], 'not-in-local-cache')

    def test_the_message_md5_finds_an_original_the_cache_key_did_not(self):
        """A cache thumb plus an account original: only the md5 links the two."""
        with tempfile.TemporaryDirectory() as directory:
            path = self.source(directory)
            export.remember_original(f'md5:{MD5}', path, 'account')
            message = item(media_key='unindexed-local', media_md5s=[MD5])

            export.save_originals([message], directory, '示例群')

            self.assertEqual(message['original_status'], 'saved')

    def test_an_xor_obfuscated_source_is_decoded_before_it_is_saved(self):
        """The account index stores obfuscated payloads; the copy must be readable."""
        with tempfile.TemporaryDirectory() as directory:
            key = 0x37
            obfuscated = bytes(value ^ key for value in GIF)
            path = self.source(directory, 'obfuscated.dat', obfuscated)
            export.remember_original('pair:7:1700000000', path, 'account')
            message = item()

            assets = export.save_originals([message], directory, '示例群')

            saved = Path(assets) / Path(message['original_rel']).name
            self.assertEqual(saved.read_bytes(), GIF)

    def test_the_page_links_the_original_only_where_one_was_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.source(directory)
            export.remember_original('pair:7:1700000000', path, 'cache-image')
            linked, plain = item(), item(local_id=8, create_time=1_700_000_100)
            export.save_originals([linked, plain], directory, '示例群')

            html = export.build_html_page('synthetic-contact', [linked, plain],
                                          1, 1, '示例群', '示例群')

            self.assertEqual(html.count('data-full='), 1)
            self.assertIn(f'data-full="{linked["original_rel"]}"', html)
            # The bubble keeps the embedded preview; the original is a sibling
            # file, and the page must not gain an absolute path.
            self.assertIn('src="data:image/gif;base64,', html)
            self.assertNotIn(directory.replace('\\', '/'), html)

    def test_the_report_carries_the_status_word_but_not_the_path(self):
        report = export.build_media_report(
            [{'index': 0, 'mediaKey': 'pair:7:1', 'kind': 'image', 'status': 'embedded',
              'mime': 'image/gif', 'bytes': 10, 'sha256': 'x' * 64, 'reason': None,
              'original': 'saved'}],
            '示例群', 'synthetic-contact', per_page=0)
        self.assertEqual(report['items'][0]['original'], 'saved')
        blob = json.dumps(report, ensure_ascii=False)
        self.assertNotIn('originals/', blob)
        self.assertNotIn('img_', blob)

    def test_the_flag_is_off_unless_explicitly_requested(self):
        """Default export stays a single self-contained file."""
        self.assertFalse(export.SAVE_ORIGINALS)


if __name__ == '__main__':
    unittest.main()
