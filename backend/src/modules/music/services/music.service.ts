import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';
import type { Cache } from 'cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { ScoreFetchTarget } from '@maimai-score-hub/shared';

import { MusicEntity } from '../schemas/music.schema';
import {
  lxnsCatalogUrl,
  parseLxnsCatalog,
  LXNS_GAME_VERSION,
} from '../../../common/prober/lxns/catalog';
import { publishLxnsCatalog } from '../../../common/prober/lxns/catalog-store';
import { observeFetch } from '../../../common/observability/external-call-recorder';

const MUSIC_DATA_SOURCE = 'lxns';
const CATEGORY_GENRE: Record<string, number> = {
  '流行&动漫': 101,
  'niconico＆VOCALOID™': 102,
  东方Project: 103,
  其他游戏: 104,
  舞萌: 105,
  '音击/中二节奏': 106,
};
const LEVEL_PARAMETER = new Map(
  [
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '7+',
    '8',
    '8+',
    '9',
    '9+',
    '10',
    '10+',
    '11',
    '11+',
    '12',
    '12+',
    '13',
    '13+',
    '14',
    '14+',
    '15',
  ].map((level, index) => [level, index + 1] as const),
);

@Injectable()
export class MusicService {
  private readonly logger = new Logger(MusicService.name);

  constructor(
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicEntity>,
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER)
    private readonly cache: Cache,
  ) {}

  private async fetchJson(
    url: string,
    signal?: AbortSignal,
  ): Promise<ResponseLike> {
    signal?.throwIfAborted();
    if (typeof fetch === 'function') {
      return observeFetch(
        {
          target: 'lxns',
          apiGroup: 'catalog',
          method: 'GET',
          urlGroup: 'lxns.song_list',
          statusCode: 0,
          durationMs: 0,
        },
        () => fetch(url, { signal }),
      );
    }

    // Fallback for environments without global fetch (Node <18)
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? httpsRequest : httpRequest;

    return new Promise<ResponseLike>((resolve, reject) => {
      const req = client(parsed, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: unknown) => {
          chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d)));
        });
        res.on('end', () => {
          signal?.removeEventListener('abort', abortRequest);
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok:
              res.statusCode !== undefined &&
              res.statusCode >= 200 &&
              res.statusCode < 300,
            status: res.statusCode ?? 0,
            json: () => Promise.resolve(JSON.parse(body) as unknown),
          });
        });
      });
      const abortRequest = () => {
        req.destroy(this.abortError(signal));
      };
      if (signal?.aborted) {
        abortRequest();
      } else {
        signal?.addEventListener('abort', abortRequest, { once: true });
      }
      req.on('error', (error) => {
        signal?.removeEventListener('abort', abortRequest);
        reject(error);
      });
      req.end();
    });
  }

  async findAll() {
    // Read the atomically published collection. Do not retain a per-process old revision.
    const result = await this.musicModel.find().sort({ id: 1 }).lean();
    return result;
  }

  async resolveScoreFetchTargets(musicIds: string[]): Promise<{
    targets: ScoreFetchTarget[];
    missing: string[];
  }> {
    const requested = [...new Set(musicIds)];
    const requestedSet = new Set(requested);
    if (!requested.length) {
      return { targets: [], missing: [] };
    }
    const rows = await this.musicModel
      .find({ 'charts.cid': { $in: requested } })
      .select('id title type category charts')
      .lean<MusicEntity[]>();
    const resolved = new Map<string, ScoreFetchTarget>();
    for (const music of rows) {
      if (!Array.isArray(music.charts)) {
        continue;
      }
      music.charts.forEach((chart, chartIndex) => {
        const musicId = chart?.cid;
        if (!musicId || !requestedSet.has(musicId)) {
          return;
        }
        const utage = music.type === 'utage';
        resolved.set(musicId, {
          musicId,
          title: music.title,
          type: utage ? 'utage' : music.type === 'dx' ? 'dx' : 'standard',
          category: music.category ?? '',
          diff: utage ? 10 : chartIndex,
          genre: utage ? 99 : (CATEGORY_GENRE[music.category ?? ''] ?? null),
          level: utage
            ? null
            : (LEVEL_PARAMETER.get(chart.level ?? '') ?? null),
        });
      });
    }
    return {
      targets: requested.flatMap((musicId) => {
        const target = resolved.get(musicId);
        return target ? [target] : [];
      }),
      missing: requested.filter((musicId) => !resolved.has(musicId)),
    };
  }

  async syncMusicData(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const gameVersion = Number(
      this.configService.get<string | number>(
        'LXNS_GAME_VERSION',
        LXNS_GAME_VERSION,
      ),
    );
    const sourceUrl = lxnsCatalogUrl(gameVersion);
    this.logger.log(
      `Syncing music data from ${MUSIC_DATA_SOURCE} (${sourceUrl}) ...`,
    );
    try {
      const response = await this.fetchJson(sourceUrl, signal);
      if (!response.ok) {
        throw new Error(`LXNS responded with status ${response.status}`);
      }
      const snapshot = parseLxnsCatalog(await response.json(), gameVersion);
      signal?.throwIfAborted();
      const db = this.musicModel.db.db;
      if (!db) {
        throw new Error('Catalog database is not connected');
      }
      const result = await publishLxnsCatalog(db, snapshot, signal);
      return {
        ...result,
        catalogVersion: snapshot.catalogVersion,
        sourceSongCount: snapshot.sourceSongCount,
      };
    } catch (error) {
      this.logger.error(
        'LXNS catalog sync failed; previous verified catalog retained',
        error instanceof Error ? error.stack : String(error),
      );
      throw new InternalServerErrorException('LXNS catalog sync failed');
    }
  }

  private abortError(signal?: AbortSignal): Error {
    return signal?.reason instanceof Error
      ? signal.reason
      : new Error('Music sync aborted');
  }
}

interface ResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
