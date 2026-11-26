export class CheckoutApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "CheckoutApiError";
    this.status = status;
  }
}

const MAX_TIMEOUT_MS = 2_147_483_647;
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const PURCHASE_STATUSES = new Set([
  "draft", "preparing", "quoted", "submitting", "submitted", "failed",
  "requires_action", "reconciliation_required", "expired",
]);
const PURCHASE_MERCHANT_STATUSES = new Set(["test_checkout", "preview_only", "catalog_only"]);
const ATTEMPT_FAILURES = new Set([
  "test_data_required", "approval_expired", "manual_verification", "unsupported_checkout",
  "identity_incomplete", "total_mismatch", "payment_fields_incomplete", "checkout_unavailable",
  "checkout_not_ready", "cart_mismatch", "payment_method_unavailable", "payment_failed",
  "reconciliation_required", "browser_unavailable", "credentials_unavailable",
]);

function isCurrency(value) {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

function isUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPurchaseQuote(quote) {
  return isUuid(quote?.id) && isCurrency(quote.currency)
    && Number.isSafeInteger(quote.minor_units) && quote.minor_units >= 0
    && Array.isArray(quote.totals) && isRecord(quote.shipping_options) && Number.isFinite(quote.expires_at);
}

function isPurchase(purchase) {
  return isUuid(purchase?.id) && typeof purchase.merchant === "string" && typeof purchase.country === "string"
    && isRecord(purchase.items) && PURCHASE_STATUSES.has(purchase.status)
    && (purchase.quote === undefined ? purchase.status !== "quoted" : isPurchaseQuote(purchase.quote))
    && (purchase.result === undefined
      ? purchase.status !== "submitted"
      : typeof purchase.result?.status === "string"
        && (purchase.status !== "submitted" || isAttemptResult(purchase.result, 200)));
}

function purchasePath(purchaseId) {
  if (!isUuid(purchaseId)) throw new TypeError("Expected a purchase UUID.");
  return `purchases/${purchaseId.toLowerCase()}`;
}

function isNativeSummary(result, status, merchant, reference) {
  return status === 200 && result?.merchant === merchant && typeof result[reference] === "string"
    && isCurrency(result.currency) && Array.isArray(result.items) && Array.isArray(result.totals);
}

function isNativeQuote(result, status, merchant) {
  return isNativeSummary(result, status, merchant, "checkout_ref") && typeof result.status === "string"
    && typeof result.amount_provisional === "boolean";
}

function isPreviewResult(result, request) {
  const status = result?.status;
  if (status === "browser_unavailable" || status === "worker_unavailable" || status === "preview_failed") {
    return true;
  }
  if (typeof result?.merchant !== "string" || result.merchant !== request.merchant) return false;

  switch (status) {
    case "preview_ready": {
      const { item, total } = result;
      return result.source === "shopify_webmcp" && typeof result.checkout_status === "string"
        && typeof item?.variant_id === "string" && item.variant_id === request.variant_id
        && Number.isSafeInteger(item.quantity) && item.quantity > 0 && item.quantity === request.quantity
        && (typeof item.title === "string" || item.title === null)
        && isCurrency(total?.currency) && Number.isSafeInteger(total.minor_units) && total.minor_units >= 0;
    }
    case "checkout_reached": {
      const { items, total } = result;
      return result.source === "page" && typeof result.webmcp_status === "string"
        && Array.isArray(items) && items.every(item =>
          typeof item?.title === "string" && Number.isSafeInteger(item.quantity) && item.quantity > 0)
        && (total === undefined || (isCurrency(total?.currency) && typeof total.display_amount === "string"
          && /^[0-9]+(?:\.[0-9]{1,3})?$/.test(total.display_amount)));
    }
    case "cart_mismatch":
      return result.source === undefined || result.source === "shopify_webmcp";
    case "navigation_failed":
    case "manual_verification":
    case "checkout_unavailable":
      return true;
    default:
      return false;
  }
}

function isAttemptResult(result, statusCode) {
  if (result?.status === "processing") return statusCode === 202 && result.order_id === undefined;
  if (statusCode !== 200) return false;
  if (result?.status === "submitted") {
    return typeof result.order_id === "string" && /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(result.order_id);
  }
  return ATTEMPT_FAILURES.has(result?.status) && result.order_id === undefined;
}

export class ShopifyCheckoutClient {
  #baseUrl;
  #token;
  #timeoutMs;

  static fromEnv({ timeoutMs } = {}) {
    const { CHECKOUT_SERVICE_URL: baseUrl, CHECKOUT_SERVICE_TOKEN: token } = process.env;
    if (!baseUrl || !token) throw new TypeError("Set CHECKOUT_SERVICE_URL and CHECKOUT_SERVICE_TOKEN.");
    return new ShopifyCheckoutClient({ baseUrl, token, timeoutMs });
  }

  constructor({ baseUrl, token, timeoutMs = 180_000 }) {
    const endpoint = new URL(baseUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if ((endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback))
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new TypeError("Expected an HTTPS service URL or a local HTTP service URL.");
    }
    if (typeof token !== "string" || !token.length) {
      throw new TypeError("Expected a service token.");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new TypeError(`Expected timeoutMs to be an integer from 1 to ${MAX_TIMEOUT_MS}.`);
    }
    endpoint.pathname = endpoint.pathname.replace(/\/?$/, "/");
    this.#baseUrl = endpoint;
    this.#token = token;
    this.#timeoutMs = timeoutMs;
  }

  async preview({ merchant, variantId, quantity = 1, country }) {
    const payload = { merchant, variant_id: variantId, quantity, country };
    return this.#request("checkout-previews", "POST", payload,
      (result, status) => status === 200 && isPreviewResult(result, payload));
  }

  async searchCatalog({ query, country, currency, limit, cursor }) {
    return this.#request("catalog/search", "POST", { query, country, currency, limit, cursor },
      (result, status) => status === 200 && Array.isArray(result?.products));
  }

  async listPurchaseMerchants() {
    return this.#request("purchase-merchants", "GET", undefined,
      result => Array.isArray(result?.merchants) && result.merchants.every(merchant =>
        typeof merchant?.merchant === "string" && PURCHASE_MERCHANT_STATUSES.has(merchant.status)));
  }

  async createPurchase({ requestId, merchant, items, country }) {
    return this.#request("purchases", "POST", { request_id: requestId, merchant, items, country },
      result => isPurchase(result) && result.merchant === merchant);
  }

  async getPurchase(purchaseId) {
    return this.#purchaseRequest(purchaseId, "", "GET");
  }

  async updatePurchaseCart(purchaseId, { items }) {
    return this.#purchaseRequest(purchaseId, "/cart", "PUT", { items });
  }

  async quotePurchase(purchaseId, { shippingOptions } = {}) {
    return this.#purchaseRequest(purchaseId, "/quote", "POST", { shipping_options: shippingOptions });
  }

  async confirmPurchase(purchaseId, { quoteId }) {
    if (!isUuid(quoteId)) throw new TypeError("Expected a quote UUID.");
    return this.#purchaseRequest(purchaseId, "/confirm", "POST", { quote_id: quoteId });
  }

  async listPurchaseEvents(purchaseId, { after = 0 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0) throw new TypeError("Expected a nonnegative event cursor.");
    return this.#request(`${purchasePath(purchaseId)}/events?after=${after}`, "GET", undefined,
      result => Array.isArray(result?.events) && result.events.every(event =>
        Number.isSafeInteger(event?.id) && event.purchase_id === purchaseId.toLowerCase() && typeof event.type === "string"
        && isRecord(event.data) && Number.isFinite(event.created_at)));
  }

  async createCart({ merchant, items, country, currency, idempotencyKey }) {
    const payload = {
      merchant, country, currency, idempotency_key: idempotencyKey,
      items: items.map(({ variantId, quantity }) => ({ variant_id: variantId, quantity })),
    };
    return this.#request("native/carts", "POST", payload,
      (result, status) => isNativeSummary(result, status, merchant, "cart_ref"));
  }

  async createCheckoutQuote({ merchant, cartRef, idempotencyKey }) {
    const payload = { merchant, cart_ref: cartRef, idempotency_key: idempotencyKey };
    return this.#request("native/checkout-quotes", "POST", payload,
      (result, status) => isNativeQuote(result, status, merchant));
  }

  async getCheckoutQuote({ merchant, checkoutRef }) {
    const payload = { merchant, checkout_ref: checkoutRef };
    return this.#request("native/checkout-quotes/read", "POST", payload,
      (result, status) => isNativeQuote(result, status, merchant) && result.checkout_ref === checkoutRef);
  }

  async getAttempt(approvalId) {
    return this.#request(this.#attemptPath(approvalId), "GET");
  }

  async submitApprovedTest(approvalId) {
    return this.#request(this.#attemptPath(approvalId), "POST");
  }

  #attemptPath(approvalId) {
    if (!isUuid(approvalId)) {
      throw new TypeError("Expected a purchase approval UUID.");
    }
    return `checkouts/${encodeURIComponent(approvalId)}`;
  }

  #purchaseRequest(purchaseId, suffix, method, payload) {
    return this.#request(purchasePath(purchaseId) + suffix, method, payload,
      result => isPurchase(result) && result.id.toLowerCase() === purchaseId.toLowerCase());
  }

  async #request(path, method, payload, validate = isAttemptResult) {
    const headers = { authorization: `Bearer ${this.#token}`, accept: "application/json" };
    if (payload) headers["content-type"] = "application/json";
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const response = await fetch(new URL(path, this.#baseUrl), {
      method,
      headers,
      body: payload && JSON.stringify(payload),
      signal,
      redirect: "error",
    });
    const result = await response.json().catch(error => {
      signal.throwIfAborted();
      if (!(error instanceof SyntaxError)) throw error;
      return null;
    });
    if (!response.ok) {
      const message = typeof result?.detail === "string" ? result.detail : "Checkout service request failed.";
      throw new CheckoutApiError(response.status, message);
    }
    if (!validate(result, response.status)) {
      throw new CheckoutApiError(response.status, "Checkout service returned an invalid response.");
    }
    return result;
  }
}
