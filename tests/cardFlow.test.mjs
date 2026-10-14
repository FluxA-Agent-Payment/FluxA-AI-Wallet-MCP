import test from 'node:test';
import assert from 'node:assert/strict';
import { runCardFlow } from '../dist/wallet/cardFlow.js';
import { WalletApiError } from '../dist/wallet/client.js';
import { cardAmount, cardSelector, cardProfile } from '../dist/wallet/cardOptions.js';

const pending = (status, extra = {}) => ({ pendingRequestId: 'req_1', requestType: 'issue', status, ...extra });
const options = { requestType: 'issue', waitSeconds: 5 };

function harness(initial, responses = []) {
  const calls = [];
  let clock = 0;
  const deps = {
    initiate: async () => { calls.push('initiate'); return initial; },
    getRequest: async id => { calls.push(['get', id]); return responses.shift(); },
    sign: async payment => { calls.push(['sign', payment]); return 'signed-payload'; },
    complete: async (request, payload) => {
      calls.push(['complete', request.pendingRequestId, payload]);
      return { success: false, status: 'payment_submitted', pendingRequestId: request.pendingRequestId };
    },
    now: () => clock,
    sleep: async ms => { clock += ms; },
  };
  return { calls, deps };
}

test('holder review becomes payable and settlement completes using one intent', async () => {
  const payment = { x402Version: 2, accepts: [{ amount: '25000000' }] };
  const card = { id: 'card_1', cardTypeId: 'ct_one' };
  const { deps, calls } = harness(pending('pending_cardholder'), [
    pending('pending_payment', { paymentRequest: payment }), pending('completed', { card }),
  ]);
  const result = await runCardFlow(options, deps);
  assert.equal(result.request.card, card);
  assert.deepEqual(calls, [
    'initiate', ['get', 'req_1'], ['sign', payment],
    ['complete', 'req_1', 'signed-payload'], ['get', 'req_1'],
  ]);
});

test('zero wait returns review state without signing', async () => {
  const { deps, calls } = harness(pending('pending_cardholder'));
  assert.equal((await runCardFlow({ ...options, waitSeconds: 0 }, deps)).request.status, 'pending_cardholder');
  assert.deepEqual(calls, ['initiate']);
});

test('review polling stops at its deadline and keeps the original request', async () => {
  const { deps, calls } = harness(pending('pending_cardholder'));
  deps.getRequest = async id => { calls.push(['get', id]); return pending('pending_cardholder'); };
  const result = await runCardFlow(options, deps);
  assert.equal(result.request.pendingRequestId, 'req_1');
  assert.equal(result.request.status, 'pending_cardholder');
  assert.deepEqual(calls, ['initiate', ['get', 'req_1'], ['get', 'req_1'], ['get', 'req_1']]);
});

test('resume a payable intent without initiating another purchase', async () => {
  const payment = { x402Version: 2 };
  const { deps, calls } = harness(null, [pending('pending_payment', { paymentRequest: payment })]);
  deps.complete = async (request, payload) => {
    calls.push(['complete', request.pendingRequestId, payload]);
    return { success: true, card: { id: 'card_1' } };
  };
  assert.equal((await runCardFlow({ ...options, requestId: 'req_1' }, deps)).request.status, 'completed');
  assert.deepEqual(calls, [['get', 'req_1'], ['sign', payment], ['complete', 'req_1', 'signed-payload']]);
});

test('resume submitted payment only polls; it never signs again', async () => {
  const { deps, calls } = harness(null, [pending('payment_submitted'), pending('completed', { card: { id: 'card_1' } })]);
  await runCardFlow({ ...options, requestId: 'req_1' }, deps);
  assert.deepEqual(calls, [['get', 'req_1'], ['get', 'req_1']]);
});

test('a stale payable poll after completion does not trigger another payment', async () => {
  const { deps, calls } = harness(pending('pending_payment', { paymentRequest: {} }), [pending('pending_payment', { paymentRequest: {} })]);
  const result = await runCardFlow(options, deps);
  assert.equal(result.request.status, 'pending_payment');
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'sign').length, 1);
});

test('waitlist and unavailable access errors never reach signing or completion', async () => {
  for (const [code, status] of [['card_waitlist_required', 403], ['card_access_unavailable', 503]]) {
    const { deps, calls } = harness(null);
    deps.initiate = async () => { throw new WalletApiError('Access rejected', status, { code }); };
    await assert.rejects(runCardFlow(options, deps), error => error.details.code === code);
    assert.deepEqual(calls, []);
  }
});

test('failed completion preserves the original request ID and never retries automatically', async () => {
  const { deps, calls } = harness(pending('pending_payment', { paymentRequest: {} }));
  let attempts = 0;
  deps.complete = async () => { attempts++; throw new Error('Connection lost after submission'); };
  await assert.rejects(runCardFlow(options, deps), error => {
    assert.equal(error.details.details.pendingRequestId, 'req_1');
    assert.match(error.details.details.continueCommand, /--request-id req_1/);
    return true;
  });
  assert.equal(attempts, 1);
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'sign').length, 1);
});

test('wrong request type, card, or request ID is rejected before signing', async () => {
  for (const response of [
    pending('pending_payment', { requestType: 'recharge', paymentRequest: {} }),
    pending('pending_payment', { pendingRequestId: 'req_other', paymentRequest: {} }),
  ]) {
    const { deps, calls } = harness(null, [response]);
    await assert.rejects(runCardFlow({ ...options, requestId: 'req_1' }, deps));
    assert.deepEqual(calls, [['get', 'req_1']]);
  }
  const { deps, calls } = harness(null, [pending('pending_payment', { requestType: 'recharge', cardId: 'card_other', paymentRequest: {} })]);
  await assert.rejects(runCardFlow({ ...options, requestType: 'recharge', requestId: 'req_1', cardId: 'card_1' }, deps));
  assert.deepEqual(calls, [['get', 'req_1']]);
});

test('action required and terminal failures do not create or pay another intent', async () => {
  for (const status of ['action_required', 'failed', 'expired', 'refunded']) {
    const { deps, calls } = harness(pending(status, { nextAction: 'review_cardholder' }));
    await assert.rejects(runCardFlow(options, deps), error => {
      assert.equal(error.details.code, `card_request_${status}`);
      assert.equal(error.details.details.pendingRequestId, 'req_1');
      return true;
    });
    assert.deepEqual(calls, ['initiate']);
  }
});

test('amounts and product selectors preserve decimal precision and string IDs', () => {
  assert.equal(cardAmount('00025.1'), '25.10');
  assert.equal(cardAmount('9007199254740993.01'), '9007199254740993.01');
  for (const amount of ['0', '-1', '1.001', '1e2', 'true']) assert.throws(() => cardAmount(amount));
  assert.deepEqual(cardSelector({ 'bin-id': '00123' }), { binId: '00123' });
  assert.throws(() => cardSelector({}));
  assert.throws(() => cardSelector({ 'card-type-id': 'ct_one', bin: '123456' }));
});

test('profile requires real complete fields for create but permits partial updates', () => {
  const profile = { firstName: 'Alice', lastName: 'Example', email: 'alice@example.com', phone: '+8613800000000', address: { country: 'CN', city: '上海', line1: '真实地址', postalCode: '200000' } };
  assert.deepEqual(cardProfile(profile, false), profile);
  assert.throws(() => cardProfile({ firstName: 'Alice', lastName: 'Example' }, false));
  assert.throws(() => cardProfile({ ...profile, phone: '13800000000' }, false));
  assert.deepEqual(cardProfile({ address: { city: '北京' } }, true), { address: { city: '北京' } });
});
