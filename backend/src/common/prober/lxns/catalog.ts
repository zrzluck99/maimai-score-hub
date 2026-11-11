import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChartPayload } from '../../../modules/music/schemas/music.schema';

export const LXNS_CATALOG_COLLECTION = 'musics_lxns';
export const LXNS_GAME_VERSION = 25500;
export const LXNS_SONG_URL = 'https://maimai.lxns.net/api/v0/maimai/song/list';

const count = z.number().int().nonnegative();
const notesSchema = z
  .object({
    total: count,
    tap: count,
    hold: count,
    slide: count,
    touch: count,
    break: count,
  })
  .refine(
    (n) => n.total === n.tap + n.hold + n.slide + n.touch + n.break,
    'notes.total must equal the component sum',
  );
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().startsWith(value)
    );
  }, 'invalid release date');
const difficultySchema = z.object({
  type: z.enum(['standard', 'dx', 'utage']),
  difficulty: count.max(4),
  level: z.string().min(1),
  level_value: z.number().finite().nonnegative(),
  note_designer: z.string(),
  version: z.number().int().positive(),
  release_date: dateSchema.optional(),
  locked: z.boolean().nullish(),
  is_buddy: z.boolean().optional(),
  kanji: z.string().optional(),
  description: z.string().optional(),
  notes: z
    .union([notesSchema, z.object({ left: notesSchema, right: notesSchema })])
    .nullable(),
});
const catalogSchema = z.object({
  songs: z
    .array(
      z.object({
        id: z.number().int().positive(),
        title: z.string().min(1),
        artist: z.string(),
        genre: z.string().min(1),
        bpm: z.number().finite().nonnegative(),
        version: z.number().int().positive(),
        release_date: dateSchema.optional(),
        rights: z.string().nullish(),
        disabled: z.boolean().nullish(),
        locked: z.boolean().nullish(),
        difficulties: z.object({
          standard: z.array(difficultySchema).default([]),
          dx: z.array(difficultySchema).default([]),
          utage: z.array(difficultySchema).optional(),
        }),
      }),
    )
    .min(1),
  genres: z
    .array(z.object({ genre: z.string().min(1), title: z.string().min(1) }))
    .min(1),
  versions: z
    .array(
      z.object({
        version: z.number().int().positive(),
        title: z.string().min(1),
      }),
    )
    .min(1),
});

export interface LxnsCatalogMusic {
  id: string;
  source: 'lxns';
  sourceSongId: number;
  sourceMetadata: {
    genre: string;
    version: number;
    locked: boolean;
    releaseDate: string | null;
  };
  title: string;
  type: 'standard' | 'dx' | 'utage';
  artist: string;
  category: string;
  bpm: number;
  version: string;
  versionCode: number;
  isNew: boolean;
  disabled: boolean;
  locked: boolean;
  releaseDate: string | null;
  rights: string | null;
  charts: ChartPayload[];
  catalogRevision: string;
  catalogVersion: string;
  gameVersion: number;
  sync: { createdAt: Date; updatedAt: Date; lastSyncedAt: Date };
}

export function lxnsCatalogUrl(version: number): string {
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error('Invalid LXNS_GAME_VERSION');
  }
  return `${LXNS_SONG_URL}?version=${version}&notes=true`;
}

/** The historical local identifier is an encoding, not a metadata source. */
export function lxnsLocalId(id: number, type: string): string {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('Invalid LXNS song id');
  }
  if (type === 'utage' && id > 100000) {
    return String(id);
  }
  if (id >= 10000 || !['standard', 'dx'].includes(type)) {
    throw new Error('Invalid LXNS song/type pair');
  }
  return String(type === 'dx' ? id + 10000 : id);
}

const DISPLAY_VERSION: Record<string, string> = {
  'maimai PLUS': 'maimai+',
  GreeN: 'green',
  'GreeN PLUS': 'green+',
  ORANGE: 'orange',
  'ORANGE PLUS': 'orange+',
  PiNK: 'pink',
  'PiNK PLUS': 'pink+',
  MURASAKi: 'murasaki',
  'MURASAKi PLUS': 'murasaki+',
  MiLK: 'milk',
  'MiLK PLUS': 'milk+',
  FiNALE: 'finale',
};

