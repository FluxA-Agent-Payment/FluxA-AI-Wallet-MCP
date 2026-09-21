// ---------------------------------------------------------------------------
// market — FluxA marketplace commands, folded into the fluxa-wallet CLI.
//
// Ported from the standalone planner CLI (cli/planner.mjs). These are the
// consumer/agent-facing commands: discover resources, inspect model rates,
// check prepaid Units balances, manage fxa_live_ API keys, and get tool-use
// recommendations. Creator commands (`api *`) are NOT here — they belong to a
// separate `monetize` CLI.
//
// Identity is in-process: unlike planner, which shelled out to
// `fluxa-wallet refreshJWT`, we reuse the wallet's own Agent ID + JWT and mint
// a short-lived Agent VC directly against the AgentID issue endpoint.
//
// Config (env):
//   FLUXA_KEY        fxa_live_… API key (optional; else an Agent VC is minted)
//   MARKET_PLATFORM  default https://agentmarket.fluxapay.xyz      (discovery, models)
//   MARKET_PROXY     default https://proxy-monetize.fluxapay.xyz (balances, keys, plan)
//   AGENT_ID_API     default https://agentid.fluxapay.xyz       (VC issue)
// ---------------------------------------------------------------------------

import { refreshJWT, isJWTExpired } from '../wallet/client.js';
import { getEffectiveAgentId, updateJWT } from '../agent/agentId.js';
import { planLines } from './plan-format.js';

const PLATFORM = (process.env.MARKET_PLATFORM || process.env.FLUXA_PLATFORM || 'https://agentmarket.fluxapay.xyz').replace(/\/$/, '');
const PROXY = (process.env.MARKET_PROXY || process.env.FLUXA_PROXY || 'https://proxy-monetize.fluxapay.xyz').replace(/\/$/, '');
const AGENT_ID_API = (process.env.AGENT_ID_API || 'https://agentid.fluxapay.xyz').replace(/\/$/, '');
const UNIT_USD = 0.00001;

export interface MarketResult {
  success: boolean;
  raw?: string;
  error?: string;
  code?: string;
}

// Thrown by command/helper functions; caught by runMarketCommand and mapped to
// a failed MarketResult. Mirrors planner's die() semantics.
class MarketError extends Error {}
function die(msg: string): never {
  throw new MarketError(msg);
}

// --- ANSI (identical palette to planner) ------------------------------------
const tty = process.stdout.isTTY;
const sgr = (n: string | number) => (s: string | number) => (tty ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const c = {
  dim: sgr(2), bold: sgr(1),
  lime: sgr('38;2;166;224;0'), green: sgr('38;2;87;200;120'),
  red: sgr('38;2;229;96;77'), cyan: sgr(36), gray: sgr(90),
};
const KIND: Record<string, string> = { model: c.cyan('model'), api: c.lime('api  '), skill: c.green('skill') };
const pad = (s: any, n: number): string => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n); };
const usd = (units: number): string => { const v = (units || 0) * UNIT_USD; return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`; };
// The planner brain occasionally HTML-escapes angle brackets in free text
// (e.g. "&lt;merchant&gt;"); un-escape the common entities for terminal output.
// &amp; is undone LAST so "&amp;lt;" doesn't collapse into "<".
const unesc = (s: any): any => typeof s === 'string'
  ? s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#3?9;/g, "'").replace(/&amp;/g, '&')
  : s;

// --- auth --------------------------------------------------------------------
// Mint a short-lived Agent VC in-process: reuse the wallet's Agent ID + login
// JWT (refreshing if expired), then have the AgentID service ISSUE the VC.
// Audience MUST be `fluxa-wallet-service` — the proxy's credential resolver
// only trusts VCs issued for that audience.
async function mintVc(): Promise<string> {
  const cfg = getEffectiveAgentId();
  if (!cfg) {
    die('no Agent ID — register once with `fluxa-wallet init --name "<agent>" --client "<client>"`, then retry.');
  }
  let jwt = cfg.jwt;
  if (!jwt || isJWTExpired(jwt)) {
    try {
      jwt = await refreshJWT(cfg.agent_id, cfg.token);
      updateJWT(jwt);
    } catch (e: any) {
      die(`could not refresh Agent ID JWT (${e?.message}). Check \`fluxa-wallet status\`.`);
    }
  }
  let res: Response;
  try {
    res = await fetch(`${AGENT_ID_API}/agent/vc/issue`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ challenge: 'wallet-user-info-lookup', ttl_seconds: 300, audience: 'fluxa-wallet-service' }),
    });
  } catch (e: any) {
    die(`network error reaching ${new URL(AGENT_ID_API).host}: ${e?.message}`);
  }
  const j: any = await res.json().catch(() => ({}));
  const vc = j.vc || j?.data?.vc;
  if (!vc) die(`AgentID issue ${res.status} — could not mint an agent VC. Check \`fluxa-wallet status\`.`);
  return vc;
}

