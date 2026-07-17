export const statusOrder = Object.freeze({
  ACCEPTED: 0,
  SUBMITTED: 1,
  SENT: 2,
  DELIVERED: 3,
  FAILED: 3
});

export function mapNexusStatus(rawStatus) {
  const value = String(rawStatus || '').toLowerCase();
  if (['accepted', 'queued', 'submitted'].includes(value)) return 'SUBMITTED';
  if (['sent', 'in_transit'].includes(value)) return 'SENT';
  if (['delivered', 'success'].includes(value)) return 'DELIVERED';
  if (['failed', 'rejected', 'undeliverable', 'expired'].includes(value)) return 'FAILED';
  return null;
}

export function mapOrbitStatus(rawStatus) {
  const value = String(rawStatus || '').toLowerCase();
  if (['accepted', 'queued', 'submitted', 'processing'].includes(value)) return 'SUBMITTED';
  if (['sent', 'in_transit'].includes(value)) return 'SENT';
  if (['delivered', 'success'].includes(value)) return 'DELIVERED';
  if (['failed', 'rejected', 'undeliverable', 'expired'].includes(value)) return 'FAILED';
  return null;
}

export function canTransition(current, next) {
  if (current === next) return false;
  if (current === 'DELIVERED' || current === 'FAILED') return false;
  if (next === 'FAILED') return true;
  return statusOrder[next] > statusOrder[current];
}
