import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLxnsCatalog } from './catalog';
import { auditCatalog } from './catalog-audit';
import { catalogB50, projectCatalogRating } from './catalog-rating';

const fixture = () =>
  parseLxnsCatalog(
    JSON.parse(
      readFileSync(
        join(__dirname, '../../../../test/fixtures/lxns/catalog.json'),
        'utf8',
      ),
    ),
  ).documents;

describe('LXNS historical references and derived ratings', () => {
  it('reports every reference category and never guesses by title', () => {
    const rows = fixture();
    const before = JSON.stringify(rows);
    const result = auditCatalog(
      rows,
      rows.filter((m) => m.id !== '30'),
      {
        syncs: [
          {
            id: 's',
            scores: [{ musicId: '30', chartIndex: 3, score: '100%' }],
          },
        ],
        scoreChanges: [{ musicId: '30', chartIndex: 3 }],
        jobs: [{ musicIds: ['30_3'] }],
        aliases: [{ musicIds: ['30'] }],
        covers: ['30'],
      },
    );
    expect(result.safeToSwitch).toBe(false);
    expect(result.issues.map((i) => i.location)).toEqual([
      'syncs.s',
      'score_changes',
      'jobs.?',
      'aliases',
      'covers',
    ]);
    expect(JSON.stringify(rows)).toBe(before);
  });
  it('reports duplicate, renamed and changed-type identities', () => {
    const rows = fixture();
    const changed = structuredClone(rows);
    changed[0].title += 'changed';
    changed[0].type = 'dx';
    changed.push(changed[1]);
    expect(auditCatalog(rows, changed, {}).issues.map((i) => i.kind)).toEqual(
      expect.arrayContaining([
        'renamed',
        'type-changed',
        'ambiguous-id',
        'ambiguous-cid',
        'ambiguous-title',
      ]),
    );
  });
  it('recalculates constants and newness without changing observations or stored history', () => {
    const rows = fixture();
    const next = structuredClone(rows);
    const music = next.find((m) => m.id === '30')!;
    music.isNew = true;
    music.charts[3].detailLevel = 15;
    const score = {
      musicId: '30',
      chartIndex: 3,
      score: '100.5000%',
      rating: 1,
      isNew: false,
      fc: 'ap',
      observedAt: 'unchanged',
    };
    const original = JSON.stringify(score);
    const [derived] = projectCatalogRating([score], next);
    expect(derived).toMatchObject({
      rating: 337,
      isNew: true,
      fc: 'ap',
      observedAt: 'unchanged',
      score: '100.5000%',
    });
    expect(JSON.stringify(score)).toBe(original);
    expect(
      auditCatalog(rows, next, { syncs: [{ scores: [score] }] }).syncs[0]
        .changed,
    ).toHaveLength(1);
  });
  it('excludes disabled and unreleased charts, but locked charts still count', () => {
    const rows = fixture();
    const song = rows.find((m) => m.id === '30')!;
    const score = { musicId: '30', chartIndex: 3, score: '100.5%' };
    song.charts[3].locked = true;
    expect(catalogB50([score], rows).totalSum).toBeGreaterThan(0);
    song.disabled = true;
    expect(catalogB50([score], rows).totalSum).toBe(0);
    song.disabled = false;
    song.charts[3].releaseDate = '2099-01-01';
    expect(
      catalogB50([score], rows, new Date('2098-12-31T22:59:59Z')).totalSum,
    ).toBe(0);
    expect(
      catalogB50([score], rows, new Date('2098-12-31T23:00:00Z')).totalSum,
    ).toBeGreaterThan(0);
  });
});