function loadKey(): string | null {
  return process.env.FLUXA_KEY || null;
}

let _token: string | null = null;
// auth: true → fxa_live_ key if present, else a minted VC.
async function authToken(): Promise<string> {
  if (_token) return _token;
  const k = loadKey();
  if (k) return (_token = k);
  return (_token = await mintVc());
}

let _vc: string | null = null;
// Force an Agent VC, ignoring any fxa_live_ key. Key-management endpoints reject
// a metered key with 403 (a leaked key must not mint uncapped siblings or
// revoke others), so `market keys …` always authenticates with a fresh VC.
async function vcToken(): Promise<string> {
  if (_vc) return _vc;
  return (_vc = await mintVc());
}

// --- http --------------------------------------------------------------------
type Auth = boolean | 'vc';
async function http(url: string | URL, opts: { method?: string; auth?: Auth; body?: any; accept?: string; timeout?: number } = {}): Promise<{ data: any }> {
  const { method = 'GET', auth = false, accept = 'application/json', timeout = 20000 } = opts;
  const headers: Record<string, string> = { accept };
  if (auth === 'vc') headers.authorization = `Bearer ${await vcToken()}`;
  else if (auth) headers.authorization = `Bearer ${await authToken()}`;
  let body: string | undefined;
  if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeout);
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: ctrl.signal });
  } catch (e: any) {
    clearTimeout(to);
    die(`network error reaching ${new URL(url).host}: ${e?.message}`);
  }
  clearTimeout(to);
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const msg = (data && data.error) || (data && data.hint) || (typeof data === 'string' ? data.slice(0, 200) : res.statusText);
    die(`${res.status} ${res.statusText} — ${msg}`);
  }
  return { data };
}

// --- commands: discovery -----------------------------------------------------
async function cmdSearch(query: string, scope: 'all' | 'models' | 'vendors'): Promise<string> {
  if (scope === 'models') return cmdModels(query);
  if (scope === 'vendors') return cmdVendors();
  const u = new URL(`${PLATFORM}/api/discover`);
  u.searchParams.set('type', 'api,skill,model');
  if (query) u.searchParams.set('q', query);
  const { data } = await http(u);
  const rows = [
    ...(data.apiServers || []).map((r: any) => ({ kind: 'api', slug: r.slug, desc: r.description || '', price: r.priceUsd ? (r.priceUsd.min === r.priceUsd.max ? `$${r.priceUsd.min}` : `$${r.priceUsd.min}-${r.priceUsd.max}`) : '' })),
    ...(data.skills || []).map((r: any) => ({ kind: 'skill', slug: r.slug, desc: r.description || '', price: '' })),
    ...(data.models || []).map((r: any) => ({ kind: 'model', slug: `${r.provider}/${r.id}`, desc: r.displayName || '', price: r.inputUnitsPer1M != null ? `${r.inputUnitsPer1M.toLocaleString()}u/Mtok in` : '' })),
  ];
  const lines: string[] = [];
  if (!rows.length) return c.dim('  no matches' + (query ? ` for "${query}"` : ''));
  lines.push(c.dim(`  ${rows.length} result${rows.length === 1 ? '' : 's'} · ${PLATFORM}/api/discover`));
  for (const r of rows) lines.push(`  ${KIND[r.kind]}  ${c.bold(pad(r.slug, 28))} ${c.gray(pad(r.desc, 42))} ${c.dim(r.price)}`);
  return lines.join('\n');
}

async function cmdModels(vendor: string): Promise<string> {
  const u = new URL(`${PLATFORM}/api/llm/models`);
  if (vendor) u.searchParams.set('vendor', vendor);
  const { data } = await http(u);
  const models = data.models || [];
  if (!models.length) return c.dim('  no models');
  const lines: string[] = [];
  for (const m of models) {
    const inU = m.rates_units_per_mtok?.input_tokens, outU = m.rates_units_per_mtok?.output_tokens;
    lines.push(`  ${c.bold(pad(`${m.provider}/${m.id}`, 32))} ${c.gray(pad(m.display_name || '', 26))} ${c.dim(`${inU ?? '?'}/${outU ?? '?'} Units/Mtok in/out`)}`);
  }
  return lines.join('\n');
}

