import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaimaiFriendApi } from "../common/maimai/friend-api.ts";
import { runCleanup } from "../common/bots/background-tasks/cleanup-friends.ts";
import { retainFriends } from "../common/friend-policy.ts";
import { sendRequest } from "../worker/jobs/handlers/send-friend-request/stages/send_request.ts";
import { waitAcceptance } from "../worker/jobs/handlers/send-friend-request/stages/wait_acceptance.ts";
import { waitForUserRequest } from "../worker/jobs/handlers/accept-friend-request/stages/wait_user_request.ts";
import { updateScoreJobHandler } from "../worker/jobs/handlers/update-score/index.ts";
import type { JobExecutionContext } from "../worker/jobs/handlers/index.ts";
import { FriendListSnapshotStore } from "../common/bots/stores/friend-list-snapshot-store.ts";

// Importing the singleton normally starts live background tasks. Disable them
// before loading it so this test cannot restore cookies or contact the game.
const previousBackgroundMode = process.env.BOT_BACKGROUND_TASKS_DISABLED;
const previousCookiePath = process.env.COOKIE_PERSIST_PATH;
process.env.BOT_BACKGROUND_TASKS_DISABLED = "true";
process.env.COOKIE_PERSIST_PATH = join(tmpdir(), `friend-retention-${randomUUID()}`, "cookies.json");
const { SharedEligibility, LocalEligibilityError } =
  await import("../worker/runtime/shared-eligibility.ts");
const { botManager } = await import("../common/bots/bot-manager.ts");
if (previousBackgroundMode === undefined)
  delete process.env.BOT_BACKGROUND_TASKS_DISABLED;
else process.env.BOT_BACKGROUND_TASKS_DISABLED = previousBackgroundMode;
if (previousCookiePath === undefined) delete process.env.COOKIE_PERSIST_PATH;
else process.env.COOKIE_PERSIST_PATH = previousCookiePath;

