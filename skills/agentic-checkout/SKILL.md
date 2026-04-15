---
name: fluxa agentic checkout
description: FluxA Agentic Checkout is a general-purpose checkout automation and human handoff runbook. Use it when an AI agent needs to open a product or checkout link, attempt deterministic Playwright checkout on currently supported surfaces, autofill contact, delivery, card, and billing fields, and stop in a clean handoff state when CAPTCHA, Cloudflare, OTP, 3DS, unsupported merchants, or store-specific flows require a human operator to finish the purchase.
---

# FluxA Agentic Checkout


**Skill version: 0.4.0** | **Product surface: deterministic checkout automation + explicit human handoff**

## Overview

Use this skill as the release-grade operator runbook for checkout automation. It accepts arbitrary entry links, attempts the currently implemented automation routes, and produces structured results that tell the next agent or human whether the checkout is ready, partially filled, blocked by verification, or requires manual takeover.

## How to do checkout for users

### Step1: 检查url是否支持自动化checkout

1. 用户有没有给定具体的商品url，没有的话需要让用户提供具体需要购买的商品链接。
2. 给定的链接是否在目前支持的自动化范围内。当前版本主要支持Shopify平台的标准结账流程，以及Stripe结账页面的字段自动填写。如果链接指向的商户或结账流程不在支持范围内，技能会明确告知用户需要手动完成购买，并提供直接打开链接的建议。
3. 如果链接在支持范围内，和用户反馈：这个商品支持自动化结账，我们可以帮你自动填写结账信息并引导你完成购买。我现在开始帮你自动化结账。

### Step2: 检查checkout skill的执行环境
1. 检查环境：技能需要在支持Playwright的环境中运行，并且需要安装Chromium浏览器。你需要检查 python-dotenv、socksio、playwright等是否已经安装，如果没有安装，需要先安装这些依赖。安装步骤：查看Environment setup这个章节。
2. 安装环境前，和用户反馈：为了完成自动化结账，我们需要安装一些必要的工具和浏览器。这个过程可能需要几分钟时间，请耐心等待。我现在开始安装环境。

### Step3: 收集用户的结账信息并生成profile
1. 查阅“收集用户邮寄地址”章节，看看用户是否已经有一个包含支付、配送和账单信息的JSON文件。如果没有，我们需要引导用户提供这些信息。
2. 如果信息已存在，和用户再确认一遍本次购物的收货地址

### Step4: 运行checkout脚本进行预览和执行
1. 开始前，和用户反馈：现在开始自动化结账，我会先进行预览模式，帮你自动填写结账信息，但不会提交订单。

2. 使用用户提供的entry-url和生成的profile JSON文件，运行checkout_playwright_handoff.py脚本，选择preview模式先进行预览，确认自动化流程能够正确执行并填写信息。

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

3.如果preview执行成功，把截图和视频，发给用户看一下自动化结账的预览效果，和用户反馈：自动化结账已经成功预览，结账信息已经填写好了。请确认一下配送信息是否正确，如果正确的话，我们就可以继续执行最终的结账操作了。 

   默认不要删除本地 `artifacts/` 里的截图、trace、视频和结果 JSON。它们是 checkout handoff 的审计和人工接管依据。
   只有用户明确要求清理本地产物，或者明确要求删除其中的敏感文件时，才可以执行清理。

4. 如果页面出现法律同意、隐私授权、跨境传输或本地法规相关的必选 checkbox，不要默认替用户勾选。先用自然语言征求用户明确同意；只有用户明确答应后，才在运行命令时加上 `--confirm-legal-consent`。

5. 如果用户确认配送信息正确，运行checkout_playwright_handoff.py脚本，选择execute模式进行最终的结账执行。只要使用标准的统一 profile（含 `delivery`），通常都应加上 `--confirm-delivery`；否则脚本会拒绝执行。
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
因为目前 FluxA Agentic Checkout 仅支持特定的 Shopify 结账类型，这个商品暂时需要你自己手动 checkout。
你可以直接打开下面的链接继续购买：
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

1. **Shopify standard checkout navigation via Playwright**
   - Accepts Shopify product, collection, cart, or direct checkout pages
   - Navigates into standard Shopify checkout with deterministic actions
   - Fills contact and delivery fields when the checkout presents a shipping step
   - Supports `preview` and `execute`
2. **Stripe checkout field filling**
   - Detects direct Stripe-hosted checkout pages and common embedded Stripe checkout surfaces
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
- Full support for heavily customized Shopify themes
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
  Bundled Playwright helpers for the currently implemented Shopify navigation route and shared payment adapters.

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

## 收集用户邮寄地址

更新脚本如下
```bash
python3 scripts/setup_checkout_profile.py \
  --output "$HOME/.clawdbot/credentials/real_card.json"
```

更新前，先看看这个文件，有没有已经收集好的用户信息，The generated profile JSON uses this shape:

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

如果没有，通过让用户提供相关信息，然后运行上面脚本更新。
对于中国地址，如果用户没有额外提供英文 / Latin 版本，skill 应先自动生成 `address1_ascii`、`city_ascii`、`state_ascii`，并在缺失邮编时先回退到省级通用邮编，再继续 checkout。只有自动推断后页面仍拒绝，才回头向用户补问更精确的信息。
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