async function cmdVendors(): Promise<string> {
  const { data } = await http(`${PLATFORM}/api/llm/vendors`);
  const vendors = data.vendors || [];
  if (!vendors.length) return c.dim('  no vendors');
  const lines: string[] = [];
  lines.push('  ' + c.dim(pad('slug', 22) + pad('name', 22) + pad('models', 9) + pad('bundles', 9) + 'price (Units/Mtok)'));
  for (const v of vendors) {
    const pr = v.priceRange;
    const price = pr && Number.isFinite(pr.min) ? (pr.min === pr.max ? `${pr.min}` : `${pr.min}-${pr.max}`) : c.dim('—');
    lines.push(`  ${c.bold(pad(v.slug, 22))}${c.gray(pad(v.name || '', 22))}${pad(String(v.modelCount ?? 0), 9)}${pad(String(v.bundleCount ?? 0), 9)}${price}`);
  }
  return lines.join('\n');
}

// --- commands: prepaid Units -------------------------------------------------
/**
 * Units are ONE balance per account, spendable at any provider.
 *
 * This took a vendor and printed a merchant column, from when balances were
 * per vendor. They are not, and the server stopped pretending: it now answers
 * with a flat `balance`, keeping `accounts` as an array only so older CLIs
 * keep rendering. Read the flat field, fall back to the array.
 */
async function cmdRemainingUsage(): Promise<string> {
  const { data } = await http(`${PROXY}/llm/wallet/balances`, { auth: true });
  const a = data.balance ?? (data.accounts || [])[0];
  if (!a) return c.dim('  no Units yet — `fluxa-wallet market model topup` to start');
  const low = a.balance < (a.burn7dPerDay || 0) * 3;
  const status = a.balance < 0 ? c.red('owed ' + usd(-a.balance)) : low ? c.red('low') : c.green('ok');
  return [
    '  ' + c.dim(pad('balance', 18) + pad('≈ USD', 12) + pad('7d/day', 12) + 'status'),
    `  ${pad((a.balance ?? 0).toLocaleString() + ' Units', 18)}${pad(usd(a.balance), 12)}${pad((a.burn7dPerDay ?? 0).toLocaleString(), 12)}${status}`,
  ].join('\n');
}

async function cmdUsageHistory(): Promise<string> {
  // Unscoped: the ledger belongs to the account. The server keeps a
  // /ledger/:vendor route for callers that still scope, and nothing here does.
  const { data } = await http(`${PROXY}/llm/wallet/ledger?limit=20`, { auth: true });
  const entries = data.entries || [];
  if (!entries.length) return c.dim('  no ledger entries yet');
  const lines: string[] = [];
  lines.push('  ' + c.dim(pad('when', 22) + pad('type', 12) + pad('amount', 14) + 'balance after'));
  for (const e of entries) {
    const amt = (e.amount > 0 ? c.green('+') : c.red('')) + e.amount.toLocaleString();
    lines.push(`  ${pad(new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19), 22)}${pad(e.type, 12)}${pad(amt, 14 + (tty ? 9 : 0))}${(e.balanceAfter ?? '').toLocaleString()}`);
  }
  return lines.join('\n');
}

// --- commands: API key management (Agent-VC only) ---------------------------
const capLabel = (mc: number | null | undefined) => (mc == null || mc <= 0 ? c.dim('uncapped') : `${mc} MC`);

async function keysList(): Promise<string> {
  const { data } = await http(`${PROXY}/llm/keys`, { auth: 'vc' });
  const keys = data.keys || [];
  if (!keys.length) return c.dim('  no API keys yet — `fluxa-wallet market keys create` to mint one');
  const lines: string[] = [];
  // ids are full UUIDs (never truncated — you need them for update/revoke)
  lines.push('  ' + c.dim(pad('id', 38) + pad('name', 16) + pad('prefix', 16) + pad('cap', 11) + pad('spent', 11) + 'status'));
  for (const k of keys) {
    const status = k.revokedAt ? c.red('revoked') : c.green('active');
    lines.push(`  ${pad(k.id, 38)}${pad(k.name || '—', 16)}${pad(k.keyPrefix || '', 16)}${pad(capLabel(k.spendCapCredits), 11)}${pad((k.spentCredits ?? 0) + ' MC', 11)}${status}`);
  }
  return lines.join('\n');
}

