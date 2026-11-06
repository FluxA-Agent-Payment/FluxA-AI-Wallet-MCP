import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DATA_ROOT } from '../store/store.js';
import { getEffectiveAgentId, getAgentIdFromEnv, saveAgentId, updateJWT } from './agentId.js';
import { CredentialError } from './credentialError.js';
import { buildLinkWalletUrl, checkWalletLinked, isJWTExpired, refreshJWT } from '../wallet/client.js';

export const CONNECT_TTL_SECONDS = 10800;
const api = () => (process.env.AGENT_ID_API || 'https://agentid.fluxapay.xyz').replace(/\/$/, '');
const pendingPath = path.join(DATA_ROOT, 'pending-connect.json');
type Pending = { request_id: string; poll_secret: string; authorization_url: string; expires_in: number;
  poll_interval: number; started_at: number; agent_api: string; requested_agent_id?: string; requested_validity?: string; client_name: string };
export class ConnectionError extends Error {
  constructor(public code: string, message = code, public retryable = false) { super(message); }
}
export const CONNECT_VALIDITIES = ['1h', '24h', '7d', '1mo', '180d', '1y'] as const;
type Options = { agent_id?: string; client_name?: string; runtime?: string; hosting?: string; validity?: string; reconnect?: boolean };

function savePending(pending: Pending) {
  const temp = `${pendingPath}.${crypto.randomUUID()}`;
  try { fs.writeFileSync(temp, JSON.stringify(pending), { mode: 0o600 }); fs.renameSync(temp, pendingPath); }
  finally { fs.rmSync(temp, { force: true }); }
}
function readPending(): Pending | null {
  if (!fs.existsSync(pendingPath)) return null;
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as Pending;
  if (pending.agent_api !== api()) throw new ConnectionError('connection_environment_mismatch', 'Pending connection belongs to another AgentDID environment. Use its original AGENT_ID_API and data directory.');
  return pending;
}
function publicPending(pending: Pending) {
  return { connected: false, authorization_required: true, request_id: pending.request_id,
    authorization_url: pending.authorization_url, expires_in: Math.max(0, Math.ceil((pending.started_at + pending.expires_in * 1000 - Date.now()) / 1000)),
    poll_interval: pending.poll_interval, next_command: 'fluxa-wallet connect-status --wait 100' };
}
export function executionEnvironment(runtime?: string, hosting?: string) {
  const platform: Record<string, string> = { darwin: 'macos', win32: 'windows', linux: 'linux', android: 'android' };
  const detectedRuntime = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv') ? 'container' : 'unknown';
  const detectedHosting = process.env.RAILWAY_ENVIRONMENT_ID || process.env.CODESPACES || process.env.CODEX_CLOUD ? 'cloud' : 'unknown';
  const selectedRuntime = runtime || process.env.FLUXA_RUNTIME || detectedRuntime;
  const selectedHosting = hosting || process.env.FLUXA_HOSTING || detectedHosting;
  if (!['local', 'vm', 'container', 'unknown'].includes(selectedRuntime)) throw new ConnectionError('invalid_runtime');
  if (!['local', 'cloud', 'unknown'].includes(selectedHosting)) throw new ConnectionError('invalid_hosting');
  return { os: platform[os.platform()] || 'unknown', runtime: selectedRuntime, hosting: selectedHosting };
}

