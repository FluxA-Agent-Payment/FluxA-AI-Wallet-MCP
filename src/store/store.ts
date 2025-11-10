import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA_ROOT = process.env.FLUXA_DATA_DIR
  ? path.resolve(process.env.FLUXA_DATA_DIR)
  : path.join(os.homedir(), '.fluxa-ai-wallet-mcp');
const DATA_DIR = DATA_ROOT;
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');

export function ensureDataDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  }

  memory.config = cfg;
}

/**
 * Save current config to disk
 */
export function saveConfig() {
  if (!memory.config) {
    memory.config = defaultConfig;
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(memory.config, null, 2));
}

/**
 * Record audit event to log file
 */
export async function recordAudit(event: any) {
  const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
  fs.appendFileSync(AUDIT_FILE, line);
}