async function keysCreate(opts: { name?: string; cap?: string }): Promise<string> {
  const body: any = {};
  if (opts.name) body.name = opts.name;
  if (opts.cap != null) body.spendCapCredits = Number(opts.cap);
  const { data } = await http(`${PROXY}/llm/keys`, { method: 'POST', auth: 'vc', body });
  const lines: string[] = [];
  lines.push(c.green('✓') + ` created key ${c.bold(data.name || data.id)} · cap ${capLabel(data.spendCapCredits)}`);
  lines.push(c.dim(`  id: ${data.id}   ${c.dim('(use it to update/revoke)')}`));
  lines.push(`\n  ${c.bold('raw key — shown once, store it now:')}\n  ${c.lime(data.rawKey)}\n`);
  lines.push(c.dim('  use it:  export FLUXA_KEY=' + data.rawKey));
  return lines.join('\n');
}

async function keysUpdate(id: string, opts: { name?: string; cap?: string }): Promise<string> {
  if (!id) die('usage: fluxa-wallet market keys update <id> [--name <n>] [--cap <MC>]');
  const body: any = {};
  if (opts.name != null) body.name = opts.name;
  if (opts.cap != null) body.spendCapCredits = Number(opts.cap); // --cap 0 clears the cap
  if (!Object.keys(body).length) die('nothing to update — pass --name and/or --cap');
  const { data } = await http(`${PROXY}/llm/keys/${id}`, { method: 'PATCH', auth: 'vc', body });
  return c.green('✓') + ` updated ${c.bold(data.name || data.id)} · cap ${capLabel(data.spendCapCredits)}`;
}

async function keysRevoke(id: string): Promise<string> {
  if (!id) die('usage: fluxa-wallet market keys revoke <id>');
  await http(`${PROXY}/llm/keys/${id}`, { method: 'DELETE', auth: 'vc' });
  return c.green('✓') + ` revoked ${id} — it stops authenticating on its next call`;
}

