# Mandate Planning Policy

## Core Principle

Plan mandate budget by **task intent**, not by current API call. Minimize user authorization clicks by planning ahead.

## Task Classification

Before creating a mandate, classify the current task:

### Type 1 — Single-Step Task

A one-off action with a known, fixed cost.

**Examples:**
- Single USDC transfer
- Pay one payment link
- One API call with known price

**Strategy:** Request the exact cost. Do not add buffer — the user should see the actual amount being spent.

### Type 2 — Multi-Step Workflow

A task that requires multiple paid API calls in sequence.

**Examples:**
- Auth → get-card → get-card-data (Laso)
- Discover API → pay → generate → poll result (Banana/Seedance)
- Search x402 services → call multiple APIs to compare results

**Strategy:** Estimate the **total cost across all steps** before creating the mandate. Include retry buffer (1 extra attempt per step). Create **one mandate** covering the entire workflow — do NOT create a new mandate per step.

**Example calculation:**
| Step | Estimated cost |
|------|---------------|
| Auth call | 0.001 USDC |
| Generate image | 0.10 USDC |
| Possible retry | 0.10 USDC |
| **Total** | **0.201 USDC** |
| **Mandate request** | **~0.25 USDC** (with retry buffer) |

### Type 3 — Recurring / Long-Term Task

A task the user will repeat regularly or that the agent expects to do again.

**Examples:**
- Frequent small API calls to the same service
- Regular ClawPI posting
- Periodic data queries

**Strategy:** Create a reusable mandate with longer validity (`--seconds`, e.g., 7 days = 604800, 30 days = 2592000), covering expected usage over the period.

## Mandate Reuse Protocol

**MUST check for reusable mandates before creating a new one.**

Check these two sources:

### Source 1 — Current Conversation Context

Check if any mandate has already been created or used in the current conversation. If a mandateId is available in context and was recently signed, verify it's still valid before creating a new one.

### Source 2 — Local State File

Read `~/.fluxa-ai-wallet-mcp/mandates.json` and look for a mandate where:
- `status` is `"signed"`
- `validUntil` is in the future
- `currency` matches the required currency
- `scope` matches the target host/service (if set)

If a match is found, query its latest status via `mandate-status --id <mandateId>` to confirm it's still valid and has sufficient remaining budget. If confirmed → **reuse it**.

If no match from either source → create a new mandate.

## Mandate State Persistence

The agent MUST persist mandate state to `~/.fluxa-ai-wallet-mcp/mandates.json` so that mandates survive across conversations.

**If the file does not exist**, create it with `{"mandates": []}`.

**Schema:**

```json
{
  "mandates": [
    {
      "mandateId": "mand_xxxxxxxxxxxxx",
      "status": "signed",
      "purpose": "Laso auth and card ordering",
      "scope": "laso.finance",
      "taskType": "multi-step",
      "currency": "USDC",
      "limitAmount": "21000000",
      "validUntil": "2026-03-24T00:00:00Z",
      "createdAt": "2026-03-23T10:00:00Z"
    }
  ]
}
```

**Agent responsibilities:**

1. **After `mandate-create`**: Add entry with status `pending_signature`
2. **After user signs** (confirmed via `mandate-status`): Update status to `signed`, populate `validUntil`
3. **On `mandate_expired` or `mandate_budget_exceeded` error**: Update status to `expired` or `exhausted`
4. **On conversation start** (if payment task expected): Read the file and check for reusable mandates
