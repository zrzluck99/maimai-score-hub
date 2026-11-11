"""Independent Python implementation of lxns-standard-dx-v1 for consumer adoption.

Usage: python test/catalog-compatibility.py catalog.json [asdfbot checkout]
The checkout is imported read-only; its ordinary chart identity and constants
are compared, without modifying its Provider or database.
"""
import hashlib
import json
import sys
from bisect import bisect_right
from decimal import Decimal


def decimal_text(value):
    return format(Decimal(str(value)).normalize(), 'f')


def projection(payload, game_version=25500):
    versions = sorted(item['version'] for item in payload['versions'])
    rows = []
    for song in payload['songs']:
        for group in ('standard', 'dx'):
            charts = sorted(song['difficulties'].get(group, []), key=lambda c: c['difficulty'])
            if not charts:
                continue
            version = versions[bisect_right(versions, charts[0]['version']) - 1]
            local_id = song['id'] + (10000 if group == 'dx' else 0)
            rows.append([str(local_id), str(song['id']), group, song['title'], str(version),
                         version == game_version, bool(song.get('disabled')),
                         [[str(c['difficulty']), decimal_text(c['level_value']), c['level'], str(c['version']),
                           c.get('release_date'), bool(c.get('locked')), c.get('note_designer', ''),
                           [str(c['notes'][key]) for key in ('total', 'tap', 'hold', 'slide', 'touch', 'break')] if c.get('notes') else None] for c in charts]])
    return ['lxns-standard-dx-v1', str(game_version), sorted(rows, key=lambda r: int(r[0]))]


def main():
    with open(sys.argv[1], encoding='utf-8') as handle:
        payload = json.load(handle)
    payload = payload.get('data', payload)
    canonical = projection(payload)
    if len(sys.argv) > 2:
        sys.path.insert(0, sys.argv[2])
        from src.libraries.maimai.catalog.luoxue import parse_luoxue_catalog
        snapshot = parse_luoxue_catalog(payload)
        index = {m.id: m for m in snapshot.musics}
        charts = {(c.music_id, c.diff_index): c for c in snapshot.charts}
        assert set(index) == {int(r[0]) for r in canonical[2]}
        for row in canonical[2]:
            music = index[int(row[0])]
            assert music.title == row[3]
            assert music.type == ('DX' if row[2] == 'dx' else 'SD')
            assert snapshot.versions[music.version_id].code == int(row[4])
            assert music.is_new == row[5] and music.disabled == row[6]
            for chart in row[7]:
                assert decimal_text(charts[(music.id, int(chart[0]))].ds) == chart[1]
    encoded = json.dumps(canonical, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    print(hashlib.sha256(encoded).hexdigest())


if __name__ == '__main__':
    main()
