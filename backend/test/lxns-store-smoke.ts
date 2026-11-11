/* eslint-disable @typescript-eslint/require-await -- Async test doubles intentionally implement fetch and injected database failure. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import {
  parseLxnsCatalog,
  LXNS_CATALOG_COLLECTION,
} from '../src/common/prober/lxns/catalog';
import {
  publishLxnsCatalog,
  restoreLxnsCatalog,
} from '../src/common/prober/lxns/catalog-store';
import { MusicAliasService } from '../src/modules/music-alias/services/music-alias.service';

async function main() {
  // Deliberately fixed to a dedicated loopback test port, never MONGODB_URI.
  const client = new MongoClient('mongodb://127.0.0.1:37029', {
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  const db = client.db(`lxns_test_${randomUUID().replaceAll('-', '')}`);
  const payload: unknown = JSON.parse(
    readFileSync(process.argv[2] ?? 'test/fixtures/lxns/catalog.json', 'utf8'),
  );
  const first = parseLxnsCatalog(payload);
  const fetchOriginal = globalThis.fetch;
  try {
    await db
      .collection('musics')
      .insertOne({ id: 'legacy', source: 'diving_fish' });
    await publishLxnsCatalog(db, first);
    const live = db.collection(LXNS_CATALOG_COLLECTION);
    assert.equal(await live.countDocuments(), first.documents.length);
    const changed = JSON.parse(JSON.stringify(payload)) as {
      songs: Array<{ title: string }>;
    };
    changed.songs[0].title += ' revised';
    const second = parseLxnsCatalog(changed);
    const published = await publishLxnsCatalog(db, second);
    assert(published.backupCollection);
    assert.equal((await live.findOne({}))!.catalogRevision, second.revision);
    await restoreLxnsCatalog(db, published.backupCollection);
    assert.equal((await live.findOne({}))!.catalogRevision, first.revision);
    const createIndex = (
      Object.getPrototypeOf(db.collection('probe')) as {
        createIndex: (...args: unknown[]) => Promise<unknown>;
      }
    ).createIndex as (...args: unknown[]) => Promise<unknown>;
    const prototype = Object.getPrototypeOf(db.collection('probe')) as {
      createIndex: typeof createIndex;
    };
    prototype.createIndex = async () => {
      throw new Error('injected index failure');
    };
    try {
      await assert.rejects(
        publishLxnsCatalog(db, second),
        /injected index failure/,
      );
    } finally {
      prototype.createIndex = createIndex;
    }
    assert.equal((await live.findOne({}))!.catalogRevision, first.revision);
    await assert.rejects(publishLxnsCatalog(db, second, AbortSignal.abort()));
    assert.equal(await db.collection('musics').countDocuments(), 1);
    const leftovers = await db.listCollections().toArray();
    assert(!leftovers.some((c) => c.name.includes('_candidate_')));

    const aliasModel = {
      db: { db },
      find: (filter: object) => ({
        select: () => ({
          lean: () =>
            db.collection('music_aliases_lxns').find(filter).toArray(),
        }),
      }),
    };
    const musicModel = { find: () => ({ lean: () => live.find().toArray() }) };
    const makeAlias = () =>
      new MusicAliasService(
        aliasModel as never,
        musicModel as never,
        {} as never,
        {} as never,
      );
    const writer = makeAlias();
    const reader = makeAlias();
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ aliases: [{ song_id: 30, aliases: ['first'] }] }),
      );
    await writer.syncAll();
    assert.equal((await reader.findAll()).aliases[0].aliases[0], 'first');
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ aliases: [{ song_id: 30, aliases: ['second'] }] }),
      );
    await writer.syncAll();
    assert.equal((await reader.findAll()).aliases[0].aliases[0], 'second');
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ aliases: [{ song_id: 'bad', aliases: [] }] }),
      );
    await assert.rejects(writer.syncAll());
    assert.equal((await reader.findAll()).aliases[0].aliases[0], 'second');
    if (process.argv[3]) {
      const aliasBody = readFileSync(process.argv[3], 'utf8');
      globalThis.fetch = async () => new Response(aliasBody);
      await writer.syncAll();
      assert((await reader.findAll()).aliases.length > 0);
    }
    console.log(
      JSON.stringify({
        mongo: '7',
        catalogPublish: true,
        rollback: true,
        failedWritePreserved: true,
        abortedPreserved: true,
        legacyUntouched: true,
        noCandidateLeak: true,
        independentAliasReader: true,
        invalidAliasPreserved: true,
      }),
    );
  } finally {
    globalThis.fetch = fetchOriginal;
    await db.dropDatabase();
    await client.close();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
