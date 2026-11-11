import {
  ProberExportMapService,
  type ProberExportMap,
} from './prober-export-map.service';

type TestableMapService = {
  buildMap: () => Promise<ProberExportMap>;
};

function mapFixture(): ProberExportMap {
  return {
    toDivingFishId: new Map([['1', '1']]),
    toLxnsId: new Map([['1', '101']]),
    divingFishTitleByDbId: new Map([['1', 'test']]),
  };
}

describe('ProberExportMapService', () => {
  it('shares concurrent builds but rechecks the catalog on subsequent calls', async () => {
    const service = new ProberExportMapService({} as never);
    const fixture = mapFixture();
    let resolveBuild: (value: ProberExportMap) => void = () => undefined;
    const pending = new Promise<ProberExportMap>((resolve) => {
      resolveBuild = resolve;
    });
    const build = jest
      .spyOn(service as unknown as TestableMapService, 'buildMap')
      .mockReturnValue(pending);

    const requests = Array.from({ length: 64 }, () => service.getMap());
    await Promise.resolve();
    expect(build).toHaveBeenCalledTimes(1);

    resolveBuild(fixture);
    const results = await Promise.all(requests);
    expect(results.every((result) => result === fixture)).toBe(true);
    await expect(service.getMap()).resolves.toBe(fixture);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('clears a failed cold build so a later request can retry', async () => {
    const service = new ProberExportMapService({} as never);
    const fixture = mapFixture();
    const build = jest
      .spyOn(service as unknown as TestableMapService, 'buildMap')
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValueOnce(fixture);

    await expect(service.getMap()).rejects.toThrow('catalog unavailable');
    await expect(service.getMap()).resolves.toBe(fixture);
    expect(build).toHaveBeenCalledTimes(2);
  });
});

it('uses verified local source IDs and sees a later catalog without any network request', async () => {
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('network forbidden'));
  try {
    const lean = jest.fn().mockResolvedValue([
      { id: '30', sourceSongId: 30, type: 'standard', title: 'LXNS title' },
      { id: '10030', sourceSongId: 30, type: 'dx', title: 'LXNS title' },
      { id: '100018', sourceSongId: 100018, type: 'utage' },
    ]);
    const model = { find: jest.fn(() => ({ lean })) };
    const service = new ProberExportMapService(model as never);
    const first = await service.getMap();
    expect(first.toLxnsId.get('10030')).toBe('30');
    expect(first.toDivingFishId.has('100018')).toBe(false);
    expect(first.divingFishTitleByDbId.get('30')).toBe('LXNS title');
    lean.mockResolvedValue([
      { id: '30', sourceSongId: 30, type: 'standard', title: 'updated' },
    ]);
    const next = await service.getMap();
    expect(next.toLxnsId.has('10030')).toBe(false);
    expect(next.divingFishTitleByDbId.get('30')).toBe('updated');
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
