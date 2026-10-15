#!/usr/bin/env python3
"""Server-side public-source discovery and continuous import. Never logs signed URLs."""
import argparse
import datetime as dt
import fcntl
import json
from pathlib import Path
import time
import urllib.request
from kolhalashon_import import USER_AGENT, checked_source, run

API = 'https://www.kolhalashon.com/api/'

def request(endpoint, payload=None):
    headers = {'User-Agent': USER_AGENT, 'Cache-Control': 'no-store'}
    data = None
    if payload is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(payload).encode()
    with urllib.request.urlopen(urllib.request.Request(API + endpoint, data=data, headers=headers), timeout=120) as response:
        return json.load(response)

def discover(archive=False):
    offset = 0
    ids = set()
    cutoff = dt.date.today() - dt.timedelta(days=30)
    while True:
        rows = request('Search/WebSite_GetRavShiurim/', dict(GeneralID=2268, CustomBool=False,
            NumOfRows=20, FromRow=offset, SearchOrder=7, FiltersArray=[], LangID=-1,
            PrefferedLanguage=-1, EnglishDisplay=False))
        if not isinstance(rows, list):
            raise ValueError('Invalid lesson listing')
        if not rows:
            return
        new = 0
        for row in rows:
            ident = str(row['FileId'])
            if ident in ids:
                continue
            ids.add(ident)
            new += 1
            if int(row['UserId']) != 2268:
                raise ValueError('Wrong source author')
            date = dt.date.fromisoformat(row['RecordDate'][:10])
            if not archive and date < cutoff:
                continue
            if row.get('IsLocked') or row.get('DisableDownload'):
                print('Unavailable for import', ident, flush=True)
                continue
            media = []
            for kind, available, mode in [('audio', row.get('HasAudio'), 1),
                    ('video', row.get('HasVideo') or row.get('HasHdVideo'), 3 if row.get('HasHdVideo') else 2)]:
                if not available:
                    continue
                yield {'id': ident, 'date': date.isoformat(), 'title': row.get('TitleHebrew') or row.get('TitleEnglish') or ident,
                       '_kind': kind, '_mode': mode}
        if not new:
            raise ValueError('Source pagination repeated; stopping safely')
        if len(rows) < 20 or (not archive and all(dt.date.fromisoformat(r['RecordDate'][:10]) < cutoff for r in rows)):
            return
        offset += len(rows)
        time.sleep(1)

def sync(config, archive=False):
    failures = 0
    for lesson in discover(archive):
        kind, mode = lesson.pop('_kind'), lesson.pop('_mode')
        if (config.parent / f".khl-{lesson['id']}-{kind}.done").exists():
            continue
        try:
            source = request(f"files/GetPlayToken/{lesson['id']}/{mode}")
            url = checked_source(source['src'])
            if '.m3u8' in url.split('?')[0]:
                raise ValueError('HLS source needs supported file download')
            lesson['media'] = [{'kind': kind, 'url': url}]
            run({'lessons': [lesson]}, config)
        except Exception as exc:
            failures += 1
            print('LESSON FAILED', lesson['id'], kind, type(exc).__name__, flush=True)
        time.sleep(1)
    print('SYNC COMPLETE failures=' + str(failures), flush=True)
    if failures:
        raise RuntimeError('Some lessons failed; next run retries them')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, default=Path(__file__).with_name('config.json'))
    parser.add_argument('--all', action='store_true', help='Import entire author archive')
    parser.add_argument('--loop', action='store_true', help='Keep checking independently on server')
    args = parser.parse_args()
    lock = (args.config.parent / '.khl-sync.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('Sync already running', flush=True)
        return
    # Keep archive mode until every lesson succeeds, including across restarts.
    archive_marker = args.config.parent / '.khl-archive.done'
    while True:
        archive = args.all and not archive_marker.exists()
        try:
            sync(args.config, archive)
            if archive:
                archive_marker.write_text(dt.datetime.now(dt.timezone.utc).isoformat())
        except Exception as exc:
            print('SYNC FAILED', type(exc).__name__, flush=True)
            if not args.loop:
                raise SystemExit(1)
        if not args.loop:
            return
        time.sleep(6 * 60 * 60)

if __name__ == '__main__':
    main()
