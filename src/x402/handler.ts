import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { networkToChainId } from './networks.js';
import type { PaymentRequired, PaymentRequirements, XPayment } from './types.js';
import { EIP3009_TYPES, TransferWithAuthorization, randomNonce32 } from './eip3009.js';
import { memory, hasPrivateKey } from '../store/store.js';
import { policyCheck, type Intent } from '../policy/policy.js';
import { createApproval } from '../store/approvals.js';

export const PMC_PRIMER = '请阅读并遵循 pmc.instructions，确保向用户说明接下来的支付步骤。';

function pickRequirement(pr: PaymentRequired, selection?: any, options?: any): { req: PaymentRequirements; index: number } {
  const accepts = pr.accepts;
  if (selection?.acceptIndex != null && accepts[selection.acceptIndex]) {
    return { req: accepts[selection.acceptIndex], index: selection.acceptIndex };
  }
  const preferredNet = options?.preferred_network;
  const preferredAsset = options?.preferred_asset?.toLowerCase();

  // Simple selection: first exact & supported network & supported asset
  for (let i = 0; i < accepts.length; i++) {
    const a = accepts[i];
    if (a.scheme !== 'exact') continue;
    const okNet = networkToChainId(a.network) != null;
    if (!okNet) continue;
    if (preferredNet && a.network !== preferredNet) continue;
    if (preferredAsset && a.asset.toLowerCase() !== preferredAsset) continue;
    return { req: a, index: i };
  }
  throw new Error('no_supported_requirement');
}

export async function selectRequirementAndSign({
  paymentRequired,
  selection,
  intent,
  options,
}: {
  paymentRequired: PaymentRequired;
  selection?: any;
  intent: Intent;
  options?: any;
}): Promise<
  | {
      status: 'ok';
      x_payment_b64: string;
      x_payment: XPayment;
      address: Address;
      chainId: number;
      expires_at: number;
      pmc: { primer: string; instructions: string };
      audit?: any;
    }
  | {
      status: 'need_approval';
      approval_id: string;
      approval_url?: string;
      reason: string;
      expires_at: number;
      pmc: { primer: string; instructions: string };
      audit?: any;
    }
  | {
      status: 'denied' | 'error';
      code: string;
      message: string;
      pmc: { primer: string; instructions: string };
      audit?: any;
    }
