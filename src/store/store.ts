import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DATA_ROOT = process.env.FLUXA_DATA_DIR
  ? path.resolve(process.env.FLUXA_DATA_DIR)
  : path.join(os.homedir(), '.fluxa-ai-wallet-mcp');
const DATA_DIR = DATA_ROOT;
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');

export function ensureDataDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

export type AgentIdConfig = {
  agent_id: string;
  token: string;
  jwt: string;
  email?: string;
  agent_name?: string;
  client_info?: string;
  registered_at?: string;
};

export type Config = {
  agentId: AgentIdConfig;
};

export const memory = {
  config: null as null | Config,
};

const defaultConfig: Config = {
  agentId: {
    agent_id: '',
    token: '',
    jwt: '',
  },
};

/**
 * Load configuration from disk
 * Creates default config if it doesn't exist
 */
export async function loadConfig() {
  let cfg: Config | null = null;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch (e) {
      console.error('[store] Failed to parse config file, using default:', e);
    }
  }

  if (!cfg) {
    cfg = defaultConfig;
    writeConfig(cfg);
  }

  memory.config = cfg;
  fs.chmodSync(CONFIG_FILE, 0o600);
}

/**
 * Save current config to disk
 */
export function saveConfig() {
  if (!memory.config) {
    memory.config = defaultConfig;
  }
  writeConfig(memory.config);
}

function writeConfig(config: Config) {
  const temp = `${CONFIG_FILE}.${crypto.randomUUID()}`;
  try { fs.writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 }); fs.renameSync(temp, CONFIG_FILE); }
  finally { fs.rmSync(temp, { force: true }); }
}

/**
 * Record audit event to log file
 */
export async function recordAudit(event: any) {
  const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
  fs.appendFileSync(AUDIT_FILE, line);
}
