export class CheckoutApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "CheckoutApiError";
    this.status = status;
  }
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
    if (typeof token !== "string" || !token.length || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError("Expected a service token and a positive timeout.");
    }
    endpoint.pathname = endpoint.pathname.replace(/\/?$/, "/");
    this.#baseUrl = endpoint;
    this.#token = token;
    this.#timeoutMs = timeoutMs;
  }

  preview({ merchant, variantId, quantity = 1, country }) {
    return this.#request("checkout-previews", "POST", { merchant, variant_id: variantId, quantity, country });
  }

  getAttempt(approvalId) {
    return this.#request(this.#attemptPath(approvalId), "GET");
  }

  submitApprovedTest(approvalId) {
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
    const response = await fetch(new URL(path, this.#baseUrl), {
      method,
      headers,
      body: payload && JSON.stringify(payload),
      signal: AbortSignal.timeout(this.#timeoutMs),
      redirect: "error",
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof result?.detail === "string" ? result.detail : "Checkout service request failed.";
      throw new CheckoutApiError(response.status, message);
    }
    if (typeof result?.status !== "string"
        || (result.status === "preview_ready" && (
          result.source !== "shopify_webmcp" || typeof result.item?.variant_id !== "string"
          || !Number.isSafeInteger(result.item?.quantity) || result.item.quantity < 1
          || !Number.isSafeInteger(result.total?.minor_units) || result.total.minor_units < 0
          || typeof result.total?.currency !== "string" || !/^[A-Z]{3}$/.test(result.total.currency)
        ))
        || (result.status === "submitted" && (
          typeof result.order_id !== "string" || !/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(result.order_id)
        ))) {
      throw new CheckoutApiError(response.status, "Checkout service returned an invalid response.");
    }
    return result;
  }
}
