# Token Plan

A Token Plan is a month of model calls on one flat allowance, bought once. It is
the alternative to prepaid Units: Units meter every call against the account's
balance, a plan does not meter at all until the allowance runs out.

Reach for a plan when the user wants predictable monthly cost or is calling one
provider steadily. Reach for Units when usage is occasional or spread across
providers.

**A plan key is the PROVIDER's key, not a FluxA key.** It is used against the
provider's own endpoint, so it does not authenticate at `/llm/{merchant}`, and a
FluxA `fxa_live_` key does not authenticate at the provider. Two products, two
credentials, and swapping them returns 401 either way.

## Buying one

**In USDC**, from the wallet's own balance:

```bash
fluxa-wallet market tokenplan buy lite      # prints a checkout link
fluxa-wallet market tokenplan order <id>    # settled? seat ready?
```

`buy` only CREATES the link. The money moves when the user opens it and
approves, which is the confirmation step, so it takes no `--yes` and running it
cannot spend anything. Tell the user the price it prints before handing over the
link.

**By card instead**, read
`https://agentmarket.fluxapay.xyz/marketplace/tokenplans/topup.md` and follow it
exactly. It is the tested procedure and it is kept current; a flow written from
memory here would drift from it.

## Using one you already hold

| What | Command |
|------|---------|
| Plans held, allowance left, days left, and the id the rest take | `fluxa-wallet market tokenplan list` |
| The provider key and base url for one plan | `fluxa-wallet market tokenplan key <id>` |
| What that plan has spent, per model | `fluxa-wallet market tokenplan usage <id>` |
| Which models the plan can call | `fluxa-wallet market tokenplan models` |

One endpoint has no wrapper: `POST /llm/tokenplan/subscription/{id}/retry`
finishes a setup that stalled. Call it directly against
`https://router.fluxapay.xyz` with the same token, or send the user to their
console, which has a button for it.

## Codes

Two kinds, and they are not interchangeable:

- **Redemption code**, one person, one plan of their own:
  `fluxa-wallet market tokenplan redeem <code> --yes`, or send the user to
  `https://agentmarket.fluxapay.xyz/offers/tokenplan/t01`.
- **Shared code**, many people, all on one plan FluxA already owns, free:
  `fluxa-wallet market tokenplan claim <code> --yes`.

A code is spent once and cannot be un-spent. `--yes` is required for exactly
that reason: **confirm with the user first**, the same as a purchase. It costs
no money, so nothing else would have stopped you, and redeeming onto the wrong
account cannot be undone.

Both answer one message for used, expired, voided and never-existed. That is
deliberate: retrying variations to find out which does not work, and reads as
guessing at codes.

## CLI Commands Quick Reference

| Command | Required Flags | Description |
|---------|----------------|-------------|
| `market tokenplan buy` | (plan arg) | A checkout link to pay for a plan in USDC. Creates only; paying is the spend |
| `market tokenplan order` | (id arg) | Whether that purchase settled, and whether its seat is ready |
| `market tokenplan list` | (none) | Token Plans held: allowance left, days left, id |
| `market tokenplan key` | (id arg) | The provider key and base url for one plan |
| `market tokenplan usage` | (id arg) | What that plan has spent, per model |
| `market tokenplan models` | (none) | Which models a plan can call |
| `market tokenplan redeem` | (code arg), `--yes` | Spend a redemption code (one-shot, cannot be undone) |
| `market tokenplan claim` | (code arg), `--yes` | Claim a shared plan code (one-shot, cannot be undone) |
