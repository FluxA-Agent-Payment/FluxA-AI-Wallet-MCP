import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearPrivateKey, hasPrivateKey, loadPrivateKeyEncrypted, memory, persistPolicy, savePrivateKeyEncrypted, setInMemoryPrivateKey } from '../store/store.js';
import { getApproval, approve as approveAppr, deny as denyAppr } from '../store/approvals.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startWebServer() {
  if (process.env.WEB_DISABLE === '1') {
    console.error('[web] disabled via WEB_DISABLE env');
    return null;
  }
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Static minimal UI
  app.get('/', (_req: any, res: any) => {
    res.type('html').send(renderIndex());
  });

  app.get('/api/config', (_req: any, res: any) => {
    res.json({
      wallet: {
        hasKey: hasPrivateKey(),
        unlocked: Boolean(memory.privateKey),
        address: memory.address,
      },
      policy: memory.policy,
    });
  });

  app.post('/api/wallet/load', async (req: any, res: any) => {
    const { privateKey, passphrase, persist } = req.body || {};
    if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      return res.status(400).json({ error: 'invalid_private_key' });
    }
    setInMemoryPrivateKey(privateKey);
    if (persist && passphrase) {
      try {
        await savePrivateKeyEncrypted(privateKey, passphrase);
      } catch (e: any) {
        return res.status(500).json({ error: 'save_failed', message: e?.message });
      }
    }
    return res.json({ ok: true });
  });

  app.post('/api/wallet/unlock', async (req: any, res: any) => {
    const { passphrase } = req.body || {};
    try {
      const pk = await loadPrivateKeyEncrypted(passphrase);
      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(400).json({ error: 'unlock_failed', message: e?.message });
    }
  });

  app.post('/api/wallet/clear', (_req: any, res: any) => {
    clearPrivateKey();
    res.json({ ok: true });
  });

  app.post('/api/policy', (req: any, res: any) => {
    const { policy } = req.body || {};
    try {
      persistPolicy(policy);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: 'invalid_policy', message: e?.message });
    }
  });

  // Approvals UI
  app.get('/consents/:id', (req: any, res: any) => {
    const ap = getApproval(req.params.id);
    if (!ap) return res.status(404).send('Not Found');
    res.type('html').send(renderApproval(ap));
  });
  app.post('/consents/:id/approve', (req: any, res: any) => {
    const ap = approveAppr(req.params.id);
    if (!ap) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });
  app.post('/consents/:id/deny', (req: any, res: any) => {
    const ap = denyAppr(req.params.id);
    if (!ap) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });

  const port = Number(process.env.WEB_PORT || 3078);
  let server: any = null;
  try {
    await new Promise<void>((resolve, reject) => {
      server = app
        .listen(port, () => resolve())
        .on('error', (err: any) => reject(err));
    });
    return { app, port, server };
  } catch (err: any) {
    console.error(`[web] failed to listen on port ${port}: ${err?.message || err}`);
    return null;
  }
}

function renderIndex() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FluxA AI Wallet MCP - Config</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; margin: 24px; }
    section { border: 1px solid #ddd; padding: 16px; border-radius: 8px; margin-bottom: 16px; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    label { display: block; margin-top: 8px; }
    input[type=text], input[type=password] { width: 100%; padding: 8px; }
    button { margin-top: 8px; padding: 8px 12px; }
    code { background: #f7f7f7; padding: 2px 4px; border-radius: 4px; }
    .row { display: flex; gap: 12px; }
    .row > div { flex: 1; }
  </style>
  <script>
    async function refresh() {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      const wallet = cfg.wallet || {};
      const statusParts = [];
      if (wallet.hasKey) {
        statusParts.push('Loaded');
      } else {
        statusParts.push('Not loaded');
      }
      statusParts.push(wallet.unlocked ? '(unlocked)' : '(locked)');
      if (wallet.address) statusParts.push(wallet.address);
      document.getElementById('status').textContent = statusParts.join(' ');
      document.getElementById('policy').textContent = JSON.stringify(cfg.policy, null, 2);
    }
    async function saveKey(ev) {
      ev.preventDefault();
      const privateKey = document.getElementById('pk').value.trim();
      const passphrase = document.getElementById('pass').value.trim();
      const persist = document.getElementById('persist').checked;
      const res = await fetch('/api/wallet/load', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ privateKey, passphrase, persist }) });
      const data = await res.json();
      alert(res.ok ? 'Loaded' : ('Error: ' + (data.error || 'failed')));
      refresh();
    }
    async function unlock(ev) {
      ev.preventDefault();
      const passphrase = document.getElementById('unlock_pass').value.trim();
      const res = await fetch('/api/wallet/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase }) });
      const data = await res.json();
      alert(res.ok ? 'Unlocked' : ('Error: ' + (data.error || 'failed')));
      refresh();
    }
    async function clearKey() {
      const res = await fetch('/api/wallet/clear', { method: 'POST' });
      const data = await res.json();
      alert('Cleared');
      refresh();
    }
    async function savePolicy(ev) {
      ev.preventDefault();
      const policyText = document.getElementById('policy_edit').value;
      let policy;
      try { policy = JSON.parse(policyText); } catch { return alert('Invalid JSON'); }
      const res = await fetch('/api/policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy }) });
      alert(res.ok ? 'Saved' : 'Failed');
      refresh();
    }
    window.addEventListener('load', refresh);
  </script>
  </head>
<body>
  <h1>FluxA AI Wallet MCP</h1>
  <section>
    <h2>Wallet</h2>
    <div>Status: <code id="status">...</code></div>
    <form onsubmit="saveKey(event)">
      <label>Private Key (0x...64 hex)<input id="pk" type="text" /></label>
      <label>Encryption Passphrase (optional)<input id="pass" type="password" /></label>
      <label><input id="persist" type="checkbox" /> Persist encrypted to disk</label>
      <button type="submit">Load Key</button>
      <button type="button" onclick="clearKey()">Clear</button>
    </form>
    <form onsubmit="unlock(event)">
      <label>Unlock with Passphrase<input id="unlock_pass" type="password" /></label>
      <button type="submit">Unlock</button>
    </form>
  </section>
  <section>
    <h2>Policy</h2>
    <pre id="policy" style="background:#f7f7f7;padding:8px;border-radius:6px;min-height:100px"></pre>
    <form onsubmit="savePolicy(event)">
      <label>Edit Policy JSON<textarea id="policy_edit" rows="10" style="width:100%"></textarea></label>
      <button type="submit">Save Policy</button>
    </form>
  </section>
  <section>
    <h2>Approvals</h2>
    <p>When a request needs approval, the MCP tool returns an approval URL like <code>/consents/:id</code>.</p>
  </section>
</body>
</html>`;
}

function renderApproval(ap: any) {
  const payload = JSON.stringify(ap.payload, null, 2);
  return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Approval ${ap.id}</title>
<style> body{font-family:-apple-system,system-ui,sans-serif;margin:24px} pre{background:#f7f7f7;padding:8px;border-radius:6px} button{padding:8px 12px;margin-right:8px} </style>
</head>
<body>
  <h1>Approval ${ap.id}</h1>
  <div>Status: ${ap.status}</div>
  <pre>${payload}</pre>
  <form method="post" action="/consents/${ap.id}/approve"><button type="submit">Approve</button></form>
  <form method="post" action="/consents/${ap.id}/deny"><button type="submit">Deny</button></form>
</body></html>`;
}
