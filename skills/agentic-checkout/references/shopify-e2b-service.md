# Shopify checkout service

The internal API can open an anonymous Shopify checkout preview, or accept an approved checkout URL and submit one test payment in a fresh E2B Chromium session. For submission, the caller owns building the cart, presenting the items and total to the buyer, and obtaining approval.

The service prepares guest checkout with native Shopify card fields on configured test stores, including custom checkout domains. It supports a separate billing address and Shopify's one-page and three-page layouts. The purchase approval covers the ordinary order review within the same checkout. Merchant sign-in, express wallets, third-party payment forms, and interactive verification are outside the automated flow. The service uses synthetic identities and documented gateway test cards.

## API

Send `POST /checkouts/{approval_id}` with the service bearer token and an empty body. The purchase coordinator supplies the approval UUID. It must bind the exact checkout URL and cart the buyer approved, the final total and currency, the approved shipping details and card reference, and an expiration. Use a fresh checkout whenever the buyer changes the cart or delivery terms. Shopify provides checkout URLs through the [Storefront Cart API](https://shopify.dev/docs/storefronts/headless/building-with-the-storefront-api/cart/manage).

The calling service wires three synchronous adapters into `checkout_service.api.create_app`. Give each adapter a bounded network timeout.

| Adapter | Returns |
| --- | --- |
| `authorize(approval_id)` | `CheckoutGrant(checkout_url, items, total_minor_units, currency, expires_at)` for an approved purchase. Pass `items` as a map of variant IDs to integer quantities, `total_minor_units` as an integer such as `1234` for USD 12.34, `currency` as an uppercase code, and expiration as Unix seconds. |
| `credentials(approval_id)` | Synthetic `email` at `example.com` and approved `delivery` and `billing` address objects. Use ISO 3166-1 alpha-2 country codes, Shopify region codes where applicable, and E.164 phone numbers. Supply `address2` or `company` when the merchant requires that information. Set `billing.same_as_delivery` to `true` to use the delivery address. To use a different address, supply its approved fields in `billing` with `same_as_delivery: false`. Supply a `storefront_password` for a password-protected test store. |
| `card(approval_id)` | Gateway test-card fields `card_number`, `exp` in MM/YY format, `cvc`, and `name`. Optional `postal` and `country` come from the approved billing profile when available. |

| Response | Meaning |
| --- | --- |
| `submitted` | The same checkout returned a completed Shopify receipt with the approved total and currency, plus the returned `order_id`. Use the merchant order record to establish payment status. |
| `payment_failed` | The checkout displayed a card decline. |
| `manual_verification` | The checkout required verification or unapproved consent. The automated attempt ended before submission. |
| `payment_method_unavailable` | The checkout did not offer Shopify-hosted guest card entry. |
| `reconciliation_required` | The service could not establish the outcome. Check Shopify for an order before starting a new checkout. |
| `cart_mismatch`, `total_mismatch`, `checkout_not_ready`, `checkout_unavailable`, `identity_incomplete`, `unsupported_checkout`, `payment_fields_incomplete`, `approval_expired`, `test_data_required` | The checkout failed a pre-submit condition. |
| `browser_unavailable`, `credentials_unavailable` | A prerequisite failed before the payment worker could run. |
| HTTP 202 with `processing` | The attempt still holds the submission claim. Call again with the same approval UUID to read the result. |
| HTTP 409 | Another approval already claimed the Shopify checkout token. |

Keep the SQLite database on persistent local storage for this single-server service. It stores approval IDs, checkout token digests and sanitized results. A lost worker reply or an interrupted server leaves its submission claim in place. The sandbox uses private ingress, exact host egress rules and a kill deadline. It receives the checkout inputs through stdin. The API process retains its approval, credential, vault, and E2B service credentials.

## Preview with the SDK

The Node.js and TypeScript SDK lives in `packages/fluxa-shopify-checkout`. It uses the checkout service bearer token. Keep the client in server-side code.

```js
import { ShopifyCheckoutClient } from "./packages/fluxa-shopify-checkout/index.js";

const checkout = new ShopifyCheckoutClient({
  baseUrl: "http://127.0.0.1:8080",
  token: process.env.CHECKOUT_SERVICE_TOKEN,
});

const preview = await checkout.preview({
  merchant: "shop.example.com",
  variantId: "12345678901234",
  country: "CA",
  quantity: 1,
});
console.log(preview);
```

`preview` opens the store's advertised Shopify Cart and Checkout Permalink and reads checkout in a disposable browser. It creates an anonymous cart and stops at the checkout page. Pass the optional `country` to request Shopify's market and currency for a two-letter country code. Configure `CHECKOUT_PREVIEW_STORES` as a JSON object keyed by exact merchant hostname. Each entry has the store's advertised `permalink_endpoint` and optional `network_hosts` for checkout assets. With preview stores configured, the smoke app can start with the common service environment and no `CHECKOUT_TEST_URL`. This mode disables order submission. [Shopify Cart and Checkout Permalinks](https://shopify.dev/docs/agents/carts-and-checkout/permalinks).

| Preview status | Evidence |
| --- | --- |
| `preview_ready` | Shopify WebMCP returned the requested variant and quantity, plus the current total and currency in minor units. |
| `checkout_reached` | The worker read the checkout page. The result contains any visible line titles, quantities, and total it could read, plus the status of the WebMCP read. |
| `cart_mismatch` | Shopify reported a variant or quantity different from the request. |

Preview totals are snapshots. Shipping, tax, market or buyer details can change them. A preview provides no approval to place an order. `getAttempt(approvalId)` reads a saved attempt with HTTP GET. `submitApprovedTest(approvalId)` applies only to separately approved test-store checkout URLs. If its HTTP response is lost, use `getAttempt` with the same approval UUID. A 404 can mean the submission request has yet to record its claim. A reconciliation status requires checking the merchant before starting another checkout. [Shopify Checkout WebMCP](https://shopify.dev/docs/agents/carts-and-checkout/checkout-webmcp).

## Build and run the hosted acceptance case

Run from the skill directory with Python 3.12. Supply the E2B project key through the service environment.

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-service.txt
export PYTHONPATH="$PWD/scripts"
python -m checkout_service.template TEAM/fluxa-shopify-checkout
```

Use the returned template build reference as `CHECKOUT_E2B_TEMPLATE`. For the included smoke app, configure an owned Shopify development store or a dedicated Shopify Payments test store. Prepare a shippable test product and obtain its hosted checkout URL after fixing the cart, delivery terms, and final quote. [Shopify development stores](https://shopify.dev/docs/apps/build/stores/development-stores), [Shopify Payments test mode](https://help.shopify.com/en/manual/payments/shopify-payments/testing-shopify-payments), [Shopify Test payment gateway](https://help.shopify.com/en/manual/checkout-settings/test-orders/payments-test-mode).

| Environment variable | Value |
| --- | --- |
| `CHECKOUT_E2B_TEMPLATE` | Exact `TEAM/fluxa-shopify-checkout:<build-UUID>` reference from the build |
| `CHECKOUT_SERVICE_TOKEN` | Private bearer token, 32 or more characters |
| `CHECKOUT_ATTEMPTS_DB` | Absolute path on persistent storage |
| `CHECKOUT_PREVIEW_STORES` | JSON object of configured preview stores, with their Shopify permalink endpoints and supplemental hosts |
| `CHECKOUT_APPROVAL_ID` | Stable UUID for this approved attempt |
| `CHECKOUT_TEST_URL`, `CHECKOUT_TEST_ITEMS`, `CHECKOUT_TEST_TOTAL_MINOR_UNITS`, `CHECKOUT_TEST_CURRENCY`, `CHECKOUT_TEST_EXPIRES_AT` | Checkout link, variant-to-quantity JSON map, exact amount in minor units, currency and expiry authorized for this attempt |
| `CHECKOUT_TEST_DELIVERY` | Synthetic address JSON with names, street, and an ISO country code in `country`. Supply `city`, `state`, `postal`, and an E.164 `phone` as required by the checkout. |
| `CHECKOUT_TEST_BILLING` | Optional synthetic address JSON with `same_as_delivery: false` and the approved billing address fields. The default is `{"same_as_delivery": true}`. |
| `CHECKOUT_TEST_GATEWAY`, `CHECKOUT_TEST_CARD` | `shopify_test_gateway` with `1` for success or `2` for decline, or `shopify_payments` with the documented success or generic decline test number |
| `CHECKOUT_TEST_STOREFRONT_PASSWORD` | Storefront password for a protected test store |
| `CHECKOUT_TEST_NETWORK_HOSTS` | Space-delimited exact supplemental hostnames for the test checkout. Defaults to `cdn.shopify.com`; the merchant checkout host and Shopify card origin are included automatically. |

```bash
uvicorn checkout_service.smoke:app --factory --host 127.0.0.1 --port 8080
curl -fsS -X POST -H "Authorization: Bearer $CHECKOUT_SERVICE_TOKEN" \
  "http://127.0.0.1:8080/checkouts/$CHECKOUT_APPROVAL_ID"
```

| Acceptance check | Evidence |
| --- | --- |
| Approved checkout | Record the E2B template build and returned Shopify order ID. In Shopify Admin, verify one order with test mode, the approved product and quantity, the expected total and currency, and the expected financial status. |
| Repricing | Approve an amount different from the final total. Confirm `total_mismatch` and no Shopify order. |
| Decline | Use a fresh checkout and the gateway's decline fixture. Confirm the service returns a decline or requests reconciliation according to Shopify's response, and the merchant has no paid order. |
| Duplicate request | Repeat the request with the original approval UUID. Confirm the same result and a single Shopify order. |

The local Chromium fixture exercises the same browser entry points. It checks that the native review control opens the review page and the approved checkout sends one final payment request. Review fixtures cover changed totals, checkout IDs, addresses, and interactive verification. Use the hosted acceptance case to establish the Shopify order record on a configured test store.

```bash
python -m pip install -r requirements-browser.txt
PLAYWRIGHT_BROWSERS_PATH="$PWD/.venv/browsers" python -m playwright install chromium --only-shell
PLAYWRIGHT_BROWSERS_PATH="$PWD/.venv/browsers" python -m unittest discover -s tests -p test_hosted_browser.py
```

## Implementation decision

The worker uses Shopify Checkout WebMCP to update guest contact, delivery, and billing and to advance information and shipping steps when Shopify exposes them. It binds each transition to the same checkout token and Shopify checkout ID. Market URL changes can preserve this identity. The service preserves existing discounts and selected delivery options, verifies both addresses independently, and checks the selected native checkout controls. The address comparison allows formatting differences and a Shopify-derived region when the approved address omitted one. A supplied region, street, unit, or postal identifier must match. Shopper-supplied required fields and eligible payment methods depend on the merchant.

For a direct-card checkout, the worker selects the native card method when needed. It requires the approved cart, final amount, addresses, and payment controls before and after entering card details. If the confirmed native control opens order review, the worker uses that control once. At the same checkout's review URL it rechecks the checkout ID, cart, addresses, selected delivery options, amount, approval expiry, and final native payment control. An interactive challenge or a changed approval term stops final submission. The worker uses the final payment control once and checks the merchant's order receipt. An unknown outcome requires reconciliation. [Shopify Checkout WebMCP 2026-08-25](https://shopify.dev/docs/agents/carts-and-checkout/checkout-webmcp), [Shopify address formats](https://github.com/Shopify/worldwide/tree/v2.0.1/data/regions), [Shopify confirmation step](https://help.shopify.com/en/manual/checkout-settings/order-processing#require-a-confirmation-step-before-checking-out).

E2B's maintained [in-sandbox Playwright example](https://github.com/e2b-dev/e2b-cookbook/tree/main/examples/playwright-in-e2b) establishes the runtime pattern. This service uses the MIT-licensed E2B Python SDK and the Apache-2.0 Playwright Python image pinned by digest. The template packages the existing Shopify adapter and avoids installing browsers during a checkout attempt. Exact E2B build references pin the worker used in each environment. [E2B template build references](https://docs.e2b.dev/template/tags#referencing-a-specific-build), [E2B egress rules](https://docs.e2b.dev/network/internet-access), [Playwright Python images](https://playwright.dev/python/docs/docker).

Native Playwright alone would reuse the adapter but would leave browser isolation, cleanup, and egress with the FluxA server. E2B's Kernel example introduces a second browser service and CDP integration. Shopify Checkout MCP lets eligible agents complete checkout with a trusted UI credential and gives general-access callers a buyer handoff, so it requires a different integration and eligibility contract for server-side submission. [E2B remote browser integration](https://docs.e2b.dev/use-cases/remote-browser), [Shopify Checkout MCP](https://shopify.dev/docs/agents/carts-and-checkout/checkout-mcp).
