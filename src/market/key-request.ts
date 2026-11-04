// ---------------------------------------------------------------------------
// Browser-approved API key creation (`fluxa-wallet market keys create`).
//
// The CLI never prints an API key. It:
//   1. makes a one-time RSA key pair and picks the file the key will go to,
//   2. POSTs /llm/keys with the public key -> an approval link + short code,
//   3. opens the browser; the user signs in, checks the code, approves,
//   4. polls /llm/keys/requests/<id>; the key arrives once, encrypted to the
//      public key, and is decrypted straight into a 0600 file.
// Only the file path reaches stdout, so the key stays out of the agent's
// context, logs and shell history. The pending request (with its private
// key) is kept in <data dir>/key-requests/<id>.json, 0600, so a wait that
// times out can be resumed with `--request <id>`; it is deleted once the key
// is saved, denied or expired.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from '../store/store.js';

export const KEYS_DIR = path.join(DATA_DIR, 'keys');
const REQUESTS_DIR = path.join(DATA_DIR, 'key-requests');

export interface PendingKeyRequest {
  requestId: string;
  code: string;
  approvalUrl: string;
  expiresAt: string;
  savePath: string; // absolute
  privateKey: string; // PKCS#8 PEM
}

export function newKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function decryptKey(privateKeyPem: string, encryptedB64: string): string {
  return crypto
    .privateDecrypt(
      { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(encryptedB64, 'base64'),
    )
    .toString('utf8');
}

/** `~/…` for a path under the home folder, for display. */
export function displayPath(p: string): string {
  const home = os.homedir();
  return home && (p === home || p.startsWith(home + path.sep)) ? '~' + p.slice(home.length) : p;
}

/** A file name from the key name: letters, digits, `.`, `_`, `-` only. */
function fileStem(name: string | undefined): string {
  const s = (name || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48);
  return s || 'fluxa-key';
}

/** <keys dir>/<name>.key, or <name>-2.key, -3 … when taken. */
export function pickSavePath(name: string | undefined, dir: string = KEYS_DIR): string {
  const stem = fileStem(name);
  for (let i = 1; ; i++) {
    const p = path.join(dir, i === 1 ? `${stem}.key` : `${stem}-${i}.key`);
    if (!fs.existsSync(p) && !pendingUses(p)) return p;
  }
}

function pendingUses(p: string): boolean {
  try {
    return fs.readdirSync(REQUESTS_DIR).some((f) => {
      try {
        return (JSON.parse(fs.readFileSync(path.join(REQUESTS_DIR, f), 'utf8')) as PendingKeyRequest).savePath === p;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function ensurePrivateDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
}

function requestFile(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('invalid request id');
  return path.join(REQUESTS_DIR, `${id}.json`);
}

export function savePending(req: PendingKeyRequest) {
  ensurePrivateDir(REQUESTS_DIR);
  fs.writeFileSync(requestFile(req.requestId), JSON.stringify(req), { mode: 0o600 });
}

export function loadPending(id: string): PendingKeyRequest | null {
  try {
    return JSON.parse(fs.readFileSync(requestFile(id), 'utf8'));
  } catch {
    return null;
  }
}

export function dropPending(id: string) {
  try { fs.unlinkSync(requestFile(id)); } catch { /* already gone */ }
}

/** Writes the key to its file, owner read/write only. Never overwrites. */
export function writeKeyFile(p: string, rawKey: string) {
  ensurePrivateDir(path.dirname(p));
  fs.writeFileSync(p, rawKey + '\n', { mode: 0o600, flag: 'wx' });
}

/** Best effort: open the link in the default browser. Never throws. */
export function openBrowser(url: string): boolean {
  if (process.env.FLUXA_NO_BROWSER) return false;
  if (!/^https?:\/\//.test(url)) return false;
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
