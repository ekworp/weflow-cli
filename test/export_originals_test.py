"""HTML bundle layout (`index.html` + `assets/`) and `--save-originals`.

Separate file from the rendering tests on purpose: those 31 stay untouched and
guard the behaviour these two changes are layered on. Nothing here touches a
real WeChat directory - every source file is a temp-dir synthetic.
"""
import base64
import datetime
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

            assets = export.save_originals([first, second], directory)

            self.assertEqual(first['original_status'], 'saved')
            self.assertEqual(second['original_status'], 'reused')
            self.assertEqual(first['original_rel'], second['original_rel'])
            # Content-addressed and relative to index.html, not an absolute path.
            self.assertRegex(first['original_rel'],
                             r'^assets/originals/img_[0-9a-f]{12}\.gif$')
            written = sorted(p.name for p in Path(assets).iterdir())
            self.assertEqual(len(written), 1)
            self.assertEqual((Path(assets) / written[0]).read_bytes(), GIF)
            self.assertEqual(export.original_summary(), {'saved': 1, 'reused': 1, 'failed': 0})

    def test_a_second_run_reuses_the_file_instead_of_rewriting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.source(directory)
            export.remember_original('pair:7:1700000000', path, 'cache-image')
            first = item()
            export.save_originals([first], directory)
            stored = Path(directory) / first['original_rel']
            before = stored.stat().st_mtime_ns

            again = item()
            export.save_originals([again], directory)

            self.assertEqual(again['original_status'], 'reused')
            self.assertEqual(again['original_rel'], first['original_rel'])
            self.assertEqual(stored.stat().st_mtime_ns, before)

    def test_a_thumbnail_is_reported_rather_than_saved_as_an_original(self):
        """120-210px is what the bubble already shows; naming it "original" lies."""
        with tempfile.TemporaryDirectory() as directory:
            path = self.source(directory)
            export.remember_original('pair:7:1700000000', path, 'thumb')
            message = item()

            assets = export.save_originals([message], directory)

            self.assertEqual(message['original_status'], 'thumbnail-only')
            self.assertIsNone(message.get('original_rel'))
            self.assertFalse(Path(assets).exists())

    def test_an_original_the_cache_never_had_says_so(self):
        with tempfile.TemporaryDirectory() as directory:
            message = item()
            export.save_originals([message], directory)
            self.assertEqual(message['original_status'], 'not-in-local-cache')

    def test_the_message_md5_finds_an_original_the_cache_key_did_not(self):
        """A cache thumb plus an account original: only the md5 links the two."""
        with tempfile.TemporaryDirectory() as directory:
            path = self.source(directory)
            export.remember_original(f'md5:{MD5}', path, 'account')
            message = item(media_key='unindexed-local', media_md5s=[MD5])

            export.save_originals([message], directory)

            self.assertEqual(message['original_status'], 'saved')

    def test_an_xor_obfuscated_source_is_decoded_before_it_is_saved(self):
        """The account index stores obfuscated payloads; the copy must be readable."""
        with tempfile.TemporaryDirectory() as directory:
            key = 0x37
            obfuscated = bytes(value ^ key for value in GIF)
            path = self.source(directory, 'obfuscated.dat', obfuscated)
            export.remember_original('pair:7:1700000000', path, 'account')
            message = item()

            assets = export.save_originals([message], directory)

            saved = Path(assets) / Path(message['original_rel']).name
            self.assertEqual(saved.read_bytes(), GIF)

    def test_the_page_links_the_original_only_where_one_was_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.source(directory)
            export.remember_original('pair:7:1700000000', path, 'cache-image')
            linked, plain = item(), item(local_id=8, create_time=1_700_000_100)
            export.save_originals([linked, plain], directory)

            html = export.build_html_page('synthetic-contact', [linked, plain],
                                          1, 1, '示例群')

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
        self.assertFalse(export.SAVE_ORIGINALS)


class BundleLayoutTests(unittest.TestCase):
    """The export is a directory: `index.html` plus `assets/`."""

    def test_the_directory_name_is_the_contact_plus_a_timestamp(self):
        now = datetime.datetime(2026, 10, 27, 15, 30, 12)
        self.assertEqual(
            export.export_directory_name('示例群', 'synthetic-contact', now),
            '示例群_20261027-153012')
        # Path characters cannot leak into the directory name, and an empty
        # display name falls back to the id rather than producing `_2026...`.
        self.assertEqual(
            export.export_directory_name('', 'a/b', now), 'a_b_20261027-153012')

    def test_a_new_export_never_reuses_an_existing_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            first = export.create_export_dir(directory, '示例群_20261027-153012')
            second = export.create_export_dir(directory, '示例群_20261027-153012')
            third = export.create_export_dir(directory, '示例群_20261027-153012')

            self.assertEqual(Path(first).name, '示例群_20261027-153012')
            self.assertEqual(Path(second).name, '示例群_20261027-153012-2')
            self.assertEqual(Path(third).name, '示例群_20261027-153012-3')
            # Every bundle gets its own assets dir, even before media is written.
            for path in (first, second, third):
                self.assertTrue((Path(path) / 'assets').is_dir())

    def test_parts_are_index_and_index_partN(self):
        self.assertEqual(export.part_filenames(1), ['index.html'])
        self.assertEqual(export.part_filenames(3),
                         ['index.html', 'index_part2.html', 'index_part3.html'])

    def test_previews_are_files_and_the_page_stops_embedding_base64(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = export.create_export_dir(directory, '示例群_20261027-153012')
            message = item()

            state = export.save_thumbnails([message], bundle)

            self.assertEqual(state, {'written': 1, 'reused': 0, 'failed': 0})
            self.assertRegex(message['thumb_rel'],
                             r'^assets/thumbs/thumb_[0-9a-f]{12}\.gif$')
            self.assertTrue((Path(bundle) / message['thumb_rel']).is_file())
            self.assertNotIn('data:', message['display'])
            self.assertIn(f'src="{message["thumb_rel"]}"', message['display'])

            html = export.build_html_page('synthetic-contact', [message],
                                          1, 1, '示例群')
            self.assertIn(f'src="{message["thumb_rel"]}"', html)
            self.assertNotIn('data:image/gif;base64,', html)
            self.assertIn('assets/thumbs/', html)

    def test_a_repeated_preview_is_written_once(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = export.create_export_dir(directory, '示例群_20261027-153012')
            first, second = item(), item()

            state = export.save_thumbnails([first, second], bundle)

            self.assertEqual(state, {'written': 1, 'reused': 1, 'failed': 0})
            self.assertEqual(first['thumb_rel'], second['thumb_rel'])
            self.assertEqual(len(list((Path(bundle) / 'assets' / 'thumbs').iterdir())), 1)

    def test_navigation_links_use_the_page_names_in_the_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = export.create_export_dir(directory, '示例群_20261027-153012')
            messages = [item(local_id=7, create_time=1_700_000_000),
                        item(local_id=8, create_time=1_700_000_100)]

            multi = export.build_html_page('synthetic-contact', messages,
                                           1, 2, '示例群')
            self.assertIn('href="index.html"', multi)
            self.assertIn('href="index_part2.html"', multi)
            self.assertNotIn('_part1.html', multi)

            # One part means there is nothing to navigate to; the old renderer
            # still emitted a link to a file that was never written.
            single = export.build_html_page('synthetic-contact', messages[:1],
                                            1, 1, '示例群')
            self.assertNotIn('<div class="part-nav">', single)
            self.assertNotIn('_part1.html', single)


if __name__ == '__main__':
    unittest.main()
