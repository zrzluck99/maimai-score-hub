import {
  catalogB50,
  projectCatalogRating,
  type RatingScore,
} from './catalog-rating';
import type { LxnsCatalogMusic } from './catalog';

export type AuditMusic = Pick<
  LxnsCatalogMusic,
  'id' | 'title' | 'type' | 'charts' | 'isNew'
> &
  Partial<LxnsCatalogMusic>;
export interface CatalogReferences {
  syncs?: Array<{ id?: string; scores?: RatingScore[] }>;
  scoreChanges?: Array<{ musicId: string; chartIndex: number }>;
  jobs?: Array<{ id?: string; musicIds?: string[] }>;
  aliases?: Array<{ musicIds: string[] }>;
  covers?: string[];
}

/** Read-only audit. IDs/CIDs are exact; title similarity never repairs references. */
export function auditCatalog(
  oldRows: AuditMusic[],
  candidate: AuditMusic[],
  refs: CatalogReferences,
  now = new Date(),
) {
  const nextIndex = new Map(candidate.map((m) => [m.id, m]));
  const cids = new Set(
    candidate.flatMap((m) => m.charts.map((c) => c.cid).filter(Boolean)),
  );
  const issues: Array<{ kind: string; location: string; reference: string }> =
    [];
  const check = (id: string, location: string, cid = false) => {
    if (!(cid ? cids.has(id) : nextIndex.has(id))) {
      issues.push({ kind: 'missing', location, reference: id });
    }
  };
  inspectIdentities(oldRows, candidate, issues);
  const syncs = (refs.syncs ?? []).map((sync, index) => {
    const scores = sync.scores ?? [];
    for (const s of scores) {
      check(
        `${s.musicId}_${s.chartIndex === 10 ? 0 : s.chartIndex}`,
        `syncs.${sync.id ?? index}`,
        true,
      );
    }
    const before = projectCatalogRating(scores, oldRows, now);
    const after = projectCatalogRating(scores, candidate, now);
    return {
      id: sync.id ?? String(index),
      beforeB50: catalogB50(scores, oldRows, now).totalSum,
      afterB50: catalogB50(scores, candidate, now).totalSum,
      changed: after.flatMap((s, i) =>
        s.rating !== before[i].rating || s.isNew !== before[i].isNew
          ? [
              {
                musicId: s.musicId,
                chartIndex: s.chartIndex,
                before: { rating: before[i].rating, isNew: before[i].isNew },
                after: { rating: s.rating, isNew: s.isNew },
              },
            ]
          : [],
      ),
    };
  });
  for (const s of refs.scoreChanges ?? []) {
    check(
      `${s.musicId}_${s.chartIndex === 10 ? 0 : s.chartIndex}`,
      'score_changes',
      true,
    );
  }
  for (const j of refs.jobs ?? []) {
    for (const id of j.musicIds ?? []) {
      check(id, `jobs.${j.id ?? '?'}`, true);
    }
  }
  for (const a of refs.aliases ?? []) {
    for (const id of a.musicIds) {
      check(id, 'aliases');
    }
  }
  for (const id of refs.covers ?? []) {
    check(id, 'covers');
  }
  return {
    oldCount: oldRows.length,
    candidateCount: candidate.length,
    safeToSwitch: issues.length === 0,
    issues,
    syncs,
  };
}

function inspectIdentities(
  oldRows: AuditMusic[],
  candidate: AuditMusic[],
  issues: Array<{ kind: string; location: string; reference: string }>,
) {
  const oldIndex = new Map(oldRows.map((m) => [m.id, m]));
  const titles = new Map<string, string>();
  const seenIds = new Set<string>();
  const seenCids = new Set<string>();
  for (const m of candidate) {
    if (seenIds.has(m.id)) {
      issues.push({
        kind: 'ambiguous-id',
        location: 'catalog',
        reference: m.id,
      });
    }
    seenIds.add(m.id);
    for (const c of m.charts) {
      if (!c.cid) {
        continue;
      }
      if (seenCids.has(c.cid)) {
        issues.push({
          kind: 'ambiguous-cid',
          location: 'catalog',
          reference: c.cid,
        });
      }
      seenCids.add(c.cid);
    }
    const key = `${m.category ?? ''}::${m.title}::${m.type}`;
    if (titles.has(key)) {
      issues.push({
        kind: 'ambiguous-title',
        location: 'dxnet',
        reference: key,
      });
    }
    titles.set(key, m.id);
    const old = oldIndex.get(m.id);
    if (old && old.title !== m.title) {
      issues.push({ kind: 'renamed', location: 'catalog', reference: m.id });
    }
    if (old && old.type !== m.type) {
      issues.push({
        kind: 'type-changed',
        location: 'catalog',
        reference: m.id,
      });
    }
  }
}
