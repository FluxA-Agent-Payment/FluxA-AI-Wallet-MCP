import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../packages/fluxa-wallet/bin/fluxa-wallet.js', import.meta.url));

// A synthetic ledger, newest first, every row in the same second so only the
// id orders them (the router orders by created_at, then id).
const makeLedger = (n, prefix = 'e') =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${String(n - i).padStart(5, '0')}`,
    ts: '2026-11-01T12:00:00.000Z',
    type: i % 5 === 0 ? 'topup' : 'meter',
    change: i % 5 === 0 ? 5 : -0.01234,
    balanceRemaining: 10 - i * 0.01,
    metadata: i % 5 === 0
      ? { order_id: `ord_${i}`, package_slug: 'starter', x402_tx_hash: '0xabc', payer: '0xpayer' }
      : { model: 'gpt-x', usage: { prompt_tokens: 10, completion_tokens: 4 }, api_key_id: 'key_1', agent_id: 'agent_secret', cost_breakdown: { x: 1 } },
  }));

test('market model usage commands', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fluxa-usage-test-'));
  let balances, ledger, ledgerHook, calls, failLedger;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push(u.pathname + u.search);
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/llm/wallet/balances') return res.end(JSON.stringify(balances));
    if (u.pathname === '/llm/wallet/ledger') {
      if (failLedger && failLedger(u)) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'Internal error' })); }
      const offset = Number(u.searchParams.get('offset') || 0);
      const limit = Number(u.searchParams.get('limit') || 20);
      ledgerHook?.(offset);
      return res.end(JSON.stringify({ kind: u.searchParams.get('kind'), total: ledger.length, offset, limit, entries: ledger.slice(offset, offset + limit) }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `unexpected ${req.url}` }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const run = async (...args) => {
    calls = [];
    const child = spawn(process.execPath, [cli, 'market', 'model', ...args], {
      env: { ...process.env, FLUXA_KEY: 'fxa_live_test', FLUXA_DATA_DIR: dir, MARKET_PROXY: url, MARKET_PLATFORM: url, AGENT_ID_API: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { code, stdout, stderr };
  };
  const json = r => { assert.equal(r.code, 0, r.stdout + r.stderr); return JSON.parse(r.stdout); };

  await t.test('remainingUsage: a missing burn rate is unknown, not 0 and ok', async () => {
    balances = { balance: { available: 12.5, owed: 0 } };
    const r = await run('remainingUsage');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\$12\.50/);
    assert.match(r.stdout, /unknown/);
    assert.doesNotMatch(r.stdout, /\bok\b/);
    assert.doesNotMatch(r.stdout, /\$0\.00/);
  });

  await t.test('remainingUsage: a real 0 burn is 0 and ok', async () => {
    balances = { balance: { available: 12.5, burnPerDay: 0, owed: 0 } };
    const r = await run('remainingUsage');
    assert.match(r.stdout, /\$0\.00/);
    assert.match(r.stdout, /\bok\b/);
  });

  await t.test('remainingUsage: a missing or invalid balance is unknown, not $0', async () => {
    for (const b of [{ burnPerDay: 1 }, { available: 'n/a', burnPerDay: 1 }]) {
      balances = { balance: b };
      const r = await run('remainingUsage');
      assert.match(r.stdout, /unknown/);
      assert.doesNotMatch(r.stdout, /\bok\b|\blow\b/);
    }
  });

  await t.test('remainingUsage: old Units-only server still works', async () => {
    balances = { accounts: [{ balance: 1_000_000, burn7dPerDay: 100_000, pendingSettlement: 0 }] };
    const r = await run('remainingUsage');
    assert.match(r.stdout, /\$10\.00/);
    assert.match(r.stdout, /\$1\.00/);
    assert.match(r.stdout, /\bok\b/);
  });

  await t.test('usageHistory: one page says it is incomplete and where to go next', async () => {
    ledger = makeLedger(25);
    const r = await run('usageHistory');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /when \(UTC\)/);
    assert.match(r.stdout, /entries 1–20 of 25/);
    assert.match(r.stdout, /--offset 20/);
    assert.deepEqual(calls, ['/llm/wallet/ledger?kind=all&limit=20&offset=0']);
    const d = json(await run('usageHistory', '--json'));
    assert.equal(d.total, 25);
    assert.equal(d.returned, 20);
    assert.equal(d.complete, false);
    assert.equal(d.nextOffset, 20);
    assert.equal(d.timezone, 'UTC');
    assert.equal(d.unit, 'Balance');
  });

  await t.test('usageHistory: --offset reads the rest, last page is complete-at-end', async () => {
    ledger = makeLedger(25);
    const d = json(await run('usageHistory', '--offset', '20', '--json'));
    assert.equal(d.returned, 5);
    assert.equal(d.nextOffset, null);
    assert.equal(d.entries[4].id, 'e00001');
    const empty = json(await run('usageHistory', '--offset', '40', '--json'));
    assert.equal(empty.returned, 0);
    assert.equal(empty.nextOffset, null);
  });

  await t.test('usageHistory --json: narrowed fields, UTC timestamps, no colour codes', async () => {
    ledger = makeLedger(6);
    const r = await run('usageHistory', '--json');
    assert.doesNotMatch(r.stdout, /\x1b\[/);
    assert.doesNotMatch(r.stdout, /agent_secret|cost_breakdown|0xpayer/);
    const d = JSON.parse(r.stdout);
    assert.equal(d.complete, true);
    const [topup, meter] = d.entries;
    assert.equal(topup.ts, '2026-11-01T12:00:00.000Z');
    assert.deepEqual([topup.type, topup.change, topup.orderId, topup.bundle, topup.txHash], ['topup', 5, 'ord_0', 'starter', '0xabc']);
    assert.deepEqual([meter.model, meter.tokens, meter.apiKeyId, meter.change], ['gpt-x', { input: 10, output: 4 }, 'key_1', -0.01234]);
  });

  await t.test('usageHistory: missing amounts and bad times stay unknown', async () => {
    ledger = [{ id: 'x1', ts: 'garbage', type: 'meter' }];
    const d = json(await run('usageHistory', '--json'));
    assert.deepEqual([d.entries[0].ts, d.entries[0].change, d.entries[0].balanceRemaining], [null, null, null]);
    const r = await run('usageHistory');
    assert.doesNotMatch(r.stdout, /\$0\.00/);
  });

  await t.test('usageHistory: old Units-only entries are converted', async () => {
    ledger = [{ ts: '2026-11-01T00:00:00Z', type: 'topup', amount: 500000, balanceAfter: 1500000 }];
    const d = json(await run('usageHistory', '--json'));
    assert.deepEqual([d.entries[0].change, d.entries[0].balanceRemaining], [5, 15]);
  });

  await t.test('usageHistory --all: reads every page with no gaps or repeats', async () => {
    ledger = makeLedger(250);
    const d = json(await run('usageHistory', '--all', '--json'));
    assert.equal(d.returned, 250);
    assert.equal(d.complete, true);
    assert.equal(new Set(d.entries.map(e => e.id)).size, 250);
    assert.deepEqual(calls, [0, 100, 200].map(o => `/llm/wallet/ledger?kind=all&limit=100&offset=${o}`));
  });

  await t.test('usageHistory --all: rows arriving mid-walk are not double counted', async () => {
    ledger = makeLedger(150);
    ledgerHook = offset => { if (offset === 100) ledger = [{ id: 'new1', ts: '2026-11-02T00:00:00Z', type: 'meter', change: -1, balanceRemaining: 1 }, ...ledger]; };
    try {
      const d = json(await run('usageHistory', '--all', '--json'));
      const ids = d.entries.map(e => e.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(ids.length, 150);
      assert.match(d.note, /new entries arrived/);
    } finally { ledgerHook = undefined; }
  });

  await t.test('usageHistory --all: without ids a moving ledger is marked incomplete', async () => {
    ledger = makeLedger(150).map(({ id, ...e }) => e);
    ledgerHook = offset => { if (offset === 100) ledger = [{ ts: '2026-11-02T00:00:00Z', type: 'meter', change: -1, balanceRemaining: 1 }, ...ledger]; };
    try {
      const d = json(await run('usageHistory', '--all', '--json'));
      assert.equal(d.complete, false);
      assert.match(d.note, /may repeat/);
    } finally { ledgerHook = undefined; }
  });

  await t.test('usageHistory --all: a failing page fails the command, not a short history', async () => {
    ledger = makeLedger(250);
    failLedger = u => u.searchParams.get('offset') === '100';
    try {
      const r = await run('usageHistory', '--all', '--json');
      assert.equal(r.code, 1);
      assert.doesNotMatch(r.stdout, /"complete"/);
    } finally { failLedger = undefined; }
  });

  await t.test('usageHistory: bad options are refused before any call', async () => {
    for (const args of [['--limit', '0'], ['--limit', '101'], ['--limit', '2.5'], ['--offset', '-1'], ['--kind', 'refunds'], ['--all', '--offset', '5']]) {
      const r = await run('usageHistory', ...args);
      assert.equal(r.code, 1, args.join(' '));
      assert.deepEqual(calls, [], args.join(' '));
    }
  });

  await t.test('usageHistory: --kind is passed through', async () => {
    ledger = makeLedger(3);
    await run('usageHistory', '--kind', 'spend', '--limit', '50');
    assert.deepEqual(calls, ['/llm/wallet/ledger?kind=spend&limit=50&offset=0']);
  });
});
