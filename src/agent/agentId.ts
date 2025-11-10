import { memory, saveConfig } from '../store/store.js';

export interface AgentIdConfig {
  agent_id: string;
  token: string;
  jwt: string;
  email?: string;
  agent_name?: string;
  client_info?: string;
  registered_at?: string;
}

// Runtime JWT override for environment variable credentials
// Used when JWT is refreshed but env vars can't be modified
let runtimeJWT: string | null = null;

/**
 * Get Agent ID configuration from config file only
 */
export function getAgentId(): AgentIdConfig | null {
  if (!memory.config || !memory.config.agentId || !memory.config.agentId.agent_id) {
    return null;
  }
  return memory.config.agentId;
}

/**
 * Get Agent ID credentials from environment variables (method 1)
 * Environment variables take precedence over config file
 */
export function getAgentIdFromEnv(): AgentIdConfig | null {
  const agentId = process.env.AGENT_ID;
  const token = process.env.AGENT_TOKEN;
  const jwt = process.env.AGENT_JWT;

  if (agentId && token && jwt) {
    return {
      agent_id: agentId,
      token: token,
      jwt: jwt,
    };
  }
  return null;
}

/**
 * Get effective Agent ID (env credentials take precedence over config)
 * This is the primary function to get Agent ID for payment operations
 * Applies runtime JWT override if available
 */
export function getEffectiveAgentId(): AgentIdConfig | null {
  const agentId = getAgentIdFromEnv() || getAgentId();

  // Apply runtime JWT override if available
  if (agentId && runtimeJWT) {
    return {
      ...agentId,
      jwt: runtimeJWT,
    };
  }

  return agentId;
}

/**
 * Check if Agent ID is configured
 * Returns true only if agent_id, token, and jwt are all present
 * Checks both environment variables and config file (via getEffectiveAgentId)
 */
export function hasAgentId(): boolean {
  const effective = getEffectiveAgentId();
  return Boolean(
    effective &&
    effective.agent_id &&
    effective.token &&
    effective.jwt
  );
}

/**
 * Get registration info from environment variables (method 2)
 * This requires calling registration API to convert to credentials
 */
export function getRegistrationInfoFromEnv(): { email: string; agent_name: string; client_info: string } | null {
  const email = process.env.AGENT_EMAIL;
  const agentName = process.env.AGENT_NAME;
  const clientInfo = process.env.CLIENT_INFO;

  if (email && agentName && clientInfo) {
    return {
      email,
      agent_name: agentName,
      client_info: clientInfo,
    };
  }
  return null;
}

/**
 * Check if registration info is available from env vars
 */
export function hasRegistrationInfo(): boolean {
  return getRegistrationInfoFromEnv() !== null;
}

/**
 * Save Agent ID configuration to config file
 */
export function saveAgentId(config: AgentIdConfig): void {
  if (!memory.config) {
    throw new Error('Config not initialized');
  }
  memory.config.agentId = {
    ...config,
    registered_at: config.registered_at || new Date().toISOString(),
  };
  saveConfig();
}

/**
 * Clear Agent ID configuration from config file
 */
export function clearAgentId(): void {
  if (!memory.config) {
    throw new Error('Config not initialized');
  }
  memory.config.agentId = {
    agent_id: '',
    token: '',
    jwt: '',
  };
  saveConfig();
}

/**
 * Update JWT token
 * If Agent ID is from config file, updates and persists
 * If Agent ID is from environment variables, stores in runtime override
 */
export function updateJWT(newJWT: string): void {
  const envId = getAgentIdFromEnv();

  if (envId) {
    // Agent ID from env vars - store in runtime override
    runtimeJWT = newJWT;
    console.error('[agent] JWT refreshed (runtime override for env vars)');
  } else {
    // Agent ID from config file - update and persist
    if (!memory.config || !memory.config.agentId) {
      throw new Error('Cannot update JWT: Agent ID not configured');
    }
    memory.config.agentId.jwt = newJWT;
    saveConfig();
    console.error('[agent] JWT refreshed and saved to config file');
  }
}
