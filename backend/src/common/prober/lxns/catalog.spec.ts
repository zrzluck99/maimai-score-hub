/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Fixtures are intentionally corrupted to test rejection of invalid payloads. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lxnsCatalogUrl, parseLxnsCatalog } from './catalog';

const sample = () =>
  JSON.parse(
    readFileSync(
      join(__dirname, '../../../../test/fixtures/lxns/catalog.json'),
      'utf8',
    ),
  );

describe('LXNS catalog contract', () => {
  it('preserves SD/DX identities, explicit difficulties, notes and chart-specific newness', () => {
    const result = parseLxnsCatalog(sample());
    const sd = result.documents.find((m) => m.id === '30')!;
    const dx = result.documents.find((m) => m.id === '10030')!;
    expect(sd.isNew).toBe(false);
    expect(dx.isNew).toBe(true);
    expect(dx.sourceSongId).toBe(30);
    expect(dx.versionCode).toBe(25500);
    expect(dx.charts[3]).toMatchObject({
      cid: '10030_3',
      detailLevel: 13.7,
      notes: { total: 631 },
    });
    expect(new Set(result.documents.map((m) => m.id)).size).toBe(
      result.documents.length,
    );
  });

  it('preserves utage zero constants and BUDDY sides without inventing a combined total', () => {
    const rows = parseLxnsCatalog(sample()).documents;
    expect(rows.find((m) => m.id === '100018')!.charts[0]).toMatchObject({
      cid: '100018_0',
      detailLevel: 0,
    });
    const buddy = rows.find((m) => m.id === '110281')!.charts[0];
    expect(buddy).toMatchObject({
      isBuddy: true,
      notes: { left: { total: 653 }, right: { total: 653 } },
    });
    expect(buddy.notes).not.toHaveProperty('total');
  });

  it('maps minor versions by interval, not exact lookup, and places sparse/unsorted difficulties correctly', () => {
    const data = sample();
    const song = data.songs.find((s: { id: number }) => s.id === 30);
    song.difficulties.dx = [song.difficulties.dx[3], song.difficulties.dx[0]];
    song.difficulties.dx[0].version = 25506;
    const dx = parseLxnsCatalog(data).documents.find((m) => m.id === '10030')!;
    expect(dx.versionCode).toBe(25500);
    expect(dx.charts.map((c) => c.cid)).toEqual([
      '10030_0',
      undefined,
      undefined,
      '10030_3',
    ]);
  });

  it('has time-independent hashes and requests the full notes payload', () => {
    const first = parseLxnsCatalog(sample(), 25500, new Date(0));
    const second = parseLxnsCatalog(sample(), 25500, new Date());
    expect(first.revision).toBe(second.revision);
    expect(first.catalogVersion).toBe(second.catalogVersion);
    expect(lxnsCatalogUrl(25500)).toBe(
      'https://maimai.lxns.net/api/v0/maimai/song/list?version=25500&notes=true',
    );
  });

  it.each([
    'empty',
    'duplicate',
    'bad-notes',
    'missing-notes',
    'unknown-genre',
    'wrong-type',
    'multiple-utage',
  ])('rejects %s before publishing', (kind) => {
    const data = sample();
    if (kind === 'empty') {
      data.songs = [];
    }
    if (kind === 'duplicate') {
      data.songs.push(data.songs[0]);
    }
    if (kind === 'bad-notes') {
      data.songs[0].difficulties.standard[0].notes.total++;
    }
    if (kind === 'missing-notes') {
      delete data.songs[0].difficulties.standard[0].notes;
    }
    if (kind === 'unknown-genre') {
      data.songs[0].genre = 'unknown';
    }
    if (kind === 'wrong-type') {
      data.songs[0].difficulties.standard[0].type = 'dx';
    }
    if (kind === 'multiple-utage') {
      const song = data.songs.find((s: { id: number }) => s.id === 100018);
      song.difficulties.utage.push({
        ...song.difficulties.utage[0],
        difficulty: 1,
      });
    }
    expect(() => parseLxnsCatalog(data)).toThrow();
  });
});
