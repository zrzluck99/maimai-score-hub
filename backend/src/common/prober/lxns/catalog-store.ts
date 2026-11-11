import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { LxnsCatalogMusic } from './catalog';
import {
  LXNS_CATALOG_COLLECTION,
  catalogContentRevision,
  type parseLxnsCatalog,
} from './catalog';

/** Caller owns the catalog-sync lease. Never mutate the live collection in place. */
export async function publishLxnsCatalog(
  db: Db,
  snapshot: ReturnType<typeof parseLxnsCatalog>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (
    !snapshot.documents.length ||
    catalogContentRevision(snapshot.documents) !== snapshot.revision
  ) {
    throw new Error('Catalog content revision mismatch');
  }
  const live = db.collection(LXNS_CATALOG_COLLECTION);
  const previous = await live.findOne(
    {},
    { projection: { catalogRevision: 1 } },
  );
  if (previous?.catalogRevision === snapshot.revision) {
    return {
      matchedCount: snapshot.documents.length,
      modifiedCount: 0,
      upsertedCount: 0,
      removedCount: 0,
      total: snapshot.documents.length,
      revision: snapshot.revision,
      backupCollection: null,
    };
  }
  const suffix = randomUUID().replaceAll('-', '');
  const candidateName = `${LXNS_CATALOG_COLLECTION}_candidate_${suffix}`;
  const backupName = previous
    ? `${LXNS_CATALOG_COLLECTION}_backup_${suffix}`
    : null;
  const candidate = db.collection(candidateName);
  let published = false;
  try {
    await candidate.insertMany(snapshot.documents.map((row) => ({ ...row })));
    await candidate.createIndex({ id: 1 }, { unique: true });
    await candidate.createIndex({ sourceSongId: 1 });
    await candidate.createIndex({ 'charts.cid': 1 });
    if ((await candidate.countDocuments()) !== snapshot.documents.length) {
      throw new Error('Incomplete catalog candidate');
    }
    const old = previous ? await live.find().toArray() : [];
    if (backupName && old.length) {
      await db.collection(backupName).insertMany(old);
      await db.collection(backupName).createIndex({ id: 1 }, { unique: true });
    }
    signal?.throwIfAborted();
    // renameCollection replaces the namespace atomically: no live upsert/delete window.
    await candidate.rename(LXNS_CATALOG_COLLECTION, { dropTarget: true });
    published = true;
    const ids = new Set(snapshot.documents.map((m) => m.id));
    const oldIds = new Set(old.map((m) => String(m.id)));
    return {
      matchedCount: snapshot.documents.filter((m) => oldIds.has(m.id)).length,
      modifiedCount: snapshot.documents.filter((m) => oldIds.has(m.id)).length,
      upsertedCount: snapshot.documents.filter((m) => !oldIds.has(m.id)).length,
      removedCount: old.filter((m) => !ids.has(String(m.id))).length,
      total: snapshot.documents.length,
      revision: snapshot.revision,
      backupCollection: backupName,
    };
  } finally {
    // Only the explicitly created candidate is removed; existing data/backups are retained.
    if (!published) {
      await candidate.drop().catch(() => undefined);
    }
  }
}

/** Restore through a new candidate, retaining both the backup and a backup of current data. */
export async function restoreLxnsCatalog(db: Db, backupName: string) {
  if (!/^musics_lxns_backup_[a-f0-9]{32}$/.test(backupName)) {
    throw new Error('Invalid catalog backup name');
  }
  const rows = await db
    .collection<LxnsCatalogMusic>(backupName)
    .find({}, { projection: { _id: 0 } })
    .toArray();
  if (
    !rows.length ||
    rows.some((m) => m.source !== 'lxns' || !m.catalogRevision)
  ) {
    throw new Error('Backup is not a verified LXNS catalog');
  }
  const revisions = new Set(rows.map((m) => m.catalogRevision));
  if (revisions.size !== 1) {
    throw new Error('Mixed catalog backup');
  }
  return publishLxnsCatalog(db, {
    documents: rows,
    revision: rows[0].catalogRevision,
    catalogVersion: rows[0].catalogVersion,
    gameVersion: rows[0].gameVersion,
    sourceSongCount: new Set(rows.map((m) => m.sourceSongId)).size,
  });
}
