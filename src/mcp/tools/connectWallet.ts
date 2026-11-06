import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { beginConnection, connectionStatus, ConnectionError } from '../../agent/connect.js';
import { CredentialError, credentialFailure } from '../../agent/credentialError.js';

export function missingConnectionToolResult(agentId?: string) {
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({
    status: 'error', code: 'wallet_connection_required', reconnect_required: true,
    message: 'Connect the wallet using connect_wallet. Show its authorization_url, then wait using get_wallet_connection. Do not automatically register a new Agent ID.',
    next_tool: { name: 'connect_wallet', arguments: agentId ? { agent_id: agentId } : {} },
  }) }] };
}

function failure(error: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ success: false,
    ...(error instanceof CredentialError ? credentialFailure(error)
      : error instanceof ConnectionError ? { code: error.code, error: error.message, retryable: error.retryable }
      : { code: 'connection_service_unavailable', error: 'Connection service unavailable; retry the same request.' }),
  }) }] };
}

export function registerConnectWalletTools(server: McpServer) {
  server.registerTool('connect_wallet', {
    description: 'Default wallet onboarding and reconnect entry point. Reuses valid credentials; otherwise returns a browser approval link. Include the existing agent_id when reconnecting. The user chooses an identity only if none was requested. Show the link, then use get_wallet_connection; never ask for a done reply. client_name is the requester name used for newly created identities.',
    inputSchema: { agent_id: z.string().max(128).optional(), client_name: z.string().max(120).optional(),
      runtime: z.enum(['local', 'vm', 'container', 'unknown']).optional(), hosting: z.enum(['local', 'cloud', 'unknown']).optional(),
      reconnect: z.boolean().optional() },
  }, async args => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await beginConnection(args)) }] }; }
    catch (error) { return failure(error); }
  });
  server.registerTool('get_wallet_connection', {
    description: 'Poll a pending wallet connection and save the returned ordinary agent_id/token/jwt credentials. Poll secrets are kept internally. wait_seconds may be up to 10800; use bounded waits such as 100 seconds and continue while authorization is pending.',
    inputSchema: { wait_seconds: z.number().int().min(0).max(10800).optional() },
  }, async args => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await connectionStatus(args.wait_seconds || 0)) }] }; }
    catch (error) { return failure(error); }
  });
}
