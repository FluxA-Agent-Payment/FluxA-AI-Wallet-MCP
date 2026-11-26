import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { CheckoutApiError, ShopifyCheckoutClient } from "../index.js";

const [mode, merchant, variantId, country, quantity = "1"] = process.argv.slice(2);
if (mode !== "--approved-test" || !merchant || !variantId || !country) {
  console.error("Usage: node purchase-test.mjs --approved-test MERCHANT VARIANT_ID COUNTRY [QUANTITY]");
  process.exit(2);
}

async function waitForPurchase(client, purchase) {
  const deadline = Date.now() + 180_000;
  while (["preparing", "submitting"].includes(purchase.status) && Date.now() < deadline) {
    await sleep(2_000);
    purchase = await client.getPurchase(purchase.id);
  }
  return purchase;
}

async function approveQuote(purchase) {
  console.log(JSON.stringify(purchase, null, 2));
  if (!stdin.isTTY) {
    console.error("Use an interactive terminal to approve the test quote.");
    return false;
  }
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const approval = await terminal.question("To approve and submit this test purchase, enter the quote ID: ");
    return approval.trim() === purchase.quote.id;
  } finally {
    terminal.close();
  }
}

async function run() {
  const client = ShopifyCheckoutClient.fromEnv();
  const { merchants } = await client.listPurchaseMerchants();
  if (!merchants.some(entry => entry.merchant === merchant && entry.status === "test_checkout")) {
    console.error("Select a configured merchant with test_checkout capability.");
    return 1;
  }
  const requestId = process.env.CHECKOUT_REQUEST_ID ?? randomUUID();
  const options = process.env.CHECKOUT_SHIPPING_OPTIONS;
  const shippingOptions = options === undefined ? undefined : JSON.parse(options);
  console.log(JSON.stringify({ request_id: requestId }));
  let purchase = await client.createPurchase({ requestId, merchant, items: { [variantId]: Number(quantity) }, country });
  console.log(JSON.stringify({ purchase_id: purchase.id }));
  purchase = await waitForPurchase(client, purchase);
  if (["draft", "expired"].includes(purchase.status)
      || (shippingOptions && ["quoted", "requires_action"].includes(purchase.status))) {
    purchase = await waitForPurchase(client, await client.quotePurchase(purchase.id, { shippingOptions }));
  }
  if (purchase.status === "quoted" && await approveQuote(purchase)) {
    try {
      purchase = await client.confirmPurchase(purchase.id, { quoteId: purchase.quote.id });
    } catch (error) {
      if (error instanceof CheckoutApiError && error.status >= 400 && error.status < 500) throw error;
      purchase = await client.getPurchase(purchase.id);
    }
    purchase = await waitForPurchase(client, purchase);
  }
  const { events } = await client.listPurchaseEvents(purchase.id);
  console.log(JSON.stringify({ purchase, events }));
  return purchase.status === "submitted" ? 0 : 1;
}

try {
  process.exitCode = await run();
} catch (error) {
  const httpStatus = error instanceof CheckoutApiError ? error.status : undefined;
  console.error(JSON.stringify({ status: "request_failed", http_status: httpStatus }));
  process.exitCode = 1;
}
