# FluxA AI Wallet MCP

MCP server for FluxA AI Wallet with x402 (EIP-3009 exact) payment support.

## Overview

This MCP server enables AI agents to make x402 payments using the FluxA Wallet API. It provides a simple interface for agents to register, authenticate, and execute blockchain payments without managing private keys locally.

## Features

- **Agent ID Management**: Register and manage FluxA Agent IDs
- **x402 Payment Support**: Generate EIP-3009 payment authorizations via FluxA Wallet API
- **Automatic JWT Refresh**: Automatically refreshes expired JWT tokens before payments
- **No Local Key Management**: All signing is handled by FluxA Wallet (no local private keys)
- **No Web UI**: Pure CLI tool for easy deployment
- **Policy Management**: Policies are managed remotely by FluxA Wallet
- **Environment Variable Support**: Configure via env vars or config file

## Quick Start

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

### Build

```bash
npm run build
npm start
```

### Configuration

The server stores configuration in `~/.fluxa-ai-wallet-mcp/config.json` by default.

You can override the data directory:

```bash
export FLUXA_DATA_DIR=/path/to/custom/dir
```

#### Agent ID Configuration

There are **two methods** to configure Agent ID via environment variables:

**Method 1: Use existing credentials (highest priority)**

If you already have Agent ID credentials, set these environment variables:

```bash
export AGENT_ID=your-agent-id
export AGENT_TOKEN=your-token
export AGENT_JWT=your-jwt
```

This method bypasses registration and uses the provided credentials directly.

**Method 2: Provide registration information**

If you don't have credentials yet, configure registration information:

```bash
export AGENT_EMAIL=user@example.com
export AGENT_NAME="Claude Desktop - John's MacBook"
export CLIENT_INFO="Claude Desktop v1.0 on macOS 14.1"
```

When these are set, calling `init_agent_id` with empty parameters `{}` will automatically register using this information.

**Priority order:**
1. Method 1 environment variables (AGENT_ID + AGENT_TOKEN + AGENT_JWT)
2. Config file (`~/.fluxa-ai-wallet-mcp/config.json`)
3. Method 2 environment variables (requires calling `init_agent_id`)
4. Manual registration (requires user input)

## MCP Tools

### 1. `init_agent_id`

Register a new FluxA Agent ID. This must be called before making payments.

**Configuration Methods:**

This tool supports two ways to provide registration information:

1. **Using environment variables (Method 2 above)**: If `AGENT_EMAIL`, `AGENT_NAME`, and `CLIENT_INFO` are set, simply call with empty parameters:
   ```json
   {}
   ```

2. **Using parameters**: If environment variables are not set, provide the information directly:
   ```json
   {
     "email": "user@example.com",
     "agent_name": "Claude Desktop - John's MacBook",
     "client_info": "Claude Desktop v1.0 on macOS 14.1"
   }
   ```

**Output:**
```json
{
  "status": "ok",
  "agent_id": "uuid-string",
  "message": "Agent ID registered successfully"
}
```

**Usage by Agent:**
- If environment variables are configured (Method 2), simply call `init_agent_id` with `{}`
- Otherwise:
  1. Ask the user for their email address
  2. Choose a meaningful agent name (e.g., "Claude Desktop - User's Computer")
  3. Provide client information (e.g., "Claude Desktop v1.0 on macOS")
  4. Call this tool with the collected parameters

### 2. `request_x402_payment`

Generate an x402 payment authorization by calling FluxA Wallet API.

**Input:**
```json
{
  "payment_required": {
    "x402Version": 1,
    "accepts": [{
      "scheme": "exact",
      "network": "base",
      "maxAmountRequired": "10000",
      "resource": "https://example.com/api/data",
      "description": "API access",
      "mimeType": "application/json",
      "payTo": "0x...",
      "maxTimeoutSeconds": 300,
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "extra": {
        "name": "USD Coin",
        "version": "2"
      }
    }]
  },
  "intent": {
    "why": "Access protected API endpoint",
    "http_method": "GET",
    "http_url": "https://example.com/api/data",
    "caller": "user-agent-name"
  },
  "options": {
    "validity_window_seconds": 60,
    "approval_id": "apprv_123"
  }
}
```

`approval_id` is optional. Supply it when the wallet instructs you to complete an external approval flow so the retry can be linked to that approval.

**Output:**
```json
{
  "status": "ok",
  "x_payment": "base64-encoded-payment-header",
  "x_payment_object": {
    "x402Version": 1,
    "scheme": "exact",
    "network": "base",
    "payload": { ... }
  }
}
```

**Error (Agent Not Registered):**
```json
{
  "status": "error",
  "code": "agent_not_registered",
  "message": "FluxA Agent ID not configured. Please register first.",
  "pmc": {
    "primer": "Please read and follow pmc.instructions...",
    "instructions": "Agent ID is not configured. Please call init_agent_id..."
  }
}
```

**Error (Approval Required):**
```json
{
  "status": "approval_required",
  "code": "approval_required",
  "message": "Approval required",
  "approvalId": "apprv_123",
  "approvalUrl": "https://wallet.fluxapay.xyz/approvals/apprv_123",
  "pmc": {
    "primer": "Please read and follow pmc.instructions...",
    "instructions": "Visit the approval URL, authorize the request, then call request_x402_payment again with options.approval_id=apprv_123."
  }
}
```

