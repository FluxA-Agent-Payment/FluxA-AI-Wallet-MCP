import { WalletApiError } from './client.js';
import type {
  CardChargeInitiateResponse,
  CompleteCardResponse,
  CompleteRechargeResponse,
} from './client.js';

type Completion = CompleteCardResponse | CompleteRechargeResponse;

export interface CardFlowDependencies {
  initiate: () => Promise<CardChargeInitiateResponse>;
  getRequest: (id: string) => Promise<CardChargeInitiateResponse>;
  sign: (paymentRequest: any) => Promise<string>;
  complete: (request: CardChargeInitiateResponse, payload: string) => Promise<Completion>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface CardFlowOptions {
  requestId?: string;
  requestType: 'issue' | 'recharge';
  cardId?: string;
  waitSeconds: number;
}

export interface CardFlowResult {
  request: CardChargeInitiateResponse;
  completion?: Completion;
}

const WAITING_STATUSES = new Set([
  'pending_cardholder', 'payment_submitted', 'paying', 'issuing', 'refunding',
]);
const ACTION_STATUSES = new Set(['action_required', 'failed', 'expired', 'refunded']);

function validateRequest(request: CardChargeInitiateResponse, options: CardFlowOptions, id?: string) {
  if (!request || typeof request.pendingRequestId !== 'string' || !request.pendingRequestId || !request.status) {
    throw new Error('Invalid card service request response');
  }
  if (id && request.pendingRequestId !== id) throw new Error('Card service returned a different request ID');
  if ((options.requestId && request.requestType !== options.requestType) ||
      (request.requestType && request.requestType !== options.requestType)) {
    throw new Error(`Request is not a ${options.requestType} request; use the matching card command`);
  }
  if (options.cardId && request.cardId && options.cardId !== request.cardId) {
    throw new Error('Request belongs to a different card');
  }
  if (options.requestType === 'recharge' && request.status === 'pending_payment' && !request.cardId && !options.cardId) {
    throw new Error('Recharge request has no cardId; provide the original --id');
  }
}

/** Continue one purchase intent. Signing/completion are never blindly retried. */
export async function runCardFlow(options: CardFlowOptions, deps: CardFlowDependencies): Promise<CardFlowResult> {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = now() + options.waitSeconds * 1000;
  let id = options.requestId;
  let request: CardChargeInitiateResponse | undefined;
  let completion: Completion | undefined;
  let submitted = false;

  try {
    request = id ? await deps.getRequest(id) : await deps.initiate();
    const expectedId = id;
    if (!id && typeof request?.pendingRequestId === 'string') id = request.pendingRequestId;
    validateRequest(request, options, expectedId);
    id = request.pendingRequestId;
    for (;;) {
      if (ACTION_STATUSES.has(request.status)) {
        throw new WalletApiError(`Card request ${request.status}; review the request before continuing`, 409, {
          code: `card_request_${request.status}`,
          details: { status: request.status, nextAction: request.nextAction },
        });
      }
      if (request.status === 'completed') return { request, completion };
      if (request.status === 'pending_payment' && !submitted) {
        if (!request.paymentRequest) throw new Error('Payable card request has no paymentRequest');
        const payload = await deps.sign(request.paymentRequest);
        completion = await deps.complete(request, payload);
        submitted = true;
        if (completion.success) {
          return { request: { ...request, status: 'completed', card: completion.card }, completion };
        }
        if (completion.pendingRequestId !== id) throw new Error('Completion returned a different request ID');
        request = { ...request, status: completion.status, paymentRequest: undefined };
      }
      // Unknown/recovery states are surfaced to the caller, never treated as payable.
      if (!WAITING_STATUSES.has(request.status) || now() >= deadline) return { request, completion };
      await sleep(Math.min(2000, Math.max(0, deadline - now())));
      request = await deps.getRequest(id);
      validateRequest(request, options, id);
    }
  } catch (error: any) {
    if (!id) throw error;
    const body = error instanceof WalletApiError && error.details && typeof error.details === 'object'
      ? error.details : {};
    throw new WalletApiError(error?.message || 'Card request failed', error?.status, {
      ...body,
      details: {
        ...body.details,
        pendingRequestId: id,
        requestType: options.requestType,
        continueCommand: `fluxa-wallet card ${options.requestType === 'issue' ? 'create' : 'recharge'} --request-id ${id} --mandate <mandate_id>`,
        ...(request?.cardId || options.cardId ? { cardId: request?.cardId || options.cardId } : {}),
      },
    });
  }
}
