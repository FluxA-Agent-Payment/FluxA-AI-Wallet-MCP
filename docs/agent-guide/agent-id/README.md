# Agent ID

## What It Does

Agent ID is the identity and authentication layer for AI agents using FluxA Wallet. Before an agent can make payments, send payouts, or create payment links, it must connect an Agent ID. Browser connection can reuse an existing identity and returns the same three credentials:

| Credential | Purpose | Lifetime |
|------------|---------|----------|
| `agent_id` | Unique identifier for the agent | Permanent |
| `token` | Opaque secret used to refresh JWTs | Owner-selected expiry; legacy master tokens remain supported |
| `jwt` | Short-lived bearer token for API calls | Expires periodically (auto-refreshable) |

## Default wallet connection (0.6.0+)

```bash
fluxa-wallet connect --client "My AI Client"
# Show authorization_url, then wait without asking the user to reply done:
fluxa-wallet connect-status --wait 100
# If the identity is already known, including after token_expired:
fluxa-wallet connect --agent-id <original-id> --client "My AI Client"
```

The owner selects an existing identity or New Agent ID. Empty accounts default
to creating one, named after the requester, only on approval. A supplied Agent
ID is locked and must belong to the signed-in owner. The page shows requester
name/environment, without a comparison code. Request/link/claim/retry windows
are three hours; token validity defaults to seven days. Reconnect the same ID
on `token_expired`/`token_revoked`; retry service failures without registration.
`connect_wallet` and `get_wallet_connection` are the equivalent MCP tools.

The registration flow below remains available for explicit new identities.

## What an Agent Can Do

- **Register** a new agent identity (one-time setup)
- **Check status** of its current registration and JWT validity
- **Refresh JWT** automatically when it expires (using `agent_id` + `token`)

## Related APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/register` | Register a new agent (Agent ID API) |
| `POST` | `/refresh` | Refresh an expired JWT (Agent ID API) |

**Base URL:** `https://agentid.fluxapay.xyz`

## MCP Tools

| Tool | Description |
|------|-------------|
| `init_agent_id` | Register a new agent or use env-var credentials |
| `get_agent_status` | Check current agent configuration status |

## CLI Commands

| Command | Description |
|---------|-------------|
| `init` | Register a new agent |
| `status` | Check agent configuration status |

## Integration Flow

### Step 1 — Explicit registration (legacy alternative)

**Via CLI:**

```bash
fluxa-wallet init \
  --name "My AI Agent" \
  --client "Claude Code CLI v1.0"
```

**Via API:**

```bash
curl -X POST https://agentid.fluxapay.xyz/register \
  -H "Content-Type: application/json" \
  -d '{
    "agent_name": "My AI Agent",
    "client_info": "Claude Code CLI v1.0"
  }'
```

**Response:**

```json
{
  "agent_id": "ag_xxxxxxxxxxxx",
  "token": "tok_xxxxxxxxxxxx",
  "jwt": "eyJhbGciOiJ..."
}
```

### Step 2 — Verify Status

```bash
fluxa-wallet status
```

```json
{
  "success": true,
  "data": {
    "configured": true,
    "agent_id": "ag_xxxxxxxxxxxx",
    "has_token": true,
    "has_jwt": true,
    "jwt_expired": false,
    "agent_name": "My AI Agent"
  }
}
```

### Step 3 — Use Credentials

Once registered, pass the JWT as a Bearer token for all subsequent Wallet API calls:

```
Authorization: Bearer <jwt>
```

The JWT expires periodically. The MCP server and CLI handle refresh automatically. If you are calling the API directly, refresh with:

```bash
curl -X POST https://agentid.fluxapay.xyz/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "ag_xxxxxxxxxxxx",
    "token": "tok_xxxxxxxxxxxx"
  }'
```

### Alternative: Environment Variable Configuration

Instead of calling `init`, you can pre-configure credentials via environment variables:

```bash
# Method 1: Provide existing credentials (highest priority)
export AGENT_ID="ag_xxxxxxxxxxxx"
export AGENT_TOKEN="tok_xxxxxxxxxxxx"
export AGENT_JWT="eyJhbGciOiJ..."

# Method 2: Provide registration info (auto-registers on first use)
export AGENT_NAME="My AI Agent"
export CLIENT_INFO="Claude Code CLI v1.0"
```

## Architecture Notes

- Agent ID is stored locally in `~/.fluxa-ai-wallet-mcp/config.json`
- The `agent_id` and `token` are permanent — only the JWT expires
- JWT is refreshed automatically within a 5-minute buffer before expiry
- All tools and CLI commands check JWT validity before making API calls
