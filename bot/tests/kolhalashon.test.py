import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('khl', Path(__file__).parents[1] / 'kolhalashon_import.py')
khl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(khl)


class ImportTests(unittest.TestCase):
    def test_audio_cover_art_is_not_video(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            audio, cover, tagged = root/'audio.mp3', root/'cover.png', root/'tagged.mp3'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=duration=1',str(audio)],check=True)
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=blue:s=32x32','-frames:v','1','-threads','1',str(cover)],check=True)
            subprocess.run(['ffmpeg','-v','error','-i',str(audio),'-i',str(cover),'-map','0:a','-map','1:v','-c','copy','-disposition:v','attached_pic',str(tagged)],check=True)
            self.assertFalse(khl.probe(tagged)[1])

    def test_rejects_unrelated_hosts(self):
        for url in ['http://media-cdn.kolhalashon.com/a.mp3', 'https://evil.test/a.mp3',
                    'https://media-cdn.kolhalashon.com@evil.test/a.mp3']:
            with self.assertRaises(ValueError):
                khl.checked_source(url)

    def test_real_audio_upload_and_repeated_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'fixture.mp3'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', str(source)], check=True)
            config = root / 'config.json'
            config.write_text(json.dumps({'password':'test-password'}))
            manifest = {'lessons':[{'id':'42852207','date':'2026-10-14','title':'שיעור בדיקה',
                'media':[{'kind':'audio','url':'https://media-cdn.kolhalashon.com/test.mp3'}]}]}
            uploaded = []

            def remote(request, **kwargs):
                if request.get_method() == 'GET':
                    return io.BytesIO(b'{"clips":[]}')
                uploaded.append(request)
                return io.BytesIO(b'{"ok":true}')

            logs = io.StringIO()
            with patch.object(khl, 'download', lambda url, dest: shutil.copyfile(source, dest)), patch.object(khl.urllib.request, 'urlopen', remote), contextlib.redirect_stdout(logs):
                khl.run(manifest, config)
                khl.run(manifest, config)
            self.assertEqual(len(uploaded), 1)
            self.assertIn('kind=kolhalashon', uploaded[0].full_url)
            self.assertIn('sourceId=42852207', uploaded[0].full_url)
            self.assertNotIn('test-password', logs.getvalue())

    def test_split_parts_playable_and_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'fixture.mp3'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-b:a', '320k', str(source)], check=True)
            with patch.object(khl, 'LIMIT', 50_000):
                parts = list(khl.media_parts(source, root))
            self.assertGreater(len(parts), 1)
            self.assertTrue(all(p.stat().st_size <= 50_000 for p, _ in parts))
            self.assertAlmostEqual(sum(khl.probe(p)[0] for p, _ in parts), 6, delta=.3)


if __name__ == '__main__':
    unittest.main()