async function request(endpoint: string, body: unknown) {
  let response: Response;
  try { response = await fetch(`${api()}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }); }
  catch { throw new ConnectionError('connection_service_unavailable', 'Connection service is temporarily unavailable. Retry the same pending request.', true); }
  const data = await response.json().catch(() => ({})) as any;
  if (response.status === 202 || (response.status === 429 && data.error === 'slow_down')) return null;
  if (!response.ok) {
    if (['token_expired', 'token_revoked', 'invalid_token'].includes(data.error)) throw new CredentialError(data.error, data.agent_id);
    const known = ['connection_expired', 'connection_claimed', 'access_denied', 'invalid_poll_secret', 'invalid_request', 'invalid_validity', 'token_expired', 'token_revoked'];
    const code = known.includes(data.error) ? data.error : response.status >= 500 ? 'connection_service_unavailable' : 'connection_failed';
    throw new ConnectionError(code, code, response.status >= 500 || response.status === 429);
  }
  return data;
}

export async function beginConnection(options: Options = {}) {
  if (options.validity !== undefined && !CONNECT_VALIDITIES.includes(options.validity as typeof CONNECT_VALIDITIES[number])) {
    throw new ConnectionError('invalid_validity', 'Valid values: 1h, 24h, 7d, 1mo, 180d, 1y');
  }
  const config = getEffectiveAgentId();
  const explicitEnvironment = ['AGENT_ID', 'AGENT_TOKEN', 'AGENT_JWT'].some(key => Boolean(process.env[key]));
  if (explicitEnvironment && !getAgentIdFromEnv()) throw new CredentialError('env_credentials_invalid', process.env.AGENT_ID, true);
  if (options.agent_id && (options.agent_id.length > 128 || !options.agent_id.trim())) throw new ConnectionError('invalid_agent_id');
  const target = options.agent_id || config?.agent_id;
  if (config && !options.reconnect && (!options.agent_id || options.agent_id === config.agent_id)) {
    let jwt = config.jwt;
    try {
      if (isJWTExpired(jwt)) { jwt = await refreshJWT(config.agent_id, config.token); updateJWT(jwt); }
      const { linked } = await checkWalletLinked(jwt);
      if (linked) return { connected: true, agent_id: config.agent_id };
      return { connected: false, authorization_required: true, agent_id: config.agent_id,
        authorization_url: buildLinkWalletUrl(config.agent_id, config.agent_name || ''),
        next_command: 'fluxa-wallet connect-status --wait 100' };
    } catch (error) {
      if (!(error instanceof CredentialError)) throw error;
      if (explicitEnvironment) throw new CredentialError(error.code, target, true);
    }
  }
  if (explicitEnvironment) throw new CredentialError('env_credentials_conflict', target, true);
  const existing = readPending();
  if (existing) {
    if (existing.requested_agent_id !== target) throw new ConnectionError('pending_connection_conflict', 'A different identity connection is pending. Complete it using connect-status, or wait for it to expire.');
    if (Date.now() < existing.started_at + existing.expires_in * 1000) {
      if (options.validity !== undefined && existing.requested_validity !== options.validity) throw new ConnectionError('pending_connection_conflict', 'A connection with another validity preference is pending. Complete it using connect-status, or wait for it to expire.');
      return publicPending(existing);
    }
    // The owner may have approved near the original request deadline.
    try { return await connectionStatus(); }
    catch (error) { if (!(error instanceof ConnectionError) || !['connection_expired', 'connection_claimed', 'access_denied'].includes(error.code)) throw error; }
  }
  const lock = `${pendingPath}.lock`;
  if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs > 30000) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; }
      catch (error: any) { if (error?.code !== 'ESRCH') alive = true; }
    }
    if (!alive) fs.rmSync(lock, { force: true });
  }
  let fd: number;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new ConnectionError('connection_in_progress', 'Another process is starting a connection. Retry connect-status shortly.', true); }
  try {
    fs.writeFileSync(fd, String(process.pid));
    const raced = readPending();
    if (raced) {
      if (raced.requested_agent_id !== target) throw new ConnectionError('pending_connection_conflict');
      if (options.validity !== undefined && raced.requested_validity !== options.validity) throw new ConnectionError('pending_connection_conflict');
      return publicPending(raced);
    }
    const clientName = options.client_name || process.env.CLIENT_INFO || 'FluxA CLI';
    const result = await request('/connect/requests', { client_name: clientName, environment: executionEnvironment(options.runtime, options.hosting),
      ...(target ? { agent_id: target } : {}), ...(options.validity !== undefined ? { validity: options.validity } : {}) });
    if (!result?.request_id || !result.poll_secret || !result.authorization_url) throw new ConnectionError('invalid_connection_response');
    const url = new URL(result.authorization_url);
    const expected = new URL(process.env.AGENT_WALLET_APP || 'https://agentwallet.fluxapay.xyz');
    if (url.origin !== expected.origin || url.pathname !== '/connect-agent') throw new ConnectionError('connection_url_mismatch', 'AgentDID returned a wallet link for another environment. Check AGENT_WALLET_APP.');
    const pending: Pending = { ...result, expires_in: result.expires_in || CONNECT_TTL_SECONDS,
      poll_interval: result.poll_interval || 5, started_at: Date.now(), agent_api: api(), requested_agent_id: target,
      requested_validity: options.validity, client_name: clientName };
    savePending(pending);
    return publicPending(pending);
  } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}

export async function connectionStatus(waitSeconds = 0) {
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > CONNECT_TTL_SECONDS) throw new ConnectionError('invalid_wait', '--wait must be 0..10800 seconds');
  const deadline = Date.now() + waitSeconds * 1000;
  while (true) {
    const pending = readPending();
    if (!pending) {
      const config = getEffectiveAgentId();
      if (!config) throw new ConnectionError('no_pending_connection', 'Run fluxa-wallet connect first.');
      let jwt = config.jwt;
      if (isJWTExpired(jwt)) { jwt = await refreshJWT(config.agent_id, config.token); updateJWT(jwt); }
      if ((await checkWalletLinked(jwt)).linked) return { connected: true, agent_id: config.agent_id };
      if (Date.now() >= deadline) return { connected: false, authorization_required: true, agent_id: config.agent_id,
        authorization_url: buildLinkWalletUrl(config.agent_id, config.agent_name || ''), next_command: 'fluxa-wallet connect-status --wait 100' };
      await new Promise(resolve => setTimeout(resolve, Math.min(5000, deadline - Date.now())));
      continue;
    }
    let result;
    try { result = await request('/connect/token', { request_id: pending.request_id, poll_secret: pending.poll_secret }); }
    catch (error) {
      if (error instanceof CredentialError) {
        error.agentId ||= pending.requested_agent_id;
        fs.rmSync(pendingPath, { force: true });
        throw error;
      }
      if (error instanceof ConnectionError && ['connection_expired', 'connection_claimed', 'access_denied'].includes(error.code)) fs.rmSync(pendingPath, { force: true });
      if (!(error instanceof ConnectionError) || !error.retryable || Date.now() >= deadline) throw error;
    }
    if (result) {
      if (typeof result.agent_id !== 'string' || typeof result.token !== 'string' || typeof result.jwt !== 'string') throw new ConnectionError('invalid_connection_response');
      if (pending.requested_agent_id && result.agent_id !== pending.requested_agent_id) throw new ConnectionError('requested_agent_mismatch');
      // Explicit environment credentials would still win over the saved file.
      if (getAgentIdFromEnv()) throw new CredentialError('env_credentials_conflict', result.agent_id, true);
      saveAgentId({ agent_id: result.agent_id, token: result.token, jwt: result.jwt });
      fs.rmSync(pendingPath, { force: true });
      return { connected: true, agent_id: result.agent_id };
    }
    if (Date.now() >= deadline) return publicPending(pending);
    await new Promise(resolve => setTimeout(resolve, Math.min(Math.max(5, pending.poll_interval) * 1000, deadline - Date.now())));
  }
}