function harness(
  options: {
    friend?: boolean;
    sent?: boolean;
    full?: boolean;
    received?: boolean;
    sendFails?: boolean;
    acceptFails?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const friends = {
    isFriendBySearchPage: async () => !!options.friend,
    isFriend: async () => !!options.friend,
    hasSentFriendRequest: async () => !!options.sent,
    hasReceivedFriendRequest: async () => !!options.received,
    getFriendList: async () =>
      Array.from({ length: options.full ? 50 : 1 }, (_, i) => ({
        friendCode: String(i),
      })),
    sendFriendRequest: async () => {
      calls.push("send");
      if (options.sendFails) throw new Error("network");
      options.sent = true;
    },
    allowFriendRequest: async () => {
      calls.push("accept");
      if (options.acceptFails) throw new Error("accept failed");
      options.friend = true;
    },
    cleanUpFriend: async () => {
      throw new Error("cleanup must not run");
    },
    cancelFriendRequest: async () => {
      throw new Error("cancel must not run");
    },
    blockFriendRequest: async () => {
      throw new Error("block must not run");
    },
  };
  const ctx = {
    job: {
      id: "test",
      friendCode: "target",
      createdAt: new Date(),
      cabinetFriendshipStatus: "not_required",
      routing: { assignmentMode: "pinned" },
    },
    client: { friends },
    completeJob: async () => {
      calls.push("complete");
    },
    transitionTo: async (stage: string) => {
      calls.push(stage);
    },
    fail: async () => {
      calls.push("fail");
    },
    delay: async () => {
      calls.push("delay");
    },
  } as unknown as JobExecutionContext;
  return { calls, ctx };
}

test("retain friends protects every deletion boundary and skips periodic cleanup", async () => {
  const old = process.env.DXNET_FRIEND_POLICY;
  process.env.DXNET_FRIEND_POLICY = "retain";
  try {
    let requests = 0;
    const api = new MaimaiFriendApi({
      requestPage: async () => {
        requests++;
        throw new Error("unexpected request");
      },
    } as never);
    for (const method of [
      "removeFriend",
      "cancelFriendRequest",
      "blockFriendRequest",
      "cleanUpFriend",
    ] as const) {
      await assert.rejects(api[method]("target"), /FRIEND_RETENTION_ENABLED/);
    }
    assert.equal(requests, 0);
    await runCleanup({
      getBot: () => {
        throw new Error("cleanup must not inspect bot");
      },
    } as never);
    const snapshot = new FriendListSnapshotStore();
    snapshot.replace([{ friendCode: "target", isFavorite: false }]);
    snapshot.recordFriendRelation("target", false);
    assert.equal(
      snapshot.getSnapshot()!.friends.length,
      0,
      "local snapshot correction is not game deletion",
    );
  } finally {
    if (old === undefined) delete process.env.DXNET_FRIEND_POLICY;
    else process.env.DXNET_FRIEND_POLICY = old;
  }
});

test("retain reuses friends and pending requests; checks capacity only for new friends", async () => {
  const old = process.env.DXNET_FRIEND_POLICY;
  process.env.DXNET_FRIEND_POLICY = "retain";
  try {
    const friend = harness({ friend: true, full: true });
    await sendRequest(friend.ctx);
    assert.deepEqual(friend.calls, ["complete"]);
    const pending = harness({ sent: true, full: true });
    await sendRequest(pending.ctx);
    assert.deepEqual(pending.calls, ["wait_acceptance"]);
    const full = harness({ full: true });
    await assert.rejects(sendRequest(full.ctx), /FRIEND_CAPACITY_EXHAUSTED/);
    assert.deepEqual(full.calls, []);
    const newFriend = harness();
    await sendRequest(newFriend.ctx);
    assert.deepEqual(newFriend.calls, ["send", "wait_acceptance"]);
    const failed = harness({ sendFails: true });
    await assert.rejects(sendRequest(failed.ctx), /FRIEND_REQUEST_UNCONFIRMED/);
    assert.deepEqual(failed.calls, ["send"]);
    const received = harness({ received: true });
    await waitForUserRequest(received.ctx);
    assert.deepEqual(received.calls, ["accept_request", "accept", "complete"]);
    const rejected = harness({ received: true, acceptFails: true });
    await assert.rejects(waitForUserRequest(rejected.ctx), /accept failed/);
    assert.deepEqual(rejected.calls, ["accept_request", "accept"]);
    const timeout = harness({ sent: true });
    timeout.ctx.job.createdAt = new Date(0);
    await assert.rejects(waitAcceptance(timeout.ctx), /超时/);
    assert.deepEqual(timeout.calls, []);
    const missing = harness();
    assert.equal(
      await updateScoreJobHandler.preflight!(missing.ctx),
      "complete_delivery",
    );
    assert.deepEqual(missing.calls, ["fail"]);
    assert.equal(
      await updateScoreJobHandler.preflight!(friend.ctx),
      "continue",
    );
  } finally {
    if (old === undefined) delete process.env.DXNET_FRIEND_POLICY;
    else process.env.DXNET_FRIEND_POLICY = old;
  }
});

test("legacy remains default and invalid configuration fails closed", () => {
  const old = process.env.DXNET_FRIEND_POLICY;
  try {
    delete process.env.DXNET_FRIEND_POLICY;
    assert.equal(retainFriends(), false);
    process.env.DXNET_FRIEND_POLICY = "typo";
    assert.throws(retainFriends, /must be/);
  } finally {
    if (old === undefined) delete process.env.DXNET_FRIEND_POLICY;
    else process.env.DXNET_FRIEND_POLICY = old;
  }
});

test("retain rejects unknown or incomplete snapshots without recording them", async () => {
  const old = process.env.DXNET_FRIEND_POLICY;
  process.env.DXNET_FRIEND_POLICY = "retain";
  try {
    for (const body of [
      "unknown page",
      "<span>好友数</span><br><span>1</span>/100",
      "<span>好友数</span><br><span>11</span>/100",
    ]) {
      let recorded = false;
      const api = new MaimaiFriendApi(
        { requestPage: async () => ({ body }) } as never,
        {
          onFriendListFetched: () => {
            recorded = true;
          },
        },
      );
      await assert.rejects(api.getFriendList(), /FRIEND_SNAPSHOT_UNKNOWN/);
      assert.equal(recorded, false);
    }
  } finally {
    if (old === undefined) delete process.env.DXNET_FRIEND_POLICY;
    else process.env.DXNET_FRIEND_POLICY = old;
  }
});

test("retain full shared claim is rejected without clearing local or game friends", async () => {
  const old = process.env.DXNET_FRIEND_POLICY;
  const original = botManager.friendListSnapshots.getSnapshot;
  process.env.DXNET_FRIEND_POLICY = "retain";
  let inspections = 0;
  const calls: string[] = [];
  botManager.friendListSnapshots.getSnapshot = () => {
    inspections++;
    return {
      friends: Array.from({ length: 50 }, (_, i) => ({
        friendCode: String(i),
        isFavorite: false,
      })),
      updatedAt: new Date(),
    };
  };
  try {
    const eligibility = new SharedEligibility({
      pauseShared: async () => {
        calls.push("pause");
      },
      resumeShared: async () => {
        calls.push("resume");
      },
    } as never);
    await assert.rejects(
      eligibility.ensureEligible({} as never, new AbortController().signal),
      LocalEligibilityError,
    );
    assert.deepEqual(calls, ["pause", "resume"]);
    assert.equal(inspections, 1);
  } finally {
    botManager.friendListSnapshots.getSnapshot = original;
    if (old === undefined) delete process.env.DXNET_FRIEND_POLICY;
    else process.env.DXNET_FRIEND_POLICY = old;
  }
});
