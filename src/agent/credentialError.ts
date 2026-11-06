export class CredentialError extends Error {
  readonly reconnect_required = true;
  constructor(public code: string, public agentId?: string, public environmentCredentials = false) {
    super(environmentCredentials
      ? 'Injected wallet credentials cannot be replaced by a local file. Update/remove AGENT_ID, AGENT_TOKEN and AGENT_JWT, then reconnect to the same Agent ID.'
      : 'Wallet credentials are no longer valid. Reconnect to obtain a valid token; do not register a new Agent ID.');
  }
}

export function credentialFailure(error: unknown, agentId?: string) {
  if (error instanceof CredentialError) return {
    code: error.code, error: error.message, message: error.message, reconnect_required: true,
    agent_id: error.agentId || agentId,
    next_command: `fluxa-wallet connect${error.agentId || agentId ? ` --agent-id ${error.agentId || agentId}` : ''}`,
    next_tool: { name: 'connect_wallet', arguments: { ...(error.agentId || agentId ? { agent_id: error.agentId || agentId } : {}) } },
  };
  return { code: 'jwt_refresh_failed', error: 'JWT refresh is temporarily unavailable. Retry without registering a new identity.',
    message: 'JWT refresh is temporarily unavailable. Retry without registering a new identity.', reconnect_required: false };
}
