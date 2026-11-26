import { setTimeout as sleep } from "node:timers/promises";
import { CheckoutApiError, ShopifyCheckoutClient } from "../index.js";

const { CHECKOUT_APPROVAL_ID: approvalId, CHECKOUT_SERVICE_TOKEN: token } = process.env;
const baseUrl = process.env.CHECKOUT_SERVICE_URL ?? "http://127.0.0.1:8080";
const requestTimeoutMs = 5_000;
const recoveryTimeoutMs = 180_000;

function transportFailed(error) {
  return error.name === "TimeoutError" || (error instanceof TypeError && error.cause !== undefined);
}

function retryableHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function pending(result) {
  return !result || result.status === "processing" || result.status === "reconciliation_required";
}

async function readReceipt() {
  const client = new ShopifyCheckoutClient({ baseUrl, token, timeoutMs: requestTimeoutMs });
  let result;
  try {
    result = await client.submitApprovedTest(approvalId);
  } catch (error) {
    // An interrupted submission response can still leave an active checkout.
    if (!transportFailed(error) && !(error instanceof CheckoutApiError &&
        (error.status < 400 || retryableHttpStatus(error.status)))) throw error;
  }

  const deadline = performance.now() + recoveryTimeoutMs;
  while (pending(result)) {
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs < 1) break;
    const reader = new ShopifyCheckoutClient({ baseUrl, token, timeoutMs: Math.min(requestTimeoutMs, remainingMs) });
    try {
      result = await reader.getAttempt(approvalId);
    } catch (error) {
      if (!transportFailed(error) && !(error instanceof CheckoutApiError &&
          (error.status === 404 || retryableHttpStatus(error.status)))) throw error;
    }
    if (pending(result)) {
      await sleep(Math.min(2_000, Math.max(0, deadline - performance.now())));
    }
  }
  return result ?? { status: "reconciliation_required" };
}

if (!token || !approvalId) {
  console.error("Set CHECKOUT_SERVICE_TOKEN and CHECKOUT_APPROVAL_ID.");
  process.exit(1);
}

try {
  const { status, order_id } = await readReceipt();
  console.log(JSON.stringify({ status, order_id }));
  process.exitCode = status === "submitted" ? 0 : 1;
} catch (error) {
  const httpStatus = error instanceof CheckoutApiError ? error.status : undefined;
  console.error(JSON.stringify({ status: "request_failed", http_status: httpStatus }));
  process.exitCode = 1;
}