> {
  if (!memory.privateKey) {
    if (hasPrivateKey()) {
      return {
        status: 'error',
        code: 'wallet_locked',
        message: 'Wallet key is stored but locked. Unlock it before signing.',
        pmc: {
          primer: PMC_PRIMER,
          instructions: '检测到钱包密钥已存储但未解锁。请提示用户在配置页面输入解锁口令，或通过 PRIVATE_KEY 环境变量重新加载明文密钥后再试。',
        },
      };
    }
    return {
      status: 'error',
      code: 'wallet_not_configured',
      message: 'Wallet private key not set. Configure it in the web UI.',
      pmc: {
        primer: PMC_PRIMER,
        instructions:
          '钱包尚未配置。提示用户先在配置界面 http://localhost:3078/ 加载或解锁钱包私钥，然后重试支付操作。',
      },
    };
  }

  // Choose requirement
  let picked: { req: PaymentRequirements; index: number };
  try {
    picked = pickRequirement(paymentRequired, selection, options);
  } catch (e: any) {
    return {
      status: 'error',
      code: 'no_supported_requirement',
      message: e?.message || String(e),
      pmc: {
        primer: PMC_PRIMER,
        instructions: '当前 402 请求中没有可处理的 exact/EIP-3009 支付方案。提示用户确认服务端是否支持 Base USDC exact 支付。',
      },
    };
  }

  const req = picked.req;
  const chainId = networkToChainId(req.network);
  if (!chainId) {
    return {
      status: 'error',
      code: 'unsupported_network',
      message: `Unsupported network ${req.network}`,
      pmc: {
        primer: PMC_PRIMER,
        instructions: `请求使用了不受支持的网络 ${req.network}。提示用户检查策略配置或联系支持团队增开该网络。`,
      },
    };
  }
  if (!req.extra || !req.extra.name || !req.extra.version) {
    return {
      status: 'error',
      code: 'invalid_request',
      message: 'extra.name and extra.version are required for EIP-3009 domain',
      pmc: {
        primer: PMC_PRIMER,
        instructions: 'X-402 请求缺少资产的 name/version 信息，无法生成 EIP-3009 域。提示用户联系服务端修复该响应。',
      },
    };
  }

  // If approval_id provided and approved, skip policy checks
  let skipPolicy = false;
  if (options?.approval_id) {
    const { getApproval } = await import('../store/approvals.js');
    const ap = getApproval(options.approval_id);
    if (ap?.status === 'approved') {
      skipPolicy = true;
    } else if (ap?.status === 'denied') {
      return {
        status: 'denied',
        code: 'user_denied',
        message: 'Denied by user',
        pmc: {
          primer: PMC_PRIMER,
          instructions: '用户在审批流程中拒绝了此次支付。提示用户如需继续，请重新发起审批并确认授权。',
        },
      };
    }
  }

  // Policy
  const pc = skipPolicy ? { allow: true } : policyCheck({ requirement: req, intent, options });
  if (!pc.allow) {
    if (pc.needApproval) {
      const approval = createApproval({ type: 'x402', req, intent, reason: pc.reason });
      const port = Number(process.env.WEB_PORT || 3078);
      const approvalUrl = `http://localhost:${port}/consents/${approval.id}`;
      return {
        status: 'need_approval',
        approval_id: approval.id,
        // Provide a local approval URL if web server is running on default port
        approval_url: approvalUrl,
        reason: pc.reason || 'needs_approval',
        expires_at: Math.floor(Date.now() / 1000) + Math.min(req.maxTimeoutSeconds, 600),
        pmc: {
          primer: PMC_PRIMER,
          instructions: `该请求需要人工授权。请告知用户打开 ${approvalUrl} 或通过其他审批渠道确认本次支付，授权完成后再次调用工具并携带 approval_id。`,
        },
        audit: { decision: 'need_approval', reason: pc.reason, req, intent },
      };
    }
    return {
      status: 'denied',
      code: 'policy_denied',
      message: pc.reason || 'denied by policy',
      pmc: {
        primer: PMC_PRIMER,
        instructions:
          pc.reason === 'origin_mismatch'
            ? `检测到请求地址 ${intent.http_url} 与策略允许的资源不匹配。请提示用户检查 402 resource/策略配置，确认域名与 URL 一致后再试。`
            : `策略拒绝了本次支付（原因：${pc.reason || '未知'}）。请提示用户调整策略或联系管理员处理。`,
      },
      audit: { decision: 'denied', reason: pc.reason, req, intent },
    };
  }

  // Build authorization
  const now = Math.floor(Date.now() / 1000);
  const windowSec = Math.max(1, Math.min(Number(options?.validity_window_seconds || 60), req.maxTimeoutSeconds));
  const validAfter = String(now - 1);
  const validBefore = String(now + windowSec);
  const nonce = randomNonce32();

  const account = privateKeyToAccount(memory.privateKey);
  memory.address = account.address as Address;

  const auth: TransferWithAuthorization = {
    from: account.address,
    to: req.payTo as Address,
    value: req.maxAmountRequired,
    validAfter,
    validBefore,
    nonce,
  };

  const domain = {
    name: req.extra.name!,
    version: req.extra.version!,
    chainId,
    verifyingContract: req.asset as Address,
  } as const;

  const signature = await account.signTypedData({
    domain,
    primaryType: 'TransferWithAuthorization',
    types: EIP3009_TYPES as any,
    message: auth as any,
  });

  const x_payment: XPayment = {
    x402Version: paymentRequired.x402Version,
    scheme: 'exact',
    network: req.network,
    payload: {
      signature,
      authorization: {
        from: auth.from,
        to: auth.to,
        value: auth.value,
        validAfter: auth.validAfter,
        validBefore: auth.validBefore,
        nonce: auth.nonce,
      },
    },
  };

  const x_payment_b64 = Buffer.from(JSON.stringify(x_payment)).toString('base64');

  return {
    status: 'ok',
    x_payment_b64,
    x_payment,
    address: account.address,
    chainId,
    expires_at: Number(validBefore),
    pmc: {
      primer: PMC_PRIMER,
      instructions:
        '签名已生成。请指引用户在后续请求中携带返回的 X-PAYMENT 头（即 x_payment_b64），以完成受保护资源的访问。',
    },
    audit: { decision: 'ok', req, intent, address: account.address },
  };
}
