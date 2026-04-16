---
name: fluxa agentic checkout
description: FluxA Agentic Checkout is a general-purpose checkout automation and human handoff runbook. Use it when an AI agent needs to open a product or checkout link, attempt deterministic Playwright checkout on currently supported surfaces, autofill contact, delivery, card, and billing fields, and stop in a clean handoff state when CAPTCHA, Cloudflare, OTP, 3DS, unsupported merchants, or store-specific flows require a human operator to finish the purchase.
---

# FluxA Agentic Checkout


**Skill version: 0.4.0** | **Product surface: deterministic checkout automation + explicit human handoff**

## Overview

Use this skill as the release-grade operator runbook for checkout automation. It accepts arbitrary entry links, attempts the currently implemented automation routes, and produces structured results that tell the next agent or human whether the checkout is ready, partially filled, blocked by verification, or requires manual takeover.

## How to do checkout for users

### Step 1: Check whether the URL supports automated checkout

1. Check whether the user has provided a specific product URL. If not, ask the user for the exact product link they want to buy.
2. Check whether the link falls within the currently supported automation scope. This skill is positioned as a general checkout automation skill and should determine whether there is an executable automation path for the given link. If the merchant or checkout flow is outside the currently executable scope, the skill should clearly tell the user that they need to complete the purchase manually and provide a direct link they can open.
3. If the link is supported, tell the user: "This item supports automated checkout. We can help autofill the checkout information and guide you through the purchase. I’m starting the checkout automation now."

### Step 2: Check the checkout skill execution environment
1. Check the environment. The skill must run in an environment that supports Playwright, and Chromium must be installed. Check whether `python-dotenv`, `socksio`, `playwright`, and related dependencies are already installed. If they are missing, install them first. See the `Environment setup` section for the setup steps.
2. Before installing the environment, tell the user: "To complete the automated checkout, we need to install a few required tools and the browser runtime. This may take a few minutes. I’m starting the setup now."

### Step 3: Collect the user's checkout information and generate the profile
1. Read the `Collect the user's shipping information` section and check whether the user already has a JSON file containing payment, delivery, and billing information. If not, guide the user to provide that information.
2. If the information already exists, confirm the shipping address for this purchase with the user again.

### Step 4: Run the checkout script in preview and execute modes
1. Before starting, tell the user: "I’m starting the checkout automation now. I’ll begin in preview mode so I can autofill the checkout information without submitting the order."

2. Use the user-provided `entry-url` and the generated profile JSON file to run `checkout_playwright_handoff.py` in `preview` mode first, so you can confirm that the automation flow runs correctly and fills the required information.

```bash
python3 scripts/checkout_playwright_handoff.py \
  --entry-url "https://shophomeplace.myshopify.com/products/gift-card" \
  --mode preview \
  --secrets-path /data/workspace/.clawdbot/credentials/real_card.json \
  --resident-id-number "<required only when the merchant asks for it>" \
  --out-dir artifacts/checkout-preview \
  --headless \
  --record-video
```

3. If `preview` succeeds, send the screenshots and video to the user so they can review the automated checkout preview, and tell the user: "The automated checkout preview completed successfully, and the checkout information has been filled in. Please confirm that the delivery information is correct. If everything looks right, we can proceed with the final checkout step."

   Do not delete screenshots, traces, videos, or result JSON files under the local `artifacts/` directory by default. They are part of the audit trail and manual handoff record for checkout continuation.
   Only clean up local artifacts if the user explicitly asks for cleanup, or explicitly asks to delete sensitive files among them.

4. If the page contains a required checkbox for legal consent, privacy authorization, cross-border transfer, or other local regulatory requirements, do not check it on the user's behalf by default. First ask for the user's explicit consent in natural language. Only after the user clearly agrees should you add `--confirm-legal-consent` to the command.

5. If the user confirms that the delivery information is correct, run `checkout_playwright_handoff.py` in `execute` mode for the final checkout attempt. When using the standard unified profile that includes `delivery`, you should usually add `--confirm-delivery`; otherwise the script will refuse to run.
```bash
python3 scripts/checkout_playwright_handoff.py \
  --entry-url "https://gracie-designs.myshopify.com/products/gift-card" \
  --mode execute \
  --secrets-path "$HOME/.clawdbot/credentials/real_card.json" \
  --confirm-delivery \
  --confirm-legal-consent \
  --order-label "Gracie Designs Gift Card" \
  --order-currency USD
```

6. When the flow is unsupported or blocked, speak to the user in plain language.
   Do not answer with internal labels like `unsupported_provider` or `needs_manual_verification` only.
   If the checkout page is already open but automation still cannot safely continue, return the live product or checkout link immediately so the user can finish manually.
   Preferred wording:

