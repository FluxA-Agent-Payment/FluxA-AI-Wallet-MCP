# Current Capabilities

Use this file when you need an exact statement of what is implemented today.

## Implemented now

### 1. Shopify standard checkout pages via Playwright

Current scope:

- Accept a Shopify entry link such as a product page, collection page, cart page, or direct checkout page.
- Navigate standard Shopify storefront pages to checkout using deterministic Playwright actions.
- Fill guest contact fields, delivery/shipping fields when present, billing identity fields, and Shopify native PCI card fields.
- Support `preview` and `execute` modes with a `MAX_TOTAL_USD` safety guard.
- Emit screenshots, traces, and structured JSON results.

Profile setup support:

- Accept a single JSON credential file that bundles `payment`, `delivery`, and `billing`.
- Keep backward compatibility with the earlier card-only JSON shape.

Current limits:

- Built for standard Shopify DOM patterns, not arbitrary heavily customized storefronts.
- If CAPTCHA, Cloudflare, login walls, or unsupported merchant widgets appear, the run should stop with handoff.

### 2. Stripe checkout field filling

Current scope:

- Detect direct Stripe-hosted checkout pages and Stripe checkout surfaces that are already open on the page.
- Fill card number, expiration, CVC, postal code, and visible identity fields.
- Handle common Stripe iframe layouts and embedded modal/page variants.
- Support `preview` and `execute` modes, including submit attempts and post-submit outcome classification.

Current limits:

- This is a checkout-surface adapter, not a universal pre-checkout navigator for every Stripe-integrated storefront.
- If the merchant requires extra site-specific clicks before Stripe opens, that pre-checkout navigation may still need custom work.

### 3. Human handoff signaling

Current scope:

- Mark `handoffRequired=true` when manual verification, 3DS, or unsupported checkout surfaces block safe automation.
- Preserve enough JSON state and artifacts for a human operator to continue from the blocked point.

## What this skill does not claim today

- It does not claim universal support for every ecommerce platform.
- It does not bypass CAPTCHA, OTP, Cloudflare, or issuer verification.
- It does not promise that any random merchant page can be fully purchased end to end without platform-specific adapters.
