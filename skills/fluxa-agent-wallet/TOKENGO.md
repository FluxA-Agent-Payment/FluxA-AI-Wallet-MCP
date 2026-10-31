# TokenGo shared memory

Use when the user chooses TokenGo from the wallet's “copy to my bot” flow or
asks to share token-management records with TokenGo. Local-only management
remains supported. TokenGo is a registry and usage-query service; wallet CLI
commands and signed mandates continue to control all payments.

## Connect the user's agent

- Wallet entry: https://agentwallet.fluxapay.xyz/?tab=tokengo (TokenGo UI rollout
  may still be in preview).
- Service: https://tokengo-production-04a9.up.railway.app
- Read the live [TokenGo Skill](https://tokengo-production-04a9.up.railway.app/skill.md)
  and [API reference](https://tokengo-production-04a9.up.railway.app/api-reference.md)
  before registering data. Use the service URL from the user's handoff when
  operating a different environment; do not mix staging and production.

The wallet handoff contains a one-use, 15-minute pairing code. Pairing lets this
agent read and maintain the owner's TokenGo records, and the owner can disconnect
it from TokenGo. A copied budget is not a signed payment authorization.

Use the current Agent ID from `fluxa-wallet status`. For each API request obtain
a fresh challenge from `/v1/auth/challenge` bound to agent ID, method, path and
SHA-256 body hash. Issue `fluxa-wallet agent-vc --audience tokengo --challenge
<nonce> --ttl 300`, then send the VC with `X-Agent-ID`. See the live helper at
`/agent-client.mjs`; it uses the installed CLI and keeps login JWTs private.
Do not reuse TokenGo VCs against Wallet or AgentMarket. Do not send the agent's
login JWT to TokenGo. Expired pairing needs a fresh code, not repeated retries.

## Register only what the user chose to share

1. Platform account: provider, alias and noncredential JSON account metadata.
2. Business Key: alias, provider Key ID, account reference, purpose, business
   type, optional budget. `rawKey` upload is optional and separately approved.
3. Budget: signed FluxA mandate ID, total allowance, expiry and account reference.
   The server derives the agent ID from the VC. The amount does not reset monthly.
4. Purchase or top-up events: actual amount, timestamp and stable payment/order ID.
5. Monitor: actual scheduler ID, interval/timezone and approved trigger/amount.
   Only register after scheduling succeeds; check in on every actual run.

Credentials belong only in the dedicated encrypted secret fields, never in
`accountInfo`, descriptions or plain Markdown. TokenGo API replies omit secret
values, and initial API has no secret-export endpoint; keep originals recoverable
in the user's secure store.

For direct AgentMarket balance/usage reads, the user may provide a dedicated
integration Key. AgentMarket currently does not enforce a read-only scope on it;
do not promise read-only privileges or treat zero spend cap as disabling spend.
TokenGo itself calls only provider read endpoints. Without a query Key, keep
balance unknown and report agent-observed usage rather than inventing a value.

## Check in and reconcile

`POST /v1/accounts/{id}/sync` reads balance and up to the latest 1,000 ledger
records. `GET /v1/overview` returns records and cached per-Key/model usage.
Treat partial coverage and stale timestamps explicitly; don't count top-ups,
settlements or adjustments as new model calls. Preserve unattributed records.

Post checkins for successes, low balances, errors and required approvals using
stable run IDs. TokenGo shows “awaiting checkin” until a real report arrives and
marks a monitor overdue after 1.5 × its interval. A registry entry alone is not
evidence that a scheduler is running. Stop the real scheduler when disabling
monitoring; changing the registry entry does not stop the runtime task.

During a TokenGo outage, preserve nonsecret events locally and reconcile later
with the same event IDs. Check payment status before retrying any uncertain
purchase. TokenGo failures do not grant permission to change payment rules.
