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
//   MARKET_PLATFORM  default https://monetize.fluxapay.xyz      (discovery, models)
//   MARKET_PROXY     default https://proxy-monetize.fluxapay.xyz (balances, keys, plan)
//   AGENT_ID_API     default https://agentid.fluxapay.xyz       (VC issue)
// ---------------------------------------------------------------------------

import { refreshJWT, isJWTExpired } from '../wallet/client.js';
import { getEffectiveAgentId, updateJWT } from '../agent/agentId.js';
import { planLines } from './plan-format.js';

const PLATFORM = (process.env.MARKET_PLATFORM || process.env.FLUXA_PLATFORM || 'https://monetize.fluxapay.xyz').replace(/\/$/, '');
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
async function cmdRemainingUsage(vendor?: string): Promise<string> {
  const url = vendor ? `${PROXY}/llm/wallet/balances/${vendor}` : `${PROXY}/llm/wallet/balances`;
  const { data } = await http(url, { auth: true });
  const accounts = vendor ? [data] : (data.accounts || []);
  if (!accounts.length) return c.dim('  no merchant balances yet — `fluxa-wallet market model topup <vendor>` to start');
  const lines: string[] = [];
  lines.push('  ' + c.dim(pad('merchant', 16) + pad('balance', 18) + pad('≈ USD', 12) + pad('7d/day', 12) + 'status'));
  for (const a of accounts) {
    const low = a.balance < (a.burn7dPerDay || 0) * 3;
    const status = a.balance < 0 ? c.red('owed ' + usd(-a.balance)) : low ? c.red('low') : c.green('ok');
    lines.push(`  ${pad(a.merchant, 16)}${pad((a.balance ?? 0).toLocaleString() + ' Units', 18)}${pad(usd(a.balance), 12)}${pad((a.burn7dPerDay ?? 0).toLocaleString(), 12)}${status}`);
  }
  return lines.join('\n');
}

async function cmdUsageHistory(vendor?: string): Promise<string> {
  if (!vendor) die('usage: fluxa-wallet market model usageHistory <vendor>');
  const { data } = await http(`${PROXY}/llm/wallet/ledger/${vendor}?limit=20`, { auth: true });
  const entries = data.entries || [];
  if (!entries.length) return c.dim('  no ledger entries for ' + vendor);
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

// --- dispatch ----------------------------------------------------------------
// Single entry point called from cli.ts. `command` is the resolved multi-word
// command string; `positionals` are the non-flag tokens after it.
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
        raw = await cmdRemainingUsage(positionals[0]);
        break;
      case 'market model usageHistory':
        raw = await cmdUsageHistory(positionals[0]);
        break;
      case 'market model topup':
        die('`market model topup` is not wired yet — coming in a follow-up. Use `fluxa-wallet mandate-create` + `x402-v3` for now (see `market info pay`).');
      // eslint-disable-next-line no-fallthrough
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
