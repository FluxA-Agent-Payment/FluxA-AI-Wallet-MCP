import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hasAgentId, getEffectiveAgentId } from '../../agent/agentId.js';
import { updateJWT } from '../../agent/agentId.js';
import { isJWTExpired, refreshJWT } from '../../wallet/client.js';
import { credentialFailure } from '../../agent/credentialError.js';

export function registerGetAgentStatusTool(server: McpServer) {
  const description = `Query the current FluxA Agent ID configuration status.

Returns information about whether an Agent ID is configured and its details.

**Use this tool to:**
- Check if the agent is registered before making payment requests
- Display agent configuration details to the user
- Verify that environment variables are correctly set`;

  server.registerTool(
    'get_agent_status',
    {
      description,
      inputSchema: {},
    },
    async () => {
      const configured = hasAgentId();
      const agentId = getEffectiveAgentId();

      if (agentId?.jwt && isJWTExpired(agentId.jwt)) {
        try { updateJWT(await refreshJWT(agentId.agent_id, agentId.token)); }
        catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ configured, agent_id: agentId.agent_id, ...credentialFailure(error, agentId.agent_id) }) }] }; }
      }

      const response = {
        configured,
        agent_id: agentId?.agent_id || null,
        agent_name: agentId?.agent_name || null,
        registered_at: agentId?.registered_at || null,
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response),
          },
        ],
      };
    }
  );
}