function unique<T>(values: T[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Duplicate ${label}`);
  }
}

/** Canonical v1 projection: arrays, UTF-8 JSON, no spaces; decimal numbers encoded as strings. */
export function catalogCompatibilityProjection(
  rows: readonly LxnsCatalogMusic[],
  gameVersion: number,
) {
  return [
    'lxns-standard-dx-v1',
    String(gameVersion),
    [...rows]
      .filter((m) => m.type !== 'utage')
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((m) => [
        m.id,
        String(m.sourceSongId),
        m.type,
        m.title,
        String(m.versionCode),
        m.isNew,
        m.disabled,
        m.charts
          .filter((c) => c.cid)
          .map((c) => [
            String(c.difficulty),
            String(c.detailLevel),
            c.level,
            String(c.versionCode),
            c.releaseDate ?? null,
            c.locked ?? false,
            c.charter ?? '',
            canonicalNotes(c.notes),
          ]),
      ]),
  ];
}

function canonicalNotes(notes: unknown): string[] | null {
  if (!notes || typeof notes !== 'object' || !('total' in notes)) {
    return null;
  }
  const values = notes as Record<string, number>;
  return ['total', 'tap', 'hold', 'slide', 'touch', 'break'].map((key) =>
    String(values[key]),
  );
}

type CatalogSong = z.infer<typeof catalogSchema>['songs'][number];
function sourceSongMetadata(
  song: CatalogSong,
): LxnsCatalogMusic['sourceMetadata'] {
  return {
    genre: song.genre,
    version: song.version,
    locked: song.locked ?? false,
    releaseDate: song.release_date ?? null,
  };
}
function convertGroup(
  song: CatalogSong,
  type: LxnsCatalogMusic['type'],
  group: z.infer<typeof difficultySchema>[],
  category: string,
  mainVersion: (code: number) => { version: number; title: string },
  gameVersion: number,
  now: Date,
): LxnsCatalogMusic {
  const id = lxnsLocalId(song.id, type);
  if (group.some((c) => c.type !== type)) {
    throw new Error(`Chart type mismatch for ${id}`);
  }
  if (type === 'utage' && (group.length !== 1 || group[0].difficulty !== 0)) {
    throw new Error(`Unsupported multiple utage charts for ${id}`);
  }
  unique(
    group.map((c) => c.difficulty),
    `difficulty for ${id}`,
  );
  const resolved = group.map((c) => mainVersion(c.version));
  if (new Set(resolved.map((v) => v.version)).size !== 1) {
    throw new Error(`Mixed main chart versions for ${id}`);
  }
  const version = resolved[0];
  const charts: ChartPayload[] = Array.from(
    { length: Math.max(...group.map((c) => c.difficulty)) + 1 },
    () => ({}),
  );
  for (const chart of group) {
    const buddy = !!chart.is_buddy;
    if (buddy && type !== 'utage') {
      throw new Error(`BUDDY on non-utage chart ${id}`);
    }
    if (chart.notes && 'left' in chart.notes !== buddy) {
      throw new Error(`BUDDY notes mismatch for ${id}`);
    }
    charts[chart.difficulty] = {
      cid: `${id}_${chart.difficulty}`,
      difficulty: chart.difficulty,
      level: chart.level,
      detailLevel: chart.level_value,
      charter: chart.note_designer,
      notes: chart.notes,
      versionCode: chart.version,
      releaseDate: chart.release_date ?? null,
      locked: chart.locked ?? false,
      ...(type === 'utage'
        ? {
            isBuddy: buddy,
            kanji: chart.kanji,
            description: chart.description,
          }
        : {}),
    };
  }
  return {
    id,
    source: 'lxns',
    sourceSongId: song.id,
    sourceMetadata: sourceSongMetadata(song),
    title: song.title,
    type,
    artist: song.artist,
    category,
    bpm: song.bpm,
    version: DISPLAY_VERSION[version.title] ?? version.title,
    versionCode: version.version,
    isNew: type !== 'utage' && version.version === gameVersion,
    disabled: song.disabled ?? false,
    locked: group.every((c) => c.locked ?? false),
    releaseDate: group.every((c) => c.release_date)
      ? group.map((c) => c.release_date!).sort()[0]
      : null,
    rights: song.rights ?? null,
    charts,
    catalogRevision: '',
    catalogVersion: '',
    gameVersion,
    sync: { createdAt: now, updatedAt: now, lastSyncedAt: now },
  };
}

export function parseLxnsCatalog(
  payload: unknown,
  gameVersion = LXNS_GAME_VERSION,
  now = new Date(),
) {
  const data = catalogSchema.parse(payload);
  unique(
    data.songs.map((s) => s.id),
    'source song id',
  );
  unique(
    data.genres.map((g) => g.genre),
    'genre',
  );
  unique(
    data.versions.map((v) => v.version),
    'version',
  );
  const genres = new Map(data.genres.map((g) => [g.genre, g.title]));
  const versions = [...data.versions].sort((a, b) => a.version - b.version);
  if (!versions.some((v) => v.version === gameVersion)) {
    throw new Error('Target game version is absent from LXNS versions');
  }
  const mainVersion = (code: number) => {
    const version = versions.findLast((v) => v.version <= code);
    if (!version) {
      throw new Error(`Unknown chart version ${code}`);
    }
    return version;
  };
  const documents: LxnsCatalogMusic[] = [];
  for (const song of data.songs) {
    const category = genres.get(song.genre);
    if (!category) {
      throw new Error(`Unknown genre ${song.genre}`);
    }
    mainVersion(song.version);
    let groups = 0;
    for (const type of ['standard', 'dx', 'utage'] as const) {
      const group = song.difficulties[type] ?? [];
      if (!group.length) {
        continue;
      }
      groups++;
      documents.push(
        convertGroup(
          song,
          type,
          group,
          category,
          mainVersion,
          gameVersion,
          now,
        ),
      );
    }
    if (!groups) {
      throw new Error(`Song ${song.id} has no charts`);
    }
  }
  documents.sort((a, b) => Number(a.id) - Number(b.id));
  unique(
    documents.map((m) => m.id),
    'local music id',
  );
  const hash = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  const catalogVersion = hash(
    catalogCompatibilityProjection(documents, gameVersion),
  );
  const revision = catalogContentRevision(documents);
  for (const m of documents) {
    m.catalogRevision = revision;
    m.catalogVersion = catalogVersion;
  }
  return {
    documents,
    revision,
    catalogVersion,
    sourceSongCount: data.songs.length,
    gameVersion,
  };
}

export function catalogContentRevision(
  rows: readonly LxnsCatalogMusic[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        rows.map(({ sync, ...m }) => {
          void sync;
          return { ...m, catalogRevision: '', catalogVersion: '' };
        }),
      ),
      'utf8',
    )
    .digest('hex');
}