```text
This merchant's current checkout flow is not yet within the validated automation scope of FluxA Agentic Checkout, so you will need to complete this purchase manually for now.
You can open the link below to continue the purchase:
<product-or-checkout-url>
```

7. Query the local paid-order ledger when needed.

```bash
python3 scripts/order_manager.py get --order-id CHK-1774977424895
python3 scripts/order_manager.py list --limit 20
python3 scripts/order_manager.py search --keyword "gift card"
python3 scripts/order_manager.py summary --days 30
```

8. Judge the next action from the JSON result, not from transient browser logs.
   Use `phase`, `provider`, `handoffRequired`, `handoffReason`, `contactFilled`, `deliveryFilled`, `billingIdentityFilled`, `postalFilled`, `paymentFieldVerification`, `legalConsentChecked`, and `filledCheckoutScreenshot`.
   If `handoffRequired=true`, stop automation and pass the active context to a human operator instead of inventing a fallback flow.

## Product Capabilities

| Capability | What it does now | When to use |
|------------|------------------|-------------|
| **Checkout Routing** | Accepts entry links and chooses the validated checkout route automatically | The caller already has a product, cart, or checkout URL |
| **Deterministic Filling** | Fills supported contact, delivery, billing identity, postal, and card fields on currently supported surfaces | The caller wants a stable, replayable automation path instead of free-form browsing |
| **Profile Setup** | Collects payment, delivery, and billing details into one reusable JSON credential file | The caller needs a repeatable setup flow before preview or execute |
| **Operator Handoff** | Emits structured handoff states instead of faking unsupported automation | Verification or merchant-specific steps block safe continuation |
| **Artifacts & State** | Saves JSON results, screenshots, traces, and optional video for inspection | The caller needs auditability, debugging, or clean manual continuation |
| **Order Management** | Stores successful paid checkout records inside the skill and exposes lookup commands | The caller needs a local ledger of paid orders after execute-mode success |

## Current Implementation Status

Use this section as the product truth. Do not claim support beyond it.

### Implemented now

1. **Standard storefront checkout navigation via Playwright**
   - Accepts product, collection, cart, or direct checkout pages on currently validated storefront routes
   - Navigates into checkout with deterministic actions
   - Fills contact and delivery fields when the checkout presents a shipping step
   - Supports `preview` and `execute`
2. **Hosted checkout field filling**
   - Detects direct hosted checkout pages and common embedded payment surfaces on currently validated routes
   - Fills visible identity, postal, and card fields
3. **Checkout profile loading**
   - Reads a single JSON file that contains `payment`, `delivery`, and `billing`
   - Remains backward-compatible with the older card-only JSON shape
4. **Structured outcome reporting**
   - Returns `phase`, `provider`, `handoffRequired`, `handoffReason`, and completion hints
   - Produces screenshots, traces, and JSON payloads suitable for a human or downstream agent
5. **Local paid-order ledger**
   - Successful `execute` runs can be recorded automatically into `data/paid_orders/`
   - `scripts/order_manager.py` supports `get`, `list`, `search`, and `summary`

### Implemented but requires human intervention in some states

These are expected handoff points, not bugs to paper over:

- CAPTCHA
- Cloudflare or anti-bot verification
- OTP / SMS / email verification
- Issuer 3DS authentication
- Merchant login walls
- Unsupported checkout widgets
- Merchant-specific post-submit review states

When these appear, stop and return the handoff state. Do not improvise a best-effort checkout flow.

### Not implemented or not claimed

- Universal support for all ecommerce platforms
- Arbitrary pre-checkout storefront traversal on every merchant
- Full support for heavily customized storefront themes
- CAPTCHA / OTP / 3DS bypass
- First-class adapters for Adyen, Braintree, and other providers not yet validated

## Output Contract

This skill is an execution and handoff product, not a recommendation report.

- If the route is supported and the run reaches the expected checkpoint, return the structured JSON result and the key artifact paths
- Do not delete local `artifacts/` by default; keep them available for user review, debugging, and manual continuation unless the user explicitly asks for cleanup
- If the route is blocked by verification or unsupported flow, return the handoff state clearly
- If the provider is outside the validated surface list, report that explicitly instead of claiming partial support
- If a delivery step is present, surface whether it was filled via `deliveryFilled`
- If the payment iframe visually masks values in screenshots, rely on `paymentFieldVerification` for card-field confirmation instead of claiming the fields are empty from the screenshot alone
- If the page shows a required legal/privacy consent checkbox, only auto-check it after the user explicitly agrees; surface the result via `legalConsentChecked`
- If `execute` reaches success and order recording is enabled, include `orderRecorded`, `orderId`, `orderPath`, and `orderStorageDir` in the final result
- If checkout succeeds but ledger persistence fails, surface `orderRecordError` without pretending the order was recorded
- Preview runs and non-success execute runs should not be recorded as paid orders

