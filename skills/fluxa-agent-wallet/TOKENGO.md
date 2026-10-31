# TokenGo shared memory

Use when the user chooses TokenGo or hands off token management from the wallet.
Local-only storage remains supported. Payments still use the Wallet CLI and a
valid signed mandate; a TokenGo registry entry is not payment authorization.

Wallet: https://app.fluxapay.xyz/?tab=tokengo
Wallet dev: https://agentwallet.fluxapay-qa.xyz/?tab=tokengo
Agent-only guide: https://tokengo.fluxapay.xyz/llms.txt

Read that live guide for authentication, schemas and the helper script before
calling TokenGo. Use your own Agent ID and audience=tokengo Agent VC. The first
successful request automatically opens an account. There is no connection code
or pairing step. A machine-obtained nonce binds the VC to the request and prevents
replay; this exchange needs no human interaction. Never send a login JWT or reuse
a TokenGo VC against Wallet or AgentMarket.

Signed VC wallet-verified email and wallet_address claims associate records with
the verified wallet owner. Without those claims an agent still gets an isolated
account; link the user's wallet with the standard Wallet skill workflow if they
want to see the records in the wallet UI. Never invent or submit an owner claim.
Wallet dev and production access the same TokenGo service; only matching verified
owner identities can see the same data.

Use the handoff's budget purpose, initial recharge amount (UI default USD 10),
automatic recharge threshold and per-recharge amount. Match the actual bundle,
price and currency with the user before payment. Reuse a suitable signed mandate;
when a new one is needed, its total allowance does not reset monthly. Execute
initial recharge only within the approved rules and mandate, then set up the real
scheduler. The initial payment is not evidence that a recurring task exists.

Register accounts, per-business Key metadata, budget purpose/total/mandate/expiry,
initialTopupUsd, thresholdUsd and topupUsd. Raw key and integration-key uploads
are separately optional. Credentials must not appear in account JSON or notes.
TokenGo omits secrets in replies; keep recoverable originals in the user's secure
store. Dedicated AgentMarket query keys are not provider-enforced read-only.

Record completed recharges once using stable payment/order IDs: type=topup,
trigger=initial for the first recharge; trigger=automatic for scheduled ones.
Record manual purchases as manual. Do not report uncertain or failed payments as
completed spending. TokenGo's budget tab lists budgets and automatic recharge
records separately from model consumption. Query actual wallet authorization
before any payment; registered remaining budget is only a reported total.

Register a monitor only after creating a real scheduler in the agent runtime.
Post checkins on every real run, including errors and required approvals. A
monitor awaits its first checkin and becomes overdue after 1.5 × its interval.
Stopping the registry entry does not stop the actual runtime scheduler.

With an uploaded integration key, TokenGo directly reads AgentMarket balance and
up to 1,000 recent usage records. Respect timestamps, partial coverage, and
unattributed calls. Preserve nonsecret events during outages and reconcile later
with the same IDs. A TokenGo outage must not cause a duplicate purchase.

Only AgentMarket setup is enabled in the current UI. Baidu AI Cloud, AiHubMix and
OpenRouter are Coming soon; do not start those flows from a TokenGo handoff.
