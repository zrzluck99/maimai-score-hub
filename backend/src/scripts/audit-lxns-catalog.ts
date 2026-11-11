import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import { parseLxnsCatalog } from '../common/prober/lxns/catalog';
import {
  auditCatalog,
  type AuditMusic,
  type CatalogReferences,
} from '../common/prober/lxns/catalog-audit';

/** No write operations. Use exports or a read-only account on a database copy. */
async function main() {
  const [payloadFile, referenceFile, version = '25500'] = process.argv.slice(2);
  if (!payloadFile) {
    throw new Error(
      'Usage: audit-lxns-catalog <LXNS JSON> <references JSON | --mongo-copy> [gameVersion]',
    );
  }
  const candidate = parseLxnsCatalog(
    JSON.parse(readFileSync(payloadFile, 'utf8')),
    Number(version),
  );
  let input: CatalogReferences & { oldCatalog: AuditMusic[] };
  if (referenceFile === '--mongo-copy') {
    const uri = process.env.CATALOG_AUDIT_MONGO_URI;
    const database = process.env.CATALOG_AUDIT_DATABASE;
    if (!uri || !database) {
      throw new Error(
        'Explicit CATALOG_AUDIT_MONGO_URI and CATALOG_AUDIT_DATABASE required',
      );
    }
    const client = new MongoClient(uri);
    try {
      await client.connect();
      const db = client.db(database);
      const [oldCatalog, syncs, scoreChanges, jobs, aliases] =
        await Promise.all([
          db
            .collection('musics')
            .find({}, { projection: { _id: 0 } })
            .toArray(),
          db
            .collection('syncs')
            .find({}, { projection: { _id: 0, id: 1, scores: 1 } })
            .toArray(),
          db
            .collection('score_changes')
            .find({}, { projection: { _id: 0, musicId: 1, chartIndex: 1 } })
            .toArray(),
          db
            .collection('jobs')
            .find({}, { projection: { _id: 0, id: 1, musicIds: 1 } })
            .toArray(),
          db
            .collection('music_aliases')
            .find({}, { projection: { _id: 0, musicIds: 1 } })
            .toArray(),
        ]);
      input = {
        oldCatalog,
        syncs,
        scoreChanges,
        jobs,
        aliases,
      } as unknown as typeof input;
    } finally {
      await client.close();
    }
  } else {
    if (!referenceFile) {
      throw new Error('References JSON required');
    }
    input = JSON.parse(readFileSync(referenceFile, 'utf8')) as typeof input;
  }
  if (!Array.isArray(input.oldCatalog)) {
    throw new Error('oldCatalog array required');
  }
  const report = auditCatalog(input.oldCatalog, candidate.documents, input);
  console.log(
    JSON.stringify(
      {
        catalogRevision: candidate.revision,
        catalogVersion: candidate.catalogVersion,
        ...report,
        coverage: {
          covers: input.covers ? 'provided' : 'not-provided',
          productionVerified: false,
        },
      },
      null,
      2,
    ),
  );
  if (!report.safeToSwitch) {
    process.exitCode = 2;
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
