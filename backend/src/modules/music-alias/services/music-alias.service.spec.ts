import { MusicAliasService } from './music-alias.service';

function harness() {
  const insertMany = jest.fn().mockResolvedValue({});
  const rename = jest.fn().mockResolvedValue({});
  const drop = jest.fn().mockResolvedValue({});
  const candidate = {
    insertMany,
    rename,
    drop,
    createIndex: jest.fn().mockResolvedValue({}),
  };
  const lean = jest.fn().mockResolvedValue([]);
  const aliases = {
    db: { db: { collection: jest.fn(() => candidate) } },
    find: jest.fn(() => ({ select: () => ({ lean }) })),
  };
  const music = {
    find: jest.fn(() => ({
      lean: () =>
        Promise.resolve([
          { id: '30', sourceSongId: 30 },
          { id: '10030', sourceSongId: 30 },
        ]),
    })),
  };
  const redis = { getJson: jest.fn(), setJson: jest.fn() };
  const service = new MusicAliasService(
    aliases as never,
    music as never,
    {} as never,
    redis as never,
  );
  return { service, aliases, lean, insertMany, rename, drop, redis };
}
const payload = { aliases: [{ song_id: 30, aliases: ['\u5723\u8bde\u6b4c'] }] };
function mockFetch(body: unknown = payload, status = 200) {
  return jest.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    expect(url).toBe('https://maimai.lxns.net/api/v0/maimai/alias/list');
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });
}

describe('MusicAliasService LXNS-only', () => {
  afterEach(() => jest.restoreAllMocks());
  it('expands the verified source ID to SD/DX without requesting other catalogs', async () => {
    const h = harness();
    const fetch = mockFetch();
    const result = await h.service.syncAll();
    expect(result.sources.yuzuchan.status).toBe('skipped');
    expect(result.sources.lxns.status).toBe('completed');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({ musicIds: ['30', '10030'], source: 'lxns' }),
    ]);
    expect(h.rename).toHaveBeenCalledWith('music_aliases_lxns', {
      dropTarget: true,
    });
  });
  it.each([{}, { aliases: [] }, { aliases: [{ song_id: 30, aliases: [4] }] }])(
    'rejects malformed batches before writing: %j',
    async (body) => {
      const h = harness();
      mockFetch(body);
      await expect(h.service.syncAll()).rejects.toThrow();
      expect(h.insertMany).not.toHaveBeenCalled();
      expect(h.rename).not.toHaveBeenCalled();
    },
  );
  it('preserves the live snapshot on fetch failure', async () => {
    const h = harness();
    mockFetch({}, 503);
    await expect(h.service.syncAll()).rejects.toThrow('503');
    expect(h.rename).not.toHaveBeenCalled();
  });
  it('preserves the live snapshot and removes only candidate after write failure', async () => {
    const h = harness();
    mockFetch();
    h.insertMany.mockRejectedValue(new Error('disk full'));
    await expect(h.service.syncAll()).rejects.toThrow('disk full');
    expect(h.rename).not.toHaveBeenCalled();
    expect(h.drop).toHaveBeenCalledTimes(1);
  });
  it('groups only LXNS aliases and never reads mixed-source caches', async () => {
    const h = harness();
    h.lean.mockResolvedValue([
      {
        source: 'lxns',
        musicIds: ['30', '10030'],
        alias: 'DX\u5723\u8bde\u6b4c',
        normalizedAlias: 'dx\u5723\u8bde\u6b4c',
        syncedAt: '2026-08-30T01:00:00Z',
      },
      {
        source: 'yuzuchan',
        musicIds: ['10030'],
        alias: 'dx\u5723\u8bde\u6b4c',
        normalizedAlias: 'dx\u5723\u8bde\u6b4c',
        syncedAt: '2026-08-30T02:00:00Z',
      },
    ]);
    await expect(h.service.findAll()).resolves.toEqual({
      revision: '2026-08-30T01:00:00.000Z',
      aliases: [
        { musicId: '30', aliases: ['DX\u5723\u8bde\u6b4c'] },
        { musicId: '10030', aliases: ['DX\u5723\u8bde\u6b4c'] },
      ],
    });
    expect(h.aliases.find).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'lxns' }),
    );
    expect(h.redis.getJson).not.toHaveBeenCalled();
  });
});