### 3. `get_agent_status`

Query the current Agent ID configuration status.

**Input:** None

**Output:**
```json
{
  "configured": true,
  "agent_id": "uuid-string",
  "agent_name": "Claude Desktop - John's MacBook",
  "email": "user@example.com",
  "registered_at": "2024-01-01T00:00:00.000Z"
}
```

## Workflow

### First-Time Setup

1. **Agent calls `request_x402_payment` without registration**
   - Server returns error with code `agent_not_registered`
   - PMC instructions guide the agent to register

2. **Agent collects user information**
   - Ask user for email address
   - Generate meaningful agent name based on environment
   - Prepare client info string

3. **Agent calls `init_agent_id`**
   - Server registers with FluxA Agent ID API
   - Returns agent_id, token, and JWT
   - Configuration is saved automatically

4. **Agent retries `request_x402_payment`**
   - Server calls FluxA Wallet API with JWT
   - Returns signed payment authorization
   - Agent adds X-Payment header and retries the HTTP request

### Subsequent Payments

Once registered, agents can directly call `request_x402_payment` without re-registering. The JWT is used to authenticate with FluxA Wallet API.

## API Endpoints

### FluxA Agent ID API

**Base URL:** `https://agentid.fluxapay.xyz`

**POST /register**
```bash
curl -X POST https://agentid.fluxapay.xyz/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "agent_name": "My Agent",
    "client_info": "My Client v1.0"
  }'
```

**Response:**
```json
{
  "agent_id": "uuid-string",
  "token": "token-string",
  "jwt": "jwt-string"
}
```

### FluxA Wallet API

**Base URL:** `https://walletapi.fluxapay.xyz`

**POST /api/payment/x402V1Payment**
```bash
curl -X POST https://walletapi.fluxapay.xyz/api/payment/x402V1Payment \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -d '{
    "scheme": "exact",
    "network": "base",
    "amount": "10000",
    "currency": "USDC",
    "assetAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x...",
    "host": "example.com",
    "resource": "https://example.com/api/data",
    "description": "API access",
    "tokenName": "USD Coin",
    "tokenVersion": "2",
    "validityWindowSeconds": 60
  }'
```

## Architecture

```
MCP Server (stdio)
├── Agent ID Management
│   ├── Registration with FluxA Agent ID API
│   └── Local config storage (agent_id, token, jwt)
├── Wallet API Client
│   ├── x402V1Payment calls
│   └── JWT-based authentication
└── MCP Tools
    ├── init_agent_id
    ├── request_x402_payment
    └── get_agent_status
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FLUXA_DATA_DIR` | Data directory path | `~/.fluxa-ai-wallet-mcp` |
| **Method 1: Existing Credentials** | | |
| `AGENT_ID` | Agent ID (highest priority) | - |
| `AGENT_TOKEN` | Agent token (highest priority) | - |
| `AGENT_JWT` | Agent JWT (highest priority) | - |
| **Method 2: Registration Info** | | |
| `AGENT_EMAIL` | Email for registration | - |
| `AGENT_NAME` | Agent name for registration | - |
| `CLIENT_INFO` | Client info for registration | - |
| **API Endpoints** | | |
| `AGENT_ID_API` | Agent ID API base URL | `https://agentid.fluxapay.xyz` |
| `WALLET_API` | Wallet API base URL | `https://walletapi.fluxapay.xyz` |

## Configuration File

Location: `~/.fluxa-ai-wallet-mcp/config.json`

```json
{
  "agentId": {
    "agent_id": "uuid-string",
    "token": "token-string",
    "jwt": "jwt-string",
    "email": "user@example.com",
    "agent_name": "My Agent",
    "client_info": "My Client v1.0",
    "registered_at": "2024-01-01T00:00:00.000Z"
  }
}
```

## JWT Token Management

The MCP server automatically manages JWT token lifecycle:

**Automatic Refresh:**
- Before each payment request, the server checks if the JWT is expired or expiring soon (within 5 minutes)
- If expired, automatically calls the refresh endpoint to get a new JWT
- Refresh uses the `agent_id` and `token` (which don't expire)

**Storage:**
- **Environment variables**: Refreshed JWT is stored in runtime memory (not persisted)
- **Config file**: Refreshed JWT is automatically saved to `~/.fluxa-ai-wallet-mcp/config.json`

**Manual Refresh:**
You can also manually refresh the JWT using curl:
```bash
curl -X POST https://agentid.fluxapay.xyz/refresh \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "your-agent-id", "token": "your-token"}'
```

## Notes

- This is a stateless MCP server that delegates all payment logic to FluxA Wallet API
- No private keys are stored or managed locally
- Policy management (limits, approvals, etc.) is handled by FluxA Wallet
- All payment authorizations are signed by FluxA Wallet
- The JWT is used to authenticate all payment requests
- JWT tokens are automatically refreshed when expired (using agent_id + token)
- Agent ID registration is a one-time operation per agent instance

## Supported Networks

- Base (chainId: 8453)
- Base Sepolia (chainId: 84532)

## Supported Assets

- USDC on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

## License

MIT
