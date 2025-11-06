import { URL } from 'node:url';
import { memory } from '../store/store.js';

export type Intent = {
  why: string;
  http_method: string;
  http_url: string;
  caller: string;
  trace_id?: string;
  prompt_summary?: string;
};

export function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.host === ub.host;
  } catch {
    return false;
  }
}

export function policyCheck({
  requirement,
  intent,
  options,
}: {
  requirement: {
    scheme: string;
    network: string;
    asset: string;
    resource: string;
    maxAmountRequired: string;
  };
  intent: Intent;
  options?: { require_user_approval?: boolean };
}): { allow: boolean; needApproval?: boolean; reason?: string } {
  const p = memory.policy!;
  if (requirement.scheme !== 'exact') {
    return { allow: false, reason: 'unsupported_scheme' };
  }
  if (!p.networksAllow.includes(requirement.network)) {
    return { allow: false, reason: 'unsupported_network' };
  }
  const allowedAssets = p.assetsAllow[requirement.network] || [];
  if (!allowedAssets.map((s) => s.toLowerCase()).includes(requirement.asset.toLowerCase())) {
    return { allow: false, reason: 'unsupported_asset' };
  }

  // origin check
  if (!sameOrigin(requirement.resource, intent.http_url)) {
    return { allow: false, reason: 'origin_mismatch' };
  }

  // per-origin limits
  try {
    const origin = new URL(requirement.resource).host;
    const perTxWei = p.perTxLimitByOriginWei[origin];
    if (perTxWei) {
      const requested = BigInt(requirement.maxAmountRequired);
      if (requested > BigInt(perTxWei)) {
        return { allow: false, needApproval: true, reason: 'over_per_tx_limit' };
      }
    } else if (p.unknownOriginNeedsApproval) {
      return { allow: false, needApproval: true, reason: 'unknown_origin' };
    }
  } catch {}

  if (options?.require_user_approval) {
    return { allow: false, needApproval: true, reason: 'user_forced_approval' };
  }

  // auto-approve small amounts
  try {
    const threshold = BigInt(memory.policy!.autoApproveUnderWei || '0');
    if (threshold > 0n) {
      const requested = BigInt(requirement.maxAmountRequired);
      if (requested <= threshold) {
        return { allow: true };
      }
    }
  } catch {}

  // default allow within allowed assets/networks, but leave room for UI confirmation policy evolution.
  return { allow: true };
}

