# Shopify checkout service

The internal API supports product discovery and anonymous cart and quote creation through Shop MCP. It also supports checkout previews and approved test payments in fresh E2B Chromium sessions. For test submission, the caller owns building the cart, presenting the items and total to the buyer, and obtaining approval.

The service prepares guest checkout with native Shopify card fields on configured test stores, including custom checkout domains. It supports a separate billing address and Shopify's one-page and three-page layouts. The purchase approval covers the ordinary order review within the same checkout. Merchant sign-in, express wallets, third-party payment forms, and interactive verification are outside the automated flow. The service uses synthetic identities and documented gateway test cards.

## API

Send `POST /checkouts/{approval_id}` with the service bearer token and an empty body. The purchase coordinator supplies the approval UUID. It must bind the exact checkout URL and cart the buyer approved, the final total and currency, the approved delivery options and card reference, and an expiration. Use a fresh checkout whenever the buyer changes the cart or delivery terms. The service accepts Shopify's `/cart/c/…` link or an open `/checkouts/…` link. It resolves a cart link inside E2B before claiming the canonical checkout and sending payment data. By default the two URLs use the same host. Set the test store's `checkout_host` if they use different trusted hosts. [Storefront Cart API](https://shopify.dev/docs/storefronts/headless/building-with-the-storefront-api/cart/manage#step-7-retrieve-a-checkout-url)

The calling service wires three synchronous adapters into `checkout_service.api.create_app`. Treat them as read-only. The service gives approval lookup ten seconds and gives profile plus card lookup a separate ten seconds. Set network timeouts in the adapters so a failed request releases its worker thread.

| Adapter | Returns |
| --- | --- |
| `authorize(approval_id)` | `CheckoutGrant(checkout_url, items, total_minor_units, currency, expires_at, shipping_options)` for an approved purchase. Pass `items` as a map of variant IDs to integer quantities, `total_minor_units` as an integer such as `1234` for USD 12.34, `currency` as an uppercase code, and expiration as Unix seconds. For each shipping group include its ID as a key in `shipping_options` and a value with `selected_option_id` and, when applicable, `selected_option_details`. Use an empty map for digital orders. |
| `credentials(approval_id)` | Synthetic `email` at `example.com` and approved `delivery` and `billing` address objects. Use ISO 3166-1 alpha-2 country codes, Shopify region codes where applicable, and E.164 phone numbers. Supply `address2` or `company` when the merchant requires that information. Set `billing.same_as_delivery` to `true` to use the delivery address. To use a different address, supply its approved fields in `billing` with `same_as_delivery: false`. Supply a `storefront_password` for a password-protected test store. |
| `card(approval_id)` | Gateway test-card fields `card_number`, `exp` in MM/YY format, `cvc`, and `name`. Optional `postal` and `country` come from the approved billing profile when available. |

| Response | Meaning |
| --- | --- |
| `submitted` | The same checkout returned a completed Shopify receipt with the approved total and currency, plus the returned `order_id`. Use the merchant order record to establish payment status. |
| `payment_failed` | The checkout displayed a card decline. |
| `manual_verification` | The checkout required verification or unapproved consent. The automated attempt ended before submission. |
| `payment_method_unavailable` | The checkout did not offer Shopify-hosted guest card entry. |
| `reconciliation_required` | Payment may have been submitted. Poll the existing approval with GET. A matching sandbox receipt or signed Shopify order event can resolve it. |
| `cart_mismatch`, `total_mismatch`, `checkout_not_ready`, `checkout_unavailable`, `identity_incomplete`, `unsupported_checkout`, `payment_fields_incomplete`, `approval_expired`, `test_data_required` | The checkout failed a pre-submit condition. |
| `browser_unavailable`, `credentials_unavailable` | A prerequisite failed before any payment input reached the worker. Retry with the same approval while it is valid. |
| HTTP 202 with `processing` | The attempt still holds the submission claim. Call again with the same approval UUID to read the result. |
| HTTP 409 | Another approval already claimed the Shopify checkout token. |

Keep the SQLite database on persistent local storage for this single-server service. The API records an attempt before looking up prerequisites. Before sending payment inputs, it claims the canonical checkout and records the sandbox ID in the same SQLite transaction. The worker writes a sanitized receipt inside the sandbox. The API commits the result to SQLite before closing the sandbox, and GET can recover the receipt while the sandbox still exists. The sandbox has private ingress, exact host egress rules and a 180-second kill deadline. The database stores checkout token digests, approved cart and amount, sandbox IDs and sanitized results. Checkout URLs and card data pass through ephemeral sandbox stdin.

If E2B's sandbox creation response times out, the service retries creation once with the same E2B idempotency key. The startup window is at most 45 seconds and ends earlier if the purchase approval expires. If startup still fails, the attempt returns `browser_unavailable` and can be retried with the same approval. A payment with an unknown result still requires receipt recovery through the original approval. [E2B idempotent sandbox creation](https://docs.e2b.dev/sandbox/idempotency)

For recovery after the sandbox expires, subscribe the test store's Shopify app to `orders/create` using API version `2026-10`. Send HTTPS deliveries to `POST /webhooks/shopify/orders` and configure `create_app(order_webhooks={shop_domain: (checkout_host, app_client_secret)})`. The service verifies the raw-body HMAC and binds the test order by checkout token, configured host, items, currency and original presentment total. Duplicate deliveries leave the stored receipt intact. If Shopify cannot supply a matching event and the sandbox is gone, the attempt remains `reconciliation_required`. [Shopify webhook verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries) · [Orders webhook payload](https://shopify.dev/docs/api/webhooks/latest)

## Discover products and create a quote with the SDK

The Node.js and TypeScript SDK lives in `packages/fluxa-shopify-checkout`. It uses the checkout service bearer token. Keep the client in server-side code.

Call `searchCatalog({ query, country, currency, limit, cursor })` or `POST /catalog/search` to discover Shopify products. Supply uppercase country and currency codes. Use the returned cursor unchanged for the next page with the same query and market. Search sends the query and market to Shopify and requires no buyer credentials. Availability and price can change. [Shop MCP search](https://shop.dev/docs/search)

| SDK method | Private API | Input |
| --- | --- | --- |
| `createCart` | `POST /native/carts` | The exact `seller.domain`, the selected variants and quantities, buyer country and currency codes, and an idempotency UUID. Use `merchant`, `items: [{ variantId, quantity }]`, `country`, `currency`, and `idempotencyKey` in the SDK. |
| `createCheckoutQuote` | `POST /native/checkout-quotes` | The same merchant, the `cart_ref` returned by cart creation, and a second idempotency UUID. Use `merchant`, `cartRef`, and `idempotencyKey` in the SDK. |
| `getCheckoutQuote` | `POST /native/checkout-quotes/read` | The same merchant and the `checkout_ref` returned by quote creation. Use `merchant` and `checkoutRef` in the SDK. |

Use each variant ID exactly as returned by Shopify, including attribution parameters. A cart and its checkout belong to one merchant. HTTP request bodies use `variant_id`, `idempotency_key`, `cart_ref`, and `checkout_ref` for the corresponding SDK fields. Create a cart or checkout when the shopper requests one. Use a stable UUID per create operation and reuse it only with the identical request. A transport failure can leave the result unknown. The service makes one upstream call per request. [Shop MCP tool reference](https://shop.dev/docs/tools) · [Shop MCP retries](https://shop.dev/docs/errors)

Use the returned items and Shopify’s labeled totals in their original order. Amounts are in minor units of the returned `currency`. Show Shopify’s warnings and policy links. Quotes report Shopify’s checkout `status` and `amount_provisional`. An incomplete checkout or one requiring buyer input can still show a total that excludes delivery or tax. Use the latest `continue_url` for buyer review and completion. Shopify may return a new URL for the same checkout. [Shop MCP carts and checkout](https://shop.dev/docs/checkout)

Keep the service token, `cart_ref` and `checkout_ref` in trusted server code. Keep the references and `continue_url` out of logs and analytics. Share the unchanged `continue_url` only with the shopper it belongs to. The native quote routes use the hosted Shop MCP contract pinned to `2026-07-28`. The E2B test submission API uses a separately approved test-store checkout. [Shop MCP quickstart](https://shop.dev/docs/quickstart)

## Preview with the SDK

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

Preview totals are snapshots. Shipping, tax, market or buyer details can change them. `preview_ready` includes a WebMCP quote, while `checkout_reached` reports what the browser could read on the page. Use `submitApprovedTest(approvalId)` with a separately approved test-store checkout URL. If its HTTP response is lost, use `getAttempt(approvalId)` with the same UUID. If the service has no record yet, reuse the same UUID on POST so a concurrent request and retry share the same claim. For `processing` or `reconciliation_required`, keep checking the existing attempt. [Shopify Checkout WebMCP](https://shopify.dev/docs/agents/carts-and-checkout/checkout-webmcp)

## Build and run the hosted acceptance case

Run from the skill directory with Python 3.12. Supply the E2B project key through the service environment.

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-service.txt
export PYTHONPATH="$PWD/scripts"
python -m checkout_service.template TEAM/fluxa-shopify-checkout
```

Use the returned template build reference as `CHECKOUT_E2B_TEMPLATE`. The API checks the template's browser source digest before starting a worker. For the smoke app, configure an owned Shopify development store or a dedicated Shopify Payments test store. Prepare a test product and obtain a checkout URL after fixing the cart, delivery terms, and final quote. [Shopify development stores](https://shopify.dev/docs/apps/build/stores/development-stores) · [Shopify Payments test mode](https://help.shopify.com/en/manual/payments/shopify-payments/testing-shopify-payments)

| Environment variable | Value |
| --- | --- |
| `CHECKOUT_E2B_TEMPLATE` | Exact `TEAM/fluxa-shopify-checkout:<build-UUID>` reference from the build |
| `CHECKOUT_SERVICE_TOKEN` | Private bearer token, 32 or more characters |
| `CHECKOUT_ATTEMPTS_DB` | Absolute path on persistent storage |
| `CHECKOUT_PREVIEW_STORES` | JSON object of configured preview stores, with their Shopify permalink endpoints and supplemental hosts |
| `CHECKOUT_APPROVAL_ID` | Stable UUID for this approved attempt |
| `CHECKOUT_TEST_URL`, `CHECKOUT_TEST_ITEMS`, `CHECKOUT_TEST_TOTAL_MINOR_UNITS`, `CHECKOUT_TEST_CURRENCY`, `CHECKOUT_TEST_EXPIRES_AT` | Checkout link, variant-to-quantity JSON map, exact amount in minor units, currency and expiry authorized for this attempt |
| `CHECKOUT_TEST_DELIVERY` | Synthetic address JSON with names, street, and an ISO country code in `country`. Supply `city`, `state`, `postal`, and an E.164 `phone` as required by the checkout. |
| `CHECKOUT_TEST_SHIPPING_OPTIONS` | JSON mapping of approved shipping group IDs to selected option IDs and details. Defaults to `{}` for digital orders. Use `{}` for delivery on digital orders as well. |
| `CHECKOUT_TEST_BILLING` | Optional synthetic address JSON with `same_as_delivery: false` and the approved billing address fields. The default is `{"same_as_delivery": true}`. |
| `CHECKOUT_TEST_GATEWAY`, `CHECKOUT_TEST_CARD` | `shopify_test_gateway` with `1` for success or `2` for decline, or `shopify_payments` with the documented success or generic decline test number |
| `CHECKOUT_TEST_STOREFRONT_PASSWORD` | Storefront password for a protected test store |
| `CHECKOUT_TEST_NETWORK_HOSTS` | Space-delimited exact supplemental hostnames for the test checkout. Defaults to `cdn.shopify.com`; the merchant checkout host and Shopify card origin are included automatically. |
| `CHECKOUT_TEST_CHECKOUT_HOST` | Optional trusted checkout hostname if the cart link redirects to a different host. |
| `CHECKOUT_TEST_WEBHOOK_SHOP`, `CHECKOUT_TEST_WEBHOOK_SECRET` | The Shopify permanent `myshopify.com` domain and app client secret for signed test-order recovery. Supply both to enable recovery after sandbox expiry. |

```bash
uvicorn checkout_service.smoke:app --factory --host 127.0.0.1 --port 8080
curl -fsS -X POST -H "Authorization: Bearer $CHECKOUT_SERVICE_TOKEN" \
  "http://127.0.0.1:8080/checkouts/$CHECKOUT_APPROVAL_ID"
```

| Acceptance check | Evidence |
| --- | --- |
| Preview | Use the SDK and pinned template. Confirm `preview_ready` and the requested variant, quantity and currency. Confirm a template from different source fails before worker launch. |
| Approved checkout | Record the E2B template build and returned Shopify order ID. In Shopify Admin, verify one order with test mode, the approved product and quantity, the expected total and currency, and the expected financial status. |
| Transport or prerequisite failure | Retry the same approval after a card-vault timeout. Interrupt the result stream after dispatch, restart the HTTP service, and verify GET returns the same order from the sandbox receipt or a signed Shopify order event. |
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

The worker uses Shopify Checkout WebMCP to update guest contact, delivery, and billing and to advance information and shipping steps when Shopify exposes them. It binds each transition to the same checkout token and Shopify checkout ID. Market URL changes can preserve this identity. The service preserves existing discounts, selects only approved delivery options, verifies both addresses independently, and checks the selected native checkout controls. It reads the same checkout back if an update reply fails, since Shopify may already have applied the change. The address comparison allows formatting differences and a Shopify-derived region when the approved address omitted one. A supplied region, street, unit, or postal identifier must match. Shopper-supplied required fields and eligible payment methods depend on the merchant.

For a direct-card checkout, the worker selects the native card method when needed. It requires the approved cart, final amount, addresses, and payment controls before and after entering card details. If the confirmed native control opens order review, the worker uses that control once. At the same checkout's review URL it rechecks the checkout ID, cart, addresses, selected delivery options, amount, approval expiry, and final native payment control. An interactive challenge or a changed approval term stops final submission. The worker uses the final payment control once and checks the merchant's order receipt. An unknown outcome requires reconciliation. [Shopify Checkout WebMCP 2026-08-25](https://shopify.dev/docs/agents/carts-and-checkout/checkout-webmcp), [Shopify address formats](https://github.com/Shopify/worldwide/tree/v2.0.1/data/regions), [Shopify confirmation step](https://help.shopify.com/en/manual/checkout-settings/order-processing#require-a-confirmation-step-before-checking-out).

E2B's maintained [in-sandbox Playwright example](https://github.com/e2b-dev/e2b-cookbook/tree/main/examples/playwright-in-e2b) establishes the runtime pattern. This service uses the MIT-licensed E2B Python SDK and the Apache-2.0 Playwright Python image pinned by digest. The template packages the existing Shopify adapter and avoids installing browsers during a checkout attempt. Exact E2B build references pin the worker used in each environment. [E2B template build references](https://docs.e2b.dev/template/tags#referencing-a-specific-build), [E2B egress rules](https://docs.e2b.dev/network/internet-access), [Playwright Python images](https://playwright.dev/python/docs/docker).

SQLite transactions provide checkout ownership and receipt storage for a single service host. E2B reconnect covers an interrupted response while the sandbox remains active. Shopify's signed order webhook covers recovery after it expires and lets the service correlate the receipt without retaining the checkout token or requesting Shopify Admin API access for every check. The pinned public-domain `iso4217` data supplies the minor-unit exponent for the webhook's decimal presentment amount. [SQLite transactions](https://www.sqlite.org/lang_transaction.html) · [Shopify webhook verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries) · [ISO 4217 dependency](https://pypi.org/project/iso4217/1.16.20260101/)

Native Playwright alone would reuse the adapter but would leave browser isolation, cleanup, and egress with the FluxA server. E2B's Kernel example introduces a second browser service and CDP integration. Shopify Checkout MCP lets eligible agents complete checkout with a trusted UI credential and gives general-access callers a buyer handoff, so it requires a different integration and eligibility contract for server-side submission. [E2B remote browser integration](https://docs.e2b.dev/use-cases/remote-browser), [Shopify Checkout MCP](https://shopify.dev/docs/agents/carts-and-checkout/checkout-mcp).
