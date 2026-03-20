# Integration Guide — Agent ID

## Overview

Agent ID is FluxA's identity and authentication service for AI agents — similar to OAuth for agents. Services that serve AI agents can integrate Agent ID to:

1. Have their AI agent clients **register and obtain an Agent ID**
2. **Verify agent identity** on incoming requests via a standard header

## For AI Agents — Register & Authenticate

### Step 1 — Register

```bash
curl -X POST https://agentid.fluxapay.xyz/register \
  -H "Content-Type: application/json" \
  -d '{
    "agent_name": "My AI Agent",
    "client_info": "MyApp v1.0"
  }'
```

Response:

```json
{
  "agent_id": "ag_xxxxxxxxxxxx",
  "token": "tok_xxxxxxxxxxxx",
  "jwt": "eyJhbGciOiJ..."
}
```

| Credential | Purpose | Lifetime |
|------------|---------|----------|
| `agent_id` | Unique agent identifier | Permanent |
| `token` | Secret for refreshing JWT | Permanent |
| `jwt` | Bearer token for API calls | Short-lived, auto-refreshable |

### Step 2 — Attach to Requests

When calling a service that supports Agent ID, include:

```
Authorization: Bearer <jwt>
```

### Step 3 — Refresh JWT When Expired

```bash
curl -X POST https://agentid.fluxapay.xyz/refresh \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "ag_xxxxxxxxxxxx", "token": "tok_xxxxxxxxxxxx"}'
```

Returns a new `jwt`.

## For Services — Verify Agent Identity

### How It Works

```
Agent                          Your Service                    AgentID API
  |                                |                              |
  |-- Request + Bearer <jwt> ----->|                              |
  |                                |-- POST /verify {jwt} ------->|
  |                                |<-- {valid, agent_id, ...} ---|
  |                                |                              |
  |<-- Response -------------------|                              |
```

### Verify Endpoint

```bash
curl -X POST https://agentid.fluxapay.xyz/verify \
  -H "Content-Type: application/json" \
  -d '{"jwt": "eyJhbGciOiJ..."}'
```

Success response:

```json
{
  "valid": true,
  "agent_id": "ag_xxxxxxxxxxxx",
  "agent_name": "My AI Agent"
}
```

### Integration Example

```javascript
// Middleware: verify agent identity
async function verifyAgent(req, res, next) {
  const jwt = req.headers.authorization?.replace('Bearer ', '');
  if (!jwt) return res.status(401).json({ error: 'Missing agent credentials' });

  const resp = await fetch('https://agentid.fluxapay.xyz/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jwt }),
  });
  const result = await resp.json();

  if (!result.valid) return res.status(401).json({ error: 'Invalid agent identity' });

  req.agentId = result.agent_id;
  next();
}
```

## AgentID API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/register` | Register a new agent |
| `POST` | `/refresh` | Refresh an expired JWT |
| `POST` | `/verify` | Verify a JWT and get agent info |

**Base URL:** `https://agentid.fluxapay.xyz`
