import type { JobExecutionContext } from "../../index.ts";
import { retainFriends } from "../../../../../common/friend-policy.ts";

export async function acceptRequest(ctx: JobExecutionContext): Promise<void> {
  if (
    retainFriends() &&
    (await ctx.client.friends.isFriendBySearchPage(ctx.job.friendCode))
  ) {
    await ctx.completeJob();
    return;
  }
  console.log(
    `[JobHandler] Job ${ctx.job.id}: Accepting user friend request...`,
  );
  await ctx.client.friends.allowFriendRequest(ctx.job.friendCode);
  await ctx.completeJob();
}
