export function retainFriends(): boolean {
  const policy = process.env.DXNET_FRIEND_POLICY ?? 'legacy';
  if (policy !== 'legacy' && policy !== 'retain') {
    throw new Error('DXNET_FRIEND_POLICY must be legacy or retain');
  }
  return policy === 'retain';
}
