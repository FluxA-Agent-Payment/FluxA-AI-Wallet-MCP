# FluxA-AI-Wallet-MCP
MCP server for AI Wallet (x402 EIP-3009 exact).

What’s included
- Single MCP tool: `request_x402_payment` (no generic sign/transfer exposed)
- EIP-3009 signing for x402 exact scheme (Base / Base Sepolia)
- Local web UI for loading the private key and editing policy
- Basic approval flow with a consent page

Quick start
- Install deps: `npm i`
- Dev run: `npm run dev`
- Open config UI: `http://localhost:3078` and load a private key
- Connect as MCP server via stdio; tool name: `request_x402_payment`

如果运行环境禁止开放端口，可设置 `WEB_DISABLE=1` 并通过 `PRIVATE_KEY=0x...` 注入密钥；端口可用 `WEB_PORT=<number>` 修改。

数据目录默认在 `~/.fluxa-ai-wallet-mcp/`，可用 `FLUXA_DATA_DIR=/path/to/dir` 重定向（Claude 等客户端默认工作目录可能是 `/`）。

MCP tool: request_x402_payment
- Input
  - `payment_required`: JSON from x402 402 response (with `accepts[]`)
  - `selection?`: `{ acceptIndex? | scheme? | network? | asset? }`
  - `intent`: `{ why, http_method, http_url, caller, trace_id?, prompt_summary? }`
  - `options?`: `{ require_user_approval?, approval_id?, address_hint?, validity_window_seconds?, preferred_network?, preferred_asset? }`
- Output
  - `status`: `ok | need_approval | denied | error`
- on ok: `{ x_payment_b64, x_payment, address, chainId, expires_at, pmc, audit_id }`
- on need_approval: `{ approval_id, approval_url?, reason, expires_at, pmc }`
- 所有返回都会携带 `pmc`（payment model context），提示 LLM 如何向用户解释下一步操作。

Config UI
- Load private key (optionally encrypt & persist with a passphrase)
- Edit policy JSON (networks/assets allowlist, per-origin limits, auto-approve threshold)
- Approvals page at `/consents/:id`

Notes
- This is an MVP: no RPC calls are required for signing. On-chain balance/simulation can be added later.
- Private key persistence uses AES-256-GCM with user-supplied passphrase. Keep your passphrase safe.
