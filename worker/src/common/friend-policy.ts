/** Legacy is opt-in compatible; invalid values fail closed before game mutations. */
export function retainFriends(): boolean {
  const policy = process.env.DXNET_FRIEND_POLICY ?? "legacy";
  if (policy !== "legacy" && policy !== "retain") {
    throw new Error("DXNET_FRIEND_POLICY must be legacy or retain");
  }
  return policy === "retain";
}

export function assertFriendRemovalAllowed(): void {
  if (retainFriends()) {
    throw new Error(
      "FRIEND_RETENTION_ENABLED: friend removal and request cancellation are disabled",
    );
  }
}