## References

- Current implementation scope:
  Read [references/current-capabilities.md](references/current-capabilities.md) before claiming support for a merchant or payment surface.
- Planned expansion:
  Read [references/roadmap.md](references/roadmap.md) when the user asks what is not implemented yet or what the team plans to ship next.

## Scripts

- `scripts/checkout_playwright_handoff.py`
  General checkout entrypoint with automatic route selection, structured handoff signals, and optional paid-order recording on execute success.
- `scripts/demo_execute_headed.py`
  One-command execute-mode demo wrapper with `--headed`, default demo URL, and visible browser hold-open time.
- `scripts/setup_checkout_profile.py`
  Interactive setup flow that collects payment, delivery, and billing details into one reusable JSON profile.
- `scripts/order_manager.py`
  Local paid-order query CLI for `get`, `list`, `search`, and `summary`.
- `scripts/order_store.py`
  Filesystem-backed order ledger used by the checkout skill.
- `scripts/shopify/`
  Bundled Playwright helpers for the currently validated checkout navigation routes and shared payment adapters.

## Environment setup

```bash
python3 scripts/setup_checkout_skill.py \
  --profile-output "$HOME/.clawdbot/credentials/real_card.json"
```

This one command prepares the Python runtime, installs Playwright Chromium, and then starts the interactive profile setup flow.

Default checkout runs now use a `600` second timeout so slow stores are less likely to be cut off mid-run.
When automation is blocked, reply to the user in a customer-service tone and either ask for the missing checkout information or immediately return the live checkout link for manual completion.

Standard local setup:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python -m playwright install chromium
```

Docker / OpenClaw setup:

```bash
apt-get update && apt-get install -y python3-pip python3-venv xauth
python3 -m pip install --break-system-packages playwright python-dotenv socksio
python3 -m playwright install --with-deps chromium
python3 -m playwright install chromium
```

Use the final `python3 -m playwright install chromium` in the same user context that will run the checkout command. If the container installs dependencies as `root` but OpenClaw executes as `node`, run that final install again as `node` so the browser cache exists under the runtime user's home directory.

## Collect the user's shipping information

Run the update script:
```bash
python3 scripts/setup_checkout_profile.py \
  --output "$HOME/.clawdbot/credentials/real_card.json"
```

Before updating it, first check whether this file already contains the user's collected information. The generated profile JSON uses this shape:

```json
{
  "payment": {
    "email": "buyer@example.com",
    "card_number": "4242424242424242",
    "exp": "12/34",
    "cvc": "123",
    "postal": "10001",
    "country": "United States",
    "name": "Cardholder Name"
  },
  "delivery": {
    "name": "Test Buyer",
    "first_name": "Test",
    "last_name": "Buyer",
    "address1": "123 Main St",
    "address1_ascii": "123 Main St",
    "address2": "Apt 2",
    "city": "New York",
    "city_ascii": "New York",
    "state": "NY",
    "state_ascii": "NY",
    "postal": "10001",
    "country": "United States",
    "phone": "2125550100"
  },
  "billing": {
    "same_as_delivery": false,
    "name": "Billing Person",
    "first_name": "Billing",
    "last_name": "Person",
    "address1": "456 Billing Ave",
    "address1_ascii": "456 Billing Ave",
    "address2": "Suite 5",
    "city": "New York",
    "city_ascii": "New York",
    "state": "NY",
    "state_ascii": "NY",
    "postal": "10001",
    "country": "United States",
    "phone": "2125550101"
  },
  "additional_information": {
    "resident_id_number": "540531196711167179"
  }
}
```

`additional_information.resident_id_number` is optional. When the merchant requires it only for one checkout, you can also pass it at runtime with `--resident-id-number` or `RESIDENT_ID_NUMBER`.

If it does not, ask the user for the relevant information and then run the script above to update it.
For addresses in China, if the user does not separately provide an English or Latin version, the skill should first generate `address1_ascii`, `city_ascii`, and `state_ascii` automatically. If the postal code is missing, it should first fall back to a province-level generic postal code before continuing the checkout. Only if the page still rejects the address after automatic inference should the skill go back to the user and ask for more precise information.
If any of these are missing, ask the user directly in plain language:

- Checkout email
- Delivery recipient name
- Delivery country or region
- Delivery province or state
- Delivery city
- Delivery address line 1
- Delivery phone number
- Delivery postal code when the merchant requires it
- If the merchant checkout rejects native script: an English / Latin version of the delivery address, city, and province
- Whether billing address is the same as delivery
- If billing is different: billing name, billing country or region, billing province or state, billing city, billing address line 1, billing phone, billing postal code
- If billing is different and the merchant checkout rejects native script: an English / Latin version of the billing address, city, and province
