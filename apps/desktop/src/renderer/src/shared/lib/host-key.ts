type Hosted = { id: string; hostId?: string };

export function hostKey(id: string, hostId = 'local') {
  return hostId === 'local' ? id : `${hostId}/${id}`;
}

export function entityKey(entity: Hosted) {
  return hostKey(entity.id, entity.hostId);
}
