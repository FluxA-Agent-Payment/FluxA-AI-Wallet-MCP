export class CheckoutApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "CheckoutApiError";
    this.status = status;
  }
}

const MAX_TIMEOUT_MS = 2_147_483_647;
const ATTEMPT_FAILURES = new Set([
  "test_data_required", "approval_expired", "manual_verification", "unsupported_checkout",
  "identity_incomplete", "total_mismatch", "payment_fields_incomplete", "checkout_unavailable",
  "checkout_not_ready", "cart_mismatch", "payment_method_unavailable", "payment_failed",
  "reconciliation_required", "browser_unavailable", "credentials_unavailable",
]);

function isCurrency(value) {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
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
    return this.#request("checkout-previews", "POST", { merchant, variant_id: variantId, quantity, country });
  }

  async getAttempt(approvalId) {
    return this.#request(this.#attemptPath(approvalId), "GET");
  }

  async submitApprovedTest(approvalId) {
    return this.#request(this.#attemptPath(approvalId), "POST");
  }

  #attemptPath(approvalId) {
    if (typeof approvalId !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(approvalId)) {
      throw new TypeError("Expected a purchase approval UUID.");
    }
    return `checkouts/${encodeURIComponent(approvalId)}`;
  }

  async #request(path, method, payload) {
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
    const valid = payload
      ? response.status === 200 && isPreviewResult(result, payload)
      : isAttemptResult(result, response.status);
    if (!valid) {
      throw new CheckoutApiError(response.status, "Checkout service returned an invalid response.");
    }
    return result;
  }
}
