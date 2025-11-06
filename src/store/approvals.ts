import { memory, persistApprovals } from './store.js';

export function createApproval(payload: any) {
  const id = `appr_${Math.random().toString(36).slice(2, 10)}`;
  memory.approvals[id] = { id, status: 'pending', payload, createdAt: Date.now() };
  persistApprovals();
  return memory.approvals[id];
}

export function getApproval(id: string) {
  return memory.approvals[id];
}

export function approve(id: string) {
  const ap = memory.approvals[id];
  if (ap) {
    ap.status = 'approved';
    ap.approvedAt = Date.now();
    persistApprovals();
  }
  return ap;
}

export function deny(id: string) {
  const ap = memory.approvals[id];
  if (ap) {
    ap.status = 'denied';
    ap.deniedAt = Date.now();
    persistApprovals();
  }
  return ap;
}

