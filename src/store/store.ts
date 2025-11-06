import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { webcrypto as crypto } from 'node:crypto';

const DATA_ROOT = process.env.FLUXA_DATA_DIR
  ? path.resolve(process.env.FLUXA_DATA_DIR)
  : path.join(os.homedir(), '.fluxa-ai-wallet-mcp');
const DATA_DIR = DATA_ROOT;
const SECURE_FILE = path.join(DATA_DIR, 'wallet.enc');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
const APPROVALS_FILE = path.join(DATA_DIR, 'approvals.json');

export function ensureDataDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

type Policy = {
  networksAllow: string[]; // ['base', 'base-sepolia']
  assetsAllow: Record<string, string[]>; // network => [token addresses]
  perTxLimitByOriginWei: Record<string, string>; // origin => wei string
  dailyLimitByOriginWei: Record<string, string>; // origin => wei string
  unknownOriginNeedsApproval: boolean;
  autoApproveUnderWei: string; // global small amount auto approve threshold
};

type PersistedConfig = {
  policy: Policy;
  wallet: { hasKey: boolean };
};

export const memory = {
  privateKey: null as null | `0x${string}`,
  address: null as null | `0x${string}`,
  policy: null as null | Policy,
  approvals: {} as Record<string, any>,
};

const defaultPolicy: Policy = {
  networksAllow: ['base', 'base-sepolia'],
  assetsAllow: {
    base: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' /* USDC */],
    'base-sepolia': [],
  },
  perTxLimitByOriginWei: {},
  dailyLimitByOriginWei: {},
  unknownOriginNeedsApproval: true,
  autoApproveUnderWei: '0',
};

export async function loadConfig() {
  let cfg: PersistedConfig | null = null;
  if (fs.existsSync(CONFIG_FILE)) {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  }
  if (!cfg) {
    cfg = { policy: defaultPolicy, wallet: { hasKey: false } };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  }
  memory.policy = cfg.policy;

  // load approvals
  if (fs.existsSync(APPROVALS_FILE)) {
    try {
      memory.approvals = JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf-8'));
    } catch {
      memory.approvals = {};
    }
  }

  const envPk = process.env.PRIVATE_KEY;
  if (envPk && /^0x[0-9a-fA-F]{64}$/.test(envPk)) {
    setInMemoryPrivateKey(envPk as `0x${string}`);
  }
}

function updateWalletFlag(hasKey: boolean) {
  const policy = memory.policy || defaultPolicy;
  const cfg: PersistedConfig = {
    policy,
    wallet: { hasKey },
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

export function setInMemoryPrivateKey(pk: `0x${string}`) {
  memory.privateKey = pk;
  updateWalletFlag(true);
}

export function persistPolicy(policy: Policy) {
  const base: PersistedConfig = {
    policy,
    wallet: { hasKey: hasPrivateKey() },
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(base, null, 2));
  memory.policy = policy;
}

export function hasPrivateKey(): boolean {
  return Boolean(memory.privateKey) || fs.existsSync(SECURE_FILE);
}

// deriveKey removed; using webcrypto kdf

function enc(str: string): Uint8Array { return new TextEncoder().encode(str); }

async function kdf(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  const data = new Uint8Array(enc(passphrase).length + salt.length);
  data.set(enc(passphrase), 0);
  data.set(salt, enc(passphrase).length);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hash); // 32 bytes
}

export async function savePrivateKeyEncrypted(pk: `0x${string}`, passphrase: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyBytes = await kdf(passphrase, salt);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const plaintext = new Uint8Array(Buffer.from(pk.slice(2), 'hex'));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const payload = new Uint8Array(salt.length + iv.length + ciphertext.length);
  payload.set(salt, 0);
  payload.set(iv, salt.length);
  payload.set(ciphertext, salt.length + iv.length);
  fs.writeFileSync(SECURE_FILE, payload);
  setInMemoryPrivateKey(pk);
}

export async function loadPrivateKeyEncrypted(passphrase: string): Promise<`0x${string}`> {
  const buf = fs.readFileSync(SECURE_FILE);
  const salt = new Uint8Array(buf.subarray(0, 16));
  const iv = new Uint8Array(buf.subarray(16, 28));
  const ciphertext = new Uint8Array(buf.subarray(28));
  const keyBytes = await kdf(passphrase, salt);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext));
  const pk = ('0x' + Buffer.from(plain).toString('hex')) as `0x${string}`;
  setInMemoryPrivateKey(pk);
  return pk;
}

export function clearPrivateKey() {
  memory.privateKey = null;
  memory.address = null;
  if (fs.existsSync(SECURE_FILE)) fs.unlinkSync(SECURE_FILE);
  updateWalletFlag(false);
}

export async function recordAudit(event: any) {
  const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
  fs.appendFileSync(AUDIT_FILE, line);
}

export function persistApprovals() {
  fs.writeFileSync(APPROVALS_FILE, JSON.stringify(memory.approvals, null, 2));
}
