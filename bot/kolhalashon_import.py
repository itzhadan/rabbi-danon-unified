#!/usr/bin/env python3
"""Import explicitly selected Kol Halashon media. No browser credentials required.

Input: a JSON manifest on stdin (or --base64 JSON). See KOLHALASHON.md.
Uses the existing private bot config only inside this process; never logs secrets.
"""
import argparse
import base64
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.error
import urllib.request

LIMIT = 95_000_000
DEFAULT_SITE = 'https://rabbiyosefdanon.rabbiyosefdanon.workers.dev'
USER_AGENT = 'RabbiDanonImporter/1.0'


def checked_source(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in {
        'media-cdn.kolhalashon.com', 'www.kolhalashon.com', 'kolhalashon.com'
    } or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('Unsupported source host')
    return url


class OfficialRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        checked_source(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url, dest):
    opener = urllib.request.build_opener(OfficialRedirects())
    with opener.open(checked_source(url), timeout=120) as response, dest.open('wb') as out:
        # Some official downloads use binary/octet-stream. ffprobe validates the
        # actual bytes before upload, rather than relying on the MIME label.
        if response.headers.get('Content-Type', '').startswith(('text/', 'application/json')):
            raise ValueError('Source did not return a media file')
        size = 0
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > 4_000_000_000:
                raise ValueError('Source exceeds import disk limit')
            out.write(chunk)
    if not size:
        raise ValueError('Empty source file')


def probe(file):
    result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                             'format=duration:stream=codec_type:stream_disposition=attached_pic', '-of', 'json', str(file)],
                            capture_output=True, check=True, timeout=60)
    data = json.loads(result.stdout)
    return float(data['format']['duration']), any(s['codec_type'] == 'video' and not s.get('disposition', {}).get('attached_pic') for s in data['streams'])


def media_parts(source, folder):
    duration, video = probe(source)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError('Invalid media duration')
    if source.stat().st_size <= LIMIT:
        yield source, video
        return
    count = math.ceil(source.stat().st_size / 65_000_000)
    pending = [(duration * i/count, duration * (i+1)/count, 0) for i in range(count)]
    serial = 0
    while pending:
        start, end, depth = pending.pop(0)
        serial += 1
        output = folder / (f'part-{serial}.mp4' if video else f'part-{serial}.mp3')
        args = ['ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', str(start), '-i', str(source), '-t', str(end-start)]
        args += (['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']
                 if video else ['-vn', '-c:a', 'libmp3lame', '-b:a', '128k'])
        subprocess.run(args + [str(output)], capture_output=True, check=True, timeout=1800)
        if output.stat().st_size > LIMIT:
            if depth >= 12 or end-start < 2:
                raise ValueError('Cannot split media within upload limit')
            middle = (start+end)/2
            pending[0:0] = [(start, middle, depth+1), (middle, end, depth+1)]
        else:
            yield output, video


def validate(item):
    if not re.fullmatch(r'\d{1,12}', str(item.get('id', ''))):
        raise ValueError('Invalid lesson id')
    dt.date.fromisoformat(item['date'])
    if not isinstance(item.get('title'), str) or not item['title'].strip():
        raise ValueError('Missing lesson title')
    if not item.get('media'):
        raise ValueError('No media supplied')
    for media in item['media']:
        if media.get('kind') not in ('audio', 'video'):
            raise ValueError('Invalid media kind')
        checked_source(media['url'])


def run(manifest, config_path):
    items = manifest['lessons']
    for item in items:
        validate(item)
    config = json.loads(config_path.read_text())
    site = config.get('site', DEFAULT_SITE).rstrip('/')
    if urllib.parse.urlsplit(site).scheme != 'https':
        raise ValueError('Destination must use HTTPS')
    password = config['password']
    print('Reading destination index', flush=True)
    index_request = urllib.request.Request(site + '/api/clips', headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(index_request, timeout=60) as response:
        existing = {c.get('fp') for c in json.load(response).get('clips', [])}
    for item in items:
        for media in item['media']:
            prefix = f"kolhalashon:{item['id']}:{media['kind']}:"
            # Completion is confirmed by a separate marker only after every part succeeds.
            marker = config_path.parent / f".khl-{item['id']}-{media['kind']}.done"
            if marker.exists():
                print(f"Already imported {item['id']} {media['kind']}", flush=True)
                continue
            with tempfile.TemporaryDirectory(prefix='khl-import-', ignore_cleanup_errors=True) as tmp:
                folder = Path(tmp)
                source = folder / ('source.mp4' if media['kind'] == 'video' else 'source.mp3')
                print(f"Downloading {item['id']} {media['kind']}", flush=True)
                download(media['url'], source)
                parts = list(media_parts(source, folder))
                for number, (file, video) in enumerate(parts, 1):
                    if video != (media['kind'] == 'video'):
                        raise ValueError('Declared media kind does not match file')
                    fingerprint = prefix + str(number)
                    if fingerprint in existing:
                        continue
                    content_type = 'video/mp4' if video else 'audio/mpeg'
                    params = urllib.parse.urlencode(dict(week=item['date'], kind='kolhalashon',
                        label=item['title'][:65] + (' · וידאו' if video else ' · שמע'),
                        taken=item['date']+'T19:00:00+03:00', fp=fingerprint,
                        sourceId=str(item['id']), part=number, parts=len(parts)))
                    request = urllib.request.Request(site+'/api/upload?'+params,
                        data=file.read_bytes(), headers={'x-admin-password': password, 'Content-Type': content_type, 'User-Agent': USER_AGENT}, method='POST')
                    print(f"Uploading {item['id']} part {number}/{len(parts)}", flush=True)
                    with urllib.request.urlopen(request, timeout=300) as response:
                        result = json.load(response)
                    if not result.get('ok'):
                        raise ValueError('Upload was not confirmed')
                    existing.add(fingerprint)
                    print(f"Uploaded {item['id']} {media['kind']} part {number}/{len(parts)}", flush=True)
                marker.write_text(dt.datetime.now(dt.timezone.utc).isoformat())
    print('IMPORT COMPLETE', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base64')
    parser.add_argument('--config', type=Path, default=Path(__file__).with_name('config.json'))
    args = parser.parse_args()
    manifest = json.loads(base64.b64decode(args.base64) if args.base64 else sys.stdin.read())
    try:
        run(manifest, args.config)
    except Exception as exc:
        # HTTP/ffmpeg exceptions may contain signed source URLs. Log only a safe category.
        status = f' HTTP {exc.code} at {urllib.parse.urlsplit(exc.url).hostname}' if isinstance(exc, urllib.error.HTTPError) else ''
        print(f'Import failed ({type(exc).__name__}{status}); refresh source URLs and retry.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
