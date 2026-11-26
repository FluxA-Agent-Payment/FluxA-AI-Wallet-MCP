# Shopify checkout service

## Agent checkout with a browser card

Use `POST /catalog/search` or `POST /catalog/lookup` to select a Shopify offer. Pass the offer's exact variant ID and seller domain to `POST /purchases` with `channel:"e2b_card"`, the requested country, and a caller-generated purchase UUID. The Demo selects this channel for public offers when `GET /purchase-merchants` advertises `card_checkout:true`. The test checkout stays available for configured test stores.

The service creates a Storefront cart on the merchant's Shopify domain. It verifies item identity, quantity, and the checkout origin before starting a restricted E2B Chromium session. The session prepares the native quotation and optional shipping selection. Show the buyer the final currency, amount, items, merchant, and delivery choice. Confirm the same purchase with `{quote_id}` after authorization. The service retrieves a browser card for the approved terms, enters it through Shopify's hosted card fields, verifies the same checkout again, and submits once. Read `GET /purchases/{id}` for the verified Shopify order receipt. An unresolved payment keeps its purchase ID so it can be reconciled without retrying the charge. [Shopify Storefront cartCreate](https://shopify.dev/docs/api/storefront/latest/mutations/cartCreate) · [Shopify Checkout WebMCP](https://shopify.dev/docs/agents/carts-and-checkout/checkout-webmcp)

### Buyer profile and Card Vault connection

For the packaged service, set `CHECKOUT_CARD_PROVIDER_ORIGIN` to the trusted HTTPS provider origin and `CHECKOUT_CARD_PROVIDER_TOKEN` to its service bearer credential. Configure the E2B template and environment as for test checkout. A service embedder can pass `create_app(purchase_card_provider=provider)`. The application using the private checkout API binds purchase IDs to authenticated buyers. The provider confirms that binding and any limit or merchant restrictions in the user's approval before returning card data.

| Provider endpoint | Contract |
| --- | --- |
| `POST /v1/checkout/profiles` | Request `{purchase_id,merchant,country}`. Respond with `{binding,profile}`. Echo the request in `binding`. Include a stable opaque `buyer_id`, email, and applicable delivery and billing fields in `profile`. |
| `POST /v1/checkout/card-claims` | Request the exact `purchase_id`, `quote_id`, `buyer_id`, merchant, checkout host, country, variant IDs and quantities, amount in minor units, currency, expiry and shipping options. The idempotency key is the quote UUID. Respond with `{binding,decision:"denied"}` or `{binding,decision:"approved",credential_type:"browser_card",card}`. Echo the exact request in `binding`. A browser card supplies `card_number`, `exp`, `cvc` and `name`. |

Keep the token and card data server-side. The provider must return a credential that Shopify's browser card fields can accept. A DAVV or another network cryptogram requires the processor integration that supports it. In browser checkout, merchant authentication or payment verification can require the buyer. Offer catalog checkout when the browser card provider is unavailable. [E2B network access](https://docs.e2b.dev/network/internet-access)

## Purchase from the Shop catalog

Use `POST /catalog/search` for keyword discovery or `POST /catalog/lookup` with `{url,country,currency}` for a storefront link. Both return Shop catalog offers. Select an available variant and preserve its exact `id` and `seller.domain`. The variant ID can include attribution parameters.

Create a purchase with `POST /purchases` using `{request_id,channel:"shop_catalog",merchant,items,country,currency}`. Send `items` as a map from exact variant GIDs to quantities. A purchase covers one merchant. The same request ID and terms can be retried. Change items while the cart is a draft. Request `POST /purchases/{id}/quote` with `{}` to open the merchant checkout. Reopening that purchase uses its existing Shopify checkout.

Show Shopify's totals, disclosures and policy links. The final currency may differ from the request. A quote with `amount_provisional:true` can change on the merchant's page. If the result requires `merchant_checkout`, give the buyer the original `continue_url` so they can finish with the merchant's supported methods. Share this URL only with that buyer. `GET /purchases/{id}` checks the original checkout and records an order only when Shopify returns `completed` and a valid order ID. The SDK and MCP expose the same operations. [Shop catalog](https://shop.dev/docs/tools) · [Shop checkout](https://shop.dev/docs/checkout)

An application that has a production Shopify OAuth client can wire `create_app(purchase_shop_session=...)`. Supply a `ShopSession` containing the signed-in shopper's stable subject and the Shop OAuth access token. Link the purchase UUID to the authenticated shopper in the calling application before opening checkout. Open the checkout with that session from the start. The service is a trusted internal API and its service token belongs on the application server. Keep the Shop token and payment instruments server-side.

When Shopify returns a ready checkout and an identifiable Shop Pay payment method, the service includes `quote.payment_methods`. Present the exact current terms and let the buyer select a method. Confirm with `{quote_id,payment_method_id}`. The service rechecks the terms, claims the approval atomically, and calls `complete_checkout` once. For lost or ambiguous payment responses, read the existing purchase. Shopify can still require merchant checkout for verification or payment. This integration expects Shopify-offered Shop Pay instruments. [Shop authentication](https://shop.dev/docs/authentication) · [Shop payment completion](https://shop.dev/docs/checkout#complete-a-checkout)

## E2B test purchase demo

Run the demo at `/shopping-demo/` on the private service. It offers Shop catalog checkout alongside configured E2B test stores. After connecting, rediscover an existing purchase by opening its demo URL with `?purchase=<purchase-UUID>`. An agent can use the same workflow through the Node SDK, HTTP, or the MCP `buy` tool. The first step can be a keyword search through Shop MCP or resolution of a configured Shopify store's product URL. Discovery can return stores that have no test-payment integration. Use `GET /purchase-merchants` to determine which configured stores can accept a purchase.

| Step | HTTP | SDK |
| --- | --- | --- |
| Find a product | `POST /catalog/search` or `POST /purchase-products/resolve` with `{url,country}` | `searchCatalog`, `resolvePurchaseProduct` |
| Check merchant eligibility | `GET /purchase-merchants` | `listPurchaseMerchants` |
| Create or edit a cart | `POST /purchases` with `{request_id,merchant,items,country}`; `PUT /purchases/{id}/cart` with `{items}` | `createPurchase`, `updatePurchaseCart` |
| Request a payable quote | `POST /purchases/{id}/quote` with `{}` or current `shipping_options` | `quotePurchase` |
| Submit the approved quote | `POST /purchases/{id}/confirm` with `{quote_id}` | `confirmPurchase` |
| Read the order and events | `GET /purchases/{id}`, `GET /purchases/{id}/events?after=0` | `getPurchase`, `listPurchaseEvents` |

The UUID used as `request_id` is the purchase ID. Reuse it with the same create request after a timeout. Variant IDs in `items` are native Shopify numeric IDs and quantities are integers. A cart belongs to one Shopify checkout. If incomplete delivery selection prevents a final quote, use the returned group IDs and send `shipping_options` as a map of each group ID to `{selected_option_id}`. The selection applies to the checkout that issued those IDs. Show the final items, delivery selection, currency, and native total to the buyer or evaluate them against their prior authorization before confirmation. The confirmation includes the exact quote ID and the E2B session remains bound to the checkout through submission. Shopify's ordinary review control runs within that approval.

Read the same purchase on `preparing`, `submitting`, or `reconciliation_required`. For an expired or edited quote, request a current one before sending confirmation. For a submission with unknown outcome, keep the same purchase and await a matching receipt. `submitted` includes a Shopify order ID. Subsequent verified merchant events can report `order_status` and tracking. Only the internal service token may call the write APIs. Keep it in trusted application code.

Configure `CHECKOUT_PURCHASE_STORES` as JSON keyed by the store's permanent `myshopify.com` domain. Each entry supplies the `gateway`, synthetic `profile`, and fixture `card`. Optional fields are `products` (display fixtures with `variant_id`, `title`, `country`, and `currency`), `checkout_host`, `network_hosts`, and `storefront_token`. Use optional `profiles` keyed by market country to select from multiple synthetic addresses. Include a shipping address in `profile.delivery` for physical checkouts and use the same country as the request. Use `profile.billing` to supply independent billing details. `create_app(purchase_credentials=...)` loads a buyer profile for the purchase, merchant, and country. `create_app(purchase_card=...)` supplies the card. The service asks the provider for a card only after approving a current quote. It accepts only the gateway's test-card numbers and a synthetic identity.

For signed merchant events, configure `CHECKOUT_ORDER_WEBHOOKS` as JSON keyed by permanent shop domain with `checkout_host` and app client `secret` in each entry. Subscribe to `orders/create`, `orders/paid`, `orders/fulfilled`, `fulfillments/create`, and `fulfillments/update`. Point the test shop's topics to `/webhooks/shopify/orders`. For callbacks to your own app, set `CHECKOUT_PURCHASE_EVENT_URL` and `CHECKOUT_PURCHASE_EVENT_SECRET`. Each callback carries the durable event ID in `X-FluxA-Event-ID` and the hex HMAC-SHA256 of the exact request body in `X-FluxA-Signature`. Acknowledge with 2xx and deduplicate by event ID. Consumers can also poll with the last seen ID. Delivery retries until acknowledgement. [Shopify Storefront Cart API](https://shopify.dev/docs/api/storefront/2026-10/mutations/cartCreate) · [Shopify Checkout WebMCP](https://shopify.dev/docs/agents/carts-and-checkout/checkout-webmcp) · [Shopify webhook verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries)

Start the MCP server with `node packages/fluxa-shopify-checkout/mcp-server.js` using `CHECKOUT_SERVICE_URL` and `CHECKOUT_SERVICE_TOKEN`. The terminal demo uses these variables and shows the final amount before requesting approval.

```bash
node packages/fluxa-shopify-checkout/examples/purchase-test.mjs --approved-test STORE VARIANT COUNTRY [QUANTITY]
```

## Direct approved-checkout integration

The direct integration supports product discovery and anonymous cart and quote creation through Shop MCP. It also supports checkout previews and approved test payments in fresh E2B Chromium sessions. For test submission, the caller owns building the cart, presenting the items and total to the buyer, and obtaining approval.

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

## Run the pre-approved test checkout demo

Use a dedicated instance of the smoke app and a fresh checkout at an owned Shopify development store or a Shopify Payments store with test mode enabled. Prepare the checkout with the approved items, delivery terms, and final total. Use the Storefront Cart API checkout URL or an open Shopify checkout URL. The server loads one approval and supplies a synthetic profile and test card before the SDK caller runs. The browser fills Shopify's native card fields. `create_app(card=...)` is the integration point for Card Vault. [Shopify development stores](https://shopify.dev/docs/apps/build/stores/development-stores) · [Shopify Payments test mode](https://help.shopify.com/en/manual/payments/shopify-payments/testing-shopify-payments)

Run from the skill directory with Python 3.12. Supply the E2B project key through the service environment. Reuse a pinned template for this checkout worker source or build it if needed.

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-service.txt
export PYTHONPATH="$PWD/scripts"
python -m checkout_service.template TEAM/fluxa-shopify-checkout
```

Set the service environment using the table below. The API checks the pinned template's browser source digest before starting a worker.

| Environment variable | Value |
| --- | --- |
| `E2B_API_KEY` | Private key for the E2B project that owns the template |
| `CHECKOUT_E2B_TEMPLATE` | Exact `TEAM/fluxa-shopify-checkout:<build-UUID>` reference from the build |
| `CHECKOUT_SERVICE_TOKEN` | Private bearer token, 32 or more characters |
| `CHECKOUT_ATTEMPTS_DB` | Absolute path on persistent storage |
| `CHECKOUT_PREVIEW_STORES` | Optional JSON object of configured preview stores, with their Shopify permalink endpoints and supplemental hosts |
| `CHECKOUT_APPROVAL_ID` | Stable UUID for this approved attempt |
| `CHECKOUT_TEST_URL`, `CHECKOUT_TEST_ITEMS`, `CHECKOUT_TEST_TOTAL_MINOR_UNITS`, `CHECKOUT_TEST_CURRENCY`, `CHECKOUT_TEST_EXPIRES_AT` | Checkout link, variant-to-quantity JSON map, exact amount in minor units, currency and approval expiry in Unix seconds |
| `CHECKOUT_TEST_DELIVERY` | Synthetic address JSON with names, street, and an ISO country code in `country`. Supply `city`, `state`, `postal`, and an E.164 `phone` as required by the checkout. |
| `CHECKOUT_TEST_SHIPPING_OPTIONS` | JSON mapping of approved shipping group IDs to selected option IDs and details. Defaults to `{}` for digital orders. |
| `CHECKOUT_TEST_BILLING` | Optional synthetic address JSON with `same_as_delivery: false` and the approved billing address fields. The default is `{"same_as_delivery": true}`. |
| `CHECKOUT_TEST_GATEWAY`, `CHECKOUT_TEST_CARD` | `shopify_test_gateway` with `1` for success or `2` for decline, or `shopify_payments` with the documented success or generic decline test number |
| `CHECKOUT_TEST_STOREFRONT_PASSWORD` | Storefront password for a protected test store |
| `CHECKOUT_TEST_NETWORK_HOSTS` | Space-delimited exact supplemental hostnames for the test checkout. Defaults to `cdn.shopify.com`; the merchant checkout host and Shopify card origin are included automatically. |
| `CHECKOUT_TEST_CHECKOUT_HOST` | Optional trusted checkout hostname if the cart link redirects to a different host. |
| `CHECKOUT_TEST_WEBHOOK_SHOP`, `CHECKOUT_TEST_WEBHOOK_SECRET` | The Shopify permanent `myshopify.com` domain and app client secret for signed test-order recovery. Supply both to enable recovery after sandbox expiry. |

```bash
uvicorn checkout_service.smoke:app --factory --host 127.0.0.1 --port 8080
```

From the repository root, run the SDK example in a second shell with Node.js 18 or newer. Set `CHECKOUT_SERVICE_TOKEN` and `CHECKOUT_APPROVAL_ID` to the service's values. Set `CHECKOUT_SERVICE_URL` if the service uses a different address.

```bash
node packages/fluxa-shopify-checkout/examples/approved-test.mjs
```

The SDK submits the approval UUID once. If the response is interrupted or the receipt is pending, it reads that same attempt for up to three minutes. It prints the status and, once submitted, the Shopify order ID. A result other than `submitted` exits with code 1. Use the same approval UUID to inspect or repeat the same checkout. The demo runs over loopback. An unresolved attempt requires a signed order webhook once its sandbox expires.

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
