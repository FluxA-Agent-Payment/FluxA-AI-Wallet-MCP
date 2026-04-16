# Current Capabilities

Use this file when you need an exact statement of what is implemented today.

## Implemented now

### 1. Validated storefront checkout pages via Playwright

Current scope:

- Accept supported entry links such as a product page, collection page, cart page, or direct checkout page on currently validated storefront routes.
- Navigate validated storefront pages to checkout using deterministic Playwright actions.
- Fill guest contact fields, delivery/shipping fields when present, billing identity fields, and native PCI card fields on supported routes.
- Support `preview` and `execute` modes with a `MAX_TOTAL_USD` safety guard.
- Emit screenshots, traces, and structured JSON results.

Profile setup support:

- Accept a single JSON credential file that bundles `payment`, `delivery`, and `billing`.
- Keep backward compatibility with the earlier card-only JSON shape.

Implementation note:

- The currently validated storefront route is the standard Shopify checkout flow.

Current limits:

- Built for the currently validated storefront DOM patterns, not arbitrary heavily customized storefronts.
- If CAPTCHA, Cloudflare, login walls, or unsupported merchant widgets appear, the run should stop with handoff.

### 2. Hosted checkout field filling

Current scope:

- Detect direct hosted checkout pages and supported embedded checkout surfaces that are already open on the page.
- Fill card number, expiration, CVC, postal code, and visible identity fields.
- Handle common hosted-payment iframe layouts and embedded modal/page variants on validated routes.
- Support `preview` and `execute` modes, including submit attempts and post-submit outcome classification.

Implementation note:

- The currently validated hosted checkout adapter is Stripe.

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
