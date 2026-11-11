import { JobFriendshipService } from './job-friendship.service';
import { JobService } from './job.service';

function harness() {
  const snapshots = {
    findBotHavingFriend: jest.fn().mockResolvedValue(null),
    findFreshBotHavingFriend: jest.fn().mockResolvedValue(null),
    hasFriend: jest.fn().mockResolvedValue(true),
  };
  const status = {
    getAll: jest.fn().mockResolvedValue([{ friendCode: 'offline' }]),
  };
  const service = new JobFriendshipService(
    {} as never,
    {} as never,
    snapshots as never,
    status as never,
  );
  return { snapshots, service };
}

const original = process.env.DXNET_FRIEND_POLICY;
afterEach(() => {
  if (original === undefined) {
    delete process.env.DXNET_FRIEND_POLICY;
  } else {
    process.env.DXNET_FRIEND_POLICY = original;
  }
});
describe('retained friendship routing', () => {
  it('reuses persisted snapshots across restart without requiring another binding', async () => {
    process.env.DXNET_FRIEND_POLICY = 'retain';
    const { snapshots, service } = harness();
    snapshots.findBotHavingFriend.mockResolvedValue('bot');
    await expect(
      service.resolveFreshSnapshotBot({
        friendCode: 'user',
        botFriendCodes: ['bot'],
        now: new Date(),
      }),
    ).resolves.toBe('bot');
    expect(snapshots.findFreshBotHavingFriend).not.toHaveBeenCalled();
  });
  it('reports an unavailable existing bot instead of treating the relationship as absent', async () => {
    process.env.DXNET_FRIEND_POLICY = 'retain';
    const { snapshots, service } = harness();
    snapshots.findBotHavingFriend
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('offline');
    await expect(
      service.resolveFreshSnapshotBot({
        friendCode: 'user',
        botFriendCodes: ['online'],
        now: new Date(),
      }),
    ).rejects.toMatchObject({ response: { code: 'friend_bot_unavailable' } });
  });
  it('retains the five-minute snapshot rule in legacy mode', async () => {
    delete process.env.DXNET_FRIEND_POLICY;
    const { snapshots, service } = harness();
    const now = new Date();
    await service.resolveFreshSnapshotBot({
      friendCode: 'user',
      botFriendCodes: ['bot'],
      now,
    });
    expect(snapshots.findFreshBotHavingFriend).toHaveBeenCalledWith(
      'user',
      ['bot'],
      new Date(now.getTime() - 300000),
    );
    expect(snapshots.findBotHavingFriend).not.toHaveBeenCalled();
  });
});

describe('retained friendship capacity', () => {
  it('routes existing friends to a full bot and does not reserve an extra friend slot', async () => {
    process.env.DXNET_FRIEND_POLICY = 'retain';
    const count = jest.fn().mockResolvedValue(100);
    const friendship = {
      resolveFreshSnapshotBot: jest.fn().mockResolvedValue('bot'),
      hasRetainedFriend: jest.fn().mockResolvedValue(true),
      resolveRetainedPendingBot: jest.fn().mockResolvedValue(null),
    };
    const service = new JobService(
      { countDocuments: count } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      friendship as never,
      {} as never,
      {
        getByFriendCode: jest.fn().mockResolvedValue({ friendCount: 80 }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const subject = service as unknown as {
      resolveV2FriendInteraction(
        input: unknown,
        bots: unknown[],
        now: Date,
      ): Promise<unknown>;
      assertEffectiveFriendCapacity(
        bot: string,
        id: string,
        worker: boolean,
        friend: string,
        pending?: boolean,
      ): Promise<void>;
    };
    await expect(
      subject.resolveV2FriendInteraction(
        { friendCode: 'user' },
        [{ friendCode: 'bot', friendCount: 80 }],
        new Date(),
      ),
    ).resolves.toMatchObject({
      botUserFriendCode: 'bot',
      cabinetStatus: 'not_required',
    });
    await expect(
      subject.assertEffectiveFriendCapacity('bot', 'job', false, 'user'),
    ).resolves.toBeUndefined();
    expect(count).not.toHaveBeenCalled();
    friendship.hasRetainedFriend.mockResolvedValue(false);
    await expect(
      subject.assertEffectiveFriendCapacity('bot', 'job', false, 'new'),
    ).rejects.toThrow('capacity is exhausted');
    friendship.resolveFreshSnapshotBot.mockResolvedValue(null);
    await expect(
      subject.resolveV2FriendInteraction(
        { friendCode: 'new' },
        [{ friendCode: 'bot', friendCount: 80 }],
        new Date(),
      ),
    ).rejects.toThrow();
    friendship.resolveRetainedPendingBot.mockResolvedValue('bot');
    await expect(
      subject.resolveV2FriendInteraction(
        { friendCode: 'pending', jobType: 'send_friend_request' },
        [{ friendCode: 'bot', friendCount: 80 }],
        new Date(),
      ),
    ).resolves.toMatchObject({ botUserFriendCode: 'bot' });
    await expect(
      subject.assertEffectiveFriendCapacity(
        'bot',
        'job',
        false,
        'pending',
        true,
      ),
    ).resolves.toBeUndefined();
    await expect(
      subject.assertEffectiveFriendCapacity(
        'bot',
        'job',
        false,
        'pending',
        false,
      ),
    ).rejects.toThrow();
    await expect(
      subject.resolveV2FriendInteraction(
        { friendCode: 'pending', jobType: 'accept_friend_request' },
        [{ friendCode: 'bot', friendCount: 80 }],
        new Date(),
      ),
    ).rejects.toThrow();
  });
});

describe('retained pending request lookup', () => {
  it('limits routing hints to the target, eligible bots and sent requests; legacy does not query', async () => {
    const original = process.env.DXNET_FRIEND_POLICY;
    const query = {
      sort: jest.fn(),
      lean: jest.fn(),
      exec: jest.fn().mockResolvedValue({ botUserFriendCode: 'bot' }),
    };
    query.sort.mockReturnValue(query);
    query.lean.mockReturnValue(query);
    const model = { findOne: jest.fn().mockReturnValue(query) };
    const service = new JobFriendshipService(
      model as never,
      {} as never,
      {} as never,
      {} as never,
    );
    try {
      process.env.DXNET_FRIEND_POLICY = 'retain';
      await expect(
        service.resolveRetainedPendingBot('user', ['bot']),
      ).resolves.toBe('bot');
      expect(model.findOne).toHaveBeenCalledWith({
        friendCode: 'user',
        botUserFriendCode: { $in: ['bot'] },
        jobType: 'send_friend_request',
        stage: 'wait_acceptance',
        friendRequestSentAt: { $ne: null },
      });
      model.findOne.mockClear();
      delete process.env.DXNET_FRIEND_POLICY;
      await expect(
        service.resolveRetainedPendingBot('user', ['bot']),
      ).resolves.toBeNull();
      expect(model.findOne).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete process.env.DXNET_FRIEND_POLICY;
      } else {
        process.env.DXNET_FRIEND_POLICY = original;
      }
    }
  });
});