// --- plan-tool-use (thin call to server-side endpoint) -----------------------
async function cmdPlanToolUse(task: string): Promise<string> {
  if (!task) die('usage: fluxa-wallet plan-tool-use "<task>"');
  let r: Response;
  try {
    r = await fetch(`${PROXY}/api/planner/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task }),
    });
  } catch (e: any) {
    die(`network error reaching ${new URL(PROXY).host}: ${e?.message}`);
  }
  if (!r.ok) die(`plan failed: HTTP ${r.status}`);
  const result: any = await r.json().catch(() => null);
  if (!result) die('plan failed: bad response');
  if (result.kind === 'answer') return renderAnswer(result);
  return renderPlan(result);
}

function renderAnswer(a: any): string {
  const lines: string[] = [];
  lines.push('\n  ' + c.bold(unesc(a.answer)));
  if (a.command) {
    lines.push('\n  ' + c.dim('run:'));
    lines.push('    ' + c.cyan(unesc(a.command)));
  }
  if (a.prompt) {
    lines.push('\n  ' + c.dim('copy this prompt for your agent:'));
    for (const line of unesc(a.prompt).split('\n')) lines.push('    ' + line);
  }
  return lines.join('\n');
}

function renderPlan(plan: any): string {
  const { lines } = planLines(plan, {
    bold: c.bold as any, dim: c.dim as any, lime: c.lime as any, gray: c.gray as any,
    kind: (k: string) => KIND[k] || pad(k, 5),
    pad, usd, unesc,
  });
  return lines.join('\n');
}

// --- info (self-contained explainer; no network, no auth) -------------------
const INFO: Record<string, () => string> = {
  overview: () => `
${c.bold('market')} ${c.dim('— what you\'re working with')}

  FluxA is an agent-native task layer. ${c.bold('plan-tool-use')} recommends the right tools for a
  task; your agent runs them and FluxA settles each paid call from your wallet.

  ${c.bold('Three kinds of tool')} (all metered in Units):
    ${KIND.api}  Oneshot APIs  — pay-per-call endpoints (scrape, search, video, …)
    ${KIND.model}  Models        — LLM endpoints, billed per token, via /llm/{merchant}
    ${KIND.skill}  Skills        — packaged multi-step routines

  ${c.bold('Money')}
    1 Unit = $0.00001 · 100,000 Units = $1 = 1 Monetize Credit (MC)
    Balances are ${c.bold('per merchant')} (prepaid Units). ${c.cyan('fluxa-wallet market model topup <merchant>')} to prefund.

  ${c.bold('Auth')}  an ${c.dim('fxa_live_')} key OR an auto-minted agent VC from your wallet identity.
  ${c.bold('Bases')} platform ${c.dim(new URL(PLATFORM).host)} · proxy ${c.dim(new URL(PROXY).host)}

  ${c.bold('Commands')}
    ${c.cyan('plan-tool-use "<task>"')}     recommend tools for a task
    ${c.cyan('market model topup <merchant>')}   prepay Units
    ${c.cyan('market search "<q>"')}        discover apis/models/skills
    ${c.dim('market search --models · --vendors · market model remainingUsage · usageHistory · market keys')}

  More:  ${c.cyan('fluxa-wallet market info')} ${c.dim('<units|auth|pay|keys|models|skills>')}
`,
  units: () => `
${c.bold('Units & credits')}
  1 Unit = $0.00001 (USD).  100,000 Units = $1 = 1 Monetize Credit (MC).
  · Per-call API/skill prices are quoted in USD; model rates in Units per 1M tokens.
  · Your prepaid balance is in Units, held ${c.bold('per merchant')}.
  · Topups are charged in Monetize Credits (min 5 MC = $5); 1 MC grants 100,000 Units.
`,
  auth: () => `
${c.bold('Auth')}
  Two accepted Bearer credentials:
    ${c.dim('fxa_live_<key>')}   create with ${c.cyan('fluxa-wallet market keys create')} · export FLUXA_KEY=…
    ${c.dim('agent VC')}         short-lived JWT, auto-minted from your wallet identity
  The market commands auto-mint an agent VC when no key is set — nothing to log in.
  Discovery (${c.cyan('market search')}) is public; everything else is authed.
  Manage keys programmatically with ${c.cyan('market keys')} ${c.dim('(VC only — see `market info keys`)')}.
`,
  keys: () => `
${c.bold('API keys — programmatic management')} ${c.dim('(Agent VC only)')}
  Provision and rotate your ${c.dim('fxa_live_')} keys so an agent can hand a fresh, capped key
  to a sub-process without you minting one by hand. ${c.bold('Requires an Agent VC')} — a metered
  fxa_live_ key is refused (it must not mint uncapped siblings or revoke others).
    ${c.cyan('fluxa-wallet market keys')}                                list your keys (prefixes only)
    ${c.cyan('fluxa-wallet market keys create --name <n> --cap <MC>')}   mint one; raw key shown ONCE
    ${c.cyan('fluxa-wallet market keys update <id> --cap <MC>')}         change name / spend cap (${c.dim('--cap 0')} clears)
    ${c.cyan('fluxa-wallet market keys revoke <id>')}                    revoke (immediate, irreversible)
  Spend caps (in MC) gate metered LLM usage on that key only. To rotate: create
  the new key, hand it off, ${c.bold('then')} revoke the old — never leave zero working keys.
`,
  pay: () => `
${c.bold('Paying — x402 v3')}
  Prepaid: each merchant has a Units balance; while it's funded, calls just work.
  On a shortfall a paid endpoint returns HTTP 402 with an x402 challenge. Settle it with
  the wallet:
    1. sign a spending ${c.bold('mandate')} once (you pre-approve a budget + time window)
       ${c.dim('fluxa-wallet mandate-create --amount <units> --seconds <ttl> --currency <…>')}
    2. settle the 402 challenge  ${c.dim('fluxa-wallet x402-v3 --mandate <id> --payload <402 body>')}
    3. retry the call with the returned payment token in the ${c.dim('X-Payment')} header
  Reuse the signed mandate for later calls in its window. ${c.cyan('market model topup')} prefunds instead.
`,
  models: () => `
${c.bold('Models — merchant-centric')}
  A ${c.bold('merchant')} (provider) exposes many models; billing + balance are per merchant.
  An offering is ${c.dim('(merchant, model)')}; the lane is ${c.dim('POST /llm/{merchant}/v1/chat/completions')}
  (OpenAI wire format), billed per token.
    ${c.cyan('fluxa-wallet market search --models')}          list models + Units rates
    ${c.cyan('fluxa-wallet market model topup <merchant>')}   fund that merchant's balance
`,
  skills: () => `
${c.bold('Skills')}
  Packaged multi-step routines that wrap several tools into one capability.
    ${c.cyan('fluxa-wallet market search "<q>"')}   discover skills (and apis/models)
  Install via the skills tool: ${c.dim('npx -y skills add <platform> -s <slug>')}.
`,
};

function cmdInfo(topic?: string): string {
  const key = (topic || 'overview').toLowerCase();
  const render = INFO[key];
  if (!render) {
    die(`unknown topic: ${topic}\n  topics: ${Object.keys(INFO).filter((k) => k !== 'overview').join(', ')}`);
  }
  return render();
}

// --- topup proxy legs --------------------------------------------------------
// The two marketplace-proxy calls of the topup flow. The money-moving middle
// (mandate signing + x402-v3) is orchestrated by the wallet CLI in-process
// using its own proven primitives; these helpers only talk to the proxy.
export interface TopupChallenge {
  orderId: string;
  resource: string;
  costCredits: number;
  creditsToGrant: number;
  rawBody: string;
}

// POST /llm/topup/initiate (authed). On success it answers HTTP 402 with the
// x402 challenge — so unlike http(), we tolerate 402 instead of throwing.
export async function topupInitiate(opts: { credits?: string; bundle?: string } = {}): Promise<TopupChallenge> {
  // No vendorSlug. Units are one balance per account; the server resolves which
  // provider the purchase is booked against, which is bookkeeping the caller
  // has no way to choose sensibly.
  const body: any = {};
  if (opts.bundle) body.packageSlug = opts.bundle;
  else body.costCredits = opts.credits ? Number(opts.credits) : 5; // min 5 MC ($5)
  let res: Response;
  try {
    res = await fetch(`${PROXY}/llm/topup/initiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${await authToken()}` },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    die(`network error reaching ${new URL(PROXY).host}: ${e?.message}`);
  }
  const text = await res.text();
  if (res.status !== 402) die(`topup initiate ${res.status} — ${text.slice(0, 200)}`);
  let ch: any; try { ch = JSON.parse(text); } catch { die('topup initiate did not return JSON'); }
  if (!ch.resource || !ch.orderId) die('topup initiate missing orderId/resource');
  return { orderId: ch.orderId, resource: ch.resource, costCredits: ch.costCredits, creditsToGrant: ch.creditsToGrant, rawBody: text };
}

// POST the finalize resource URL with the signed X-Payment token (no bearer).
export async function topupFinalize(resourceUrl: string, xPayment: string): Promise<{ creditsAdded?: number; balance?: number }> {
  let res: Response;
  try {
    res = await fetch(resourceUrl, { method: 'POST', headers: { accept: 'application/json', 'X-Payment': xPayment } });
  } catch (e: any) {
    die(`network error reaching ${new URL(resourceUrl).host}: ${e?.message}`);
  }
  const text = await res.text();
  if (res.status >= 400) die(`finalize ${res.status} — ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

// --- dispatch ----------------------------------------------------------------
// Single entry point called from cli.ts. `command` is the resolved multi-word
// command string; `positionals` are the non-flag tokens after it.

// --- commands: token plans ---------------------------------------------------
//
// A Token Plan is the other way to reach a model: one flat monthly allowance on
// the PROVIDER's endpoint, rather than per-call Units on ours. The key these
// commands surface is the provider's, so it does not authenticate at
// /llm/{merchant} and an fxa_live_ key does not authenticate at the provider.
//
// Buying is deliberately absent. That flow is published, tested and kept
// current at /marketplace/tokenplans/topup.md; a second copy here would drift
// from it the first time either changed.

const planStatus = (s: string): string =>
  s === 'active' ? c.green('active')
  : s === 'awaiting_provisioning' ? c.red('setting up')
  : c.dim(s);

async function cmdTokenplanList(): Promise<string> {
  const { data } = await http(`${PROXY}/llm/tokenplan/subscription`, { auth: true });
  const subs: any[] = data.subscriptions || [];
  if (!subs.length) {
    return c.dim('  no token plans — see ') +
      `${PLATFORM}/marketplace/tokenplans/topup.md`;
  }
  const lines: string[] = [];
  lines.push('  ' + c.dim(pad('plan', 26) + pad('left', 22) + pad('days', 7) + 'id'));
  for (const s of subs) {
    // Null, not zero, when there is no seat to ask: zero would read as an
    // exhausted plan rather than one whose figures we cannot see.
    const left = s.creditsRemaining == null
      ? c.dim('—')
      : `${Number(s.creditsRemaining).toLocaleString()} / ${Number(s.creditsTotal ?? 0).toLocaleString()}`;
    const days = s.daysRemaining == null ? c.dim('—') : String(s.daysRemaining);
    lines.push(`  ${pad(s.planSlug, 26)}${pad(left, 22)}${pad(days, 7)}${c.dim(s.id)}`);
    if (s.lastError) lines.push('    ' + c.red(s.lastError));
  }
  lines.push('');
  lines.push('  ' + c.dim('status: ') + subs.map((s: any) => planStatus(s.status)).join(c.dim(', ')));
  return lines.join('\n');
}

async function cmdTokenplanKey(id: string): Promise<string> {
  if (!id) die('usage: fluxa-wallet market tokenplan key <subscriptionId>');
  const { data } = await http(`${PROXY}/llm/tokenplan/subscription/${encodeURIComponent(id)}/key`, { auth: true });
  return [
    '  ' + c.dim('api key   ') + data.apiKey,
    '  ' + c.dim('base url  ') + data.baseUrl,
    '',
    '  ' + c.dim('This is the provider\'s key, for the provider\'s endpoint above.'),
    '  ' + c.dim('It is not stored by FluxA; it is read from them each time you ask.'),
  ].join('\n');
}

async function cmdTokenplanUsage(id: string): Promise<string> {
  if (!id) die('usage: fluxa-wallet market tokenplan usage <subscriptionId>');
  const { data } = await http(`${PROXY}/llm/tokenplan/subscription/${encodeURIComponent(id)}/usage`, { auth: true });
  const records: any[] = data.records || [];
  if (!records.length) return c.dim('  nothing spent on this plan yet');
  const lines = ['  ' + c.dim(pad('when', 22) + pad('model', 26) + pad('credits', 10) + 'tokens in/out')];
  for (const r of records) {
    const when = new Date(r.time).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`  ${pad(when, 22)}${pad(r.model, 26)}${pad(r.credits, 10)}${r.inputTokens}/${r.outputTokens}`);
  }
  return lines.join('\n');
}

async function cmdTokenplanModels(): Promise<string> {
  const { data } = await http(`${PROXY}/llm/tokenplan/models`, { auth: true });
  const models: string[] = data.models || [];
  if (!models.length) return c.dim('  none reported');
  return models.map((m) => '  ' + m).join('\n');
}

/**
 * Spending a code.
 *
 * --yes is required because a code is one-shot and cannot be un-spent, and
 * redeeming onto the wrong account is unrecoverable. It costs no money, so
 * nothing else in this CLI would have stopped an agent from trying one.
 */
async function cmdTokenplanRedeem(kind: 'redeem' | 'claim', code: string, confirmed: boolean): Promise<string> {
  if (!code) die(`usage: fluxa-wallet market tokenplan ${kind} <code> --yes`);
  if (!confirmed) {
    die(`a code can only be spent once and cannot be undone. Confirm with the user, then re-run with --yes`);
  }
  const path = kind === 'redeem' ? '/llm/tokenplan/redeem' : '/llm/tokenplan/shared/claim';
  const { data } = await http(`${PROXY}${path}`, { auth: true, method: 'POST', body: { code } });
  const lines = ['  ' + c.green('redeemed') + '  ' + c.dim(data.subscriptionId || '')];
  if (data.alreadyClaimed) lines.push('  ' + c.dim('you already held this one; nothing was spent'));
  // A plan can exist and still be mid-setup. Saying so beats a bare success.
  if (data.status && data.status !== 'active') lines.push('  ' + c.dim(`status: ${data.status}`));
  if (data.error) lines.push('  ' + c.red(data.error));
  lines.push('  ' + c.dim('`fluxa-wallet market tokenplan key <id>` for the key'));
  return lines.join('\n');
}


/**
 * Buying a plan with USDC, through a FluxA Wallet payment link.
 *
 * Creating the link costs nothing: the money moves when a human opens the URL
 * and approves it, which IS the confirmation step. So this needs no --yes, and
 * an agent cannot spend by running it.
 *
 * The plan is charged in USDC, not Monetize Credits -- a different currency
 * from `market model topup`, which funds Units.
 */
async function cmdTokenplanBuy(planSlug: string): Promise<string> {
  if (!planSlug) die('usage: fluxa-wallet market tokenplan buy <plan>   (lite | standard | advanced)');
  const { data } = await http(`${PROXY}/llm/topup/paylink`, {
    auth: true,
    method: 'POST',
    body: { planSlug },
  });
  // `amount` is newer than this command. A proxy that predates it answers
  // without one, and printing "$undefined USDC" at somebody about to spend
  // money is worse than not naming the price at all.
  const price = Number.isFinite(Number(data.amount))
    ? `${c.bold('$' + data.amount)} ${data.currency ?? 'USDC'}`
    : c.dim(`price shown on the checkout page`);
  return [
    `  ${c.bold(data.planSlug)}  ${price}`,
    '',
    '  Open to pay:',
    '    ' + data.checkoutUrl,
    '',
    c.dim('  Nothing has been charged yet. Paying the link is what spends.'),
    c.dim(`  Then: fluxa-wallet market tokenplan order ${data.orderId}`),
  ].join('\n');
}

/** Where an order got to, and whether its seat is ready. */
async function cmdTokenplanOrder(orderId: string): Promise<string> {
  if (!orderId) die('usage: fluxa-wallet market tokenplan order <orderId>');
  const { data } = await http(`${PROXY}/llm/topup/order/${encodeURIComponent(orderId)}`, { auth: true });
  const lines = [`  payment  ${data.status === 'settled' ? c.green('settled') : c.dim(data.status)}`];
  if (data.plan) {
    // Two states, not one: the money can be settled while the seat is still
    // being made, or has failed to be made.
    lines.push(`  plan     ${data.plan.planSlug ?? '—'}`);
    lines.push(
      data.plan.ready
        ? `  seat     ${c.green('ready')}  ${c.dim('— `market tokenplan list` for the key')}`
        : `  seat     ${c.dim(`${data.plan.seatStatus ?? 'pending'}, step ${data.plan.provisioningStep}/4`)}`,
    );
  } else if (data.status === 'settled') {
    lines.push(`  units    +${Number(data.creditsToGrant).toLocaleString()}  balance ${Number(data.balance).toLocaleString()}`);
  }
  return lines.join('\n');
}

export async function runMarketCommand(
  command: string,
  positionals: string[],
  options: Record<string, string>,
): Promise<MarketResult> {
  try {
    let raw: string;
    switch (command) {
      case 'plan-tool-use':
        raw = await cmdPlanToolUse(positionals.join(' ').trim());
        break;
      case 'market search': {
        const scope = options.vendors ? 'vendors' : options.models ? 'models' : 'all';
        raw = await cmdSearch(positionals.join(' ').trim(), scope);
        break;
      }
      case 'market model remainingUsage':
        raw = await cmdRemainingUsage();
        break;
      case 'market model usageHistory':
        raw = await cmdUsageHistory();
        break;
      // 'market model topup' is orchestrated in cli.ts (it needs the wallet's
      // in-process mandate + x402-v3 primitives); it never reaches here.
      case 'market keys':
      case 'market keys list':
        raw = await keysList();
        break;
      case 'market keys create':
        raw = await keysCreate({ name: options.name, cap: options.cap });
        break;
      case 'market keys update':
        raw = await keysUpdate(positionals[0], { name: options.name, cap: options.cap });
        break;
      case 'market keys revoke':
        raw = await keysRevoke(positionals[0]);
        break;
      case 'market tokenplan':
      case 'market tokenplan list':
        raw = await cmdTokenplanList();
        break;
      case 'market tokenplan key':
        raw = await cmdTokenplanKey(positionals[0]);
        break;
      case 'market tokenplan usage':
        raw = await cmdTokenplanUsage(positionals[0]);
        break;
      case 'market tokenplan models':
        raw = await cmdTokenplanModels();
        break;
      case 'market tokenplan buy':
        raw = await cmdTokenplanBuy(positionals[0]);
        break;
      case 'market tokenplan order':
        raw = await cmdTokenplanOrder(positionals[0]);
        break;
      case 'market tokenplan redeem':
        raw = await cmdTokenplanRedeem('redeem', positionals[0], options.yes !== undefined);
        break;
      case 'market tokenplan claim':
        raw = await cmdTokenplanRedeem('claim', positionals[0], options.yes !== undefined);
        break;
      case 'market info':
        raw = cmdInfo(positionals[0]);
        break;
      default:
        return { success: false, error: `unknown market command: ${command}` };
    }
    return { success: true, raw };
  } catch (e: any) {
    if (e instanceof MarketError) return { success: false, error: e.message };
    return { success: false, error: `market error: ${e?.message || String(e)}` };
  }
}
