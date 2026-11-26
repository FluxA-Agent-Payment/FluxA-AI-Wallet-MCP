import { z } from "zod";
import { CheckoutApiError } from "./index.js";

const purchaseId = z.string().uuid();
const country = z.string().regex(/^[A-Z]{2}$/).describe("Two-letter country code.");
const merchant = z.string().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/)
  .describe("Exact host from list_merchants.");
const items = z.record(z.string().regex(/^[1-9][0-9]{0,19}$/), z.number().int().min(1).max(100))
  .describe("Map of numeric Shopify variant IDs to quantities.");
const shippingOptions = z.record(z.string().min(1), z.object({
  selected_option_id: z.string().min(1),
}).strict()).describe("Map of delivery group IDs to selected options from the purchase.");

const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("search_catalog"),
    query: z.string().max(256).regex(/\S/),
    country,
    currency: z.string().regex(/^[A-Z]{3}$/),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().min(1).max(2048).optional(),
  }).strict().describe("Search products and variants."),
  z.object({
    action: z.literal("resolve"),
    url: z.string().url().max(2048).regex(/^https:\/\//).describe("Product URL from a configured Shopify test store."),
    country,
  }).strict().describe("Find purchasable variants and prices for a storefront product link."),
  z.object({
    action: z.literal("list_merchants"),
  }).strict().describe("List merchants and their checkout capabilities."),
  z.object({
    action: z.literal("create_purchase"),
    request_id: z.string().uuid().describe("Generate once for a new purchase and reuse on retry."),
    merchant,
    items,
    country,
  }).strict().describe("Start a purchase for a configured test merchant."),
  z.object({
    action: z.literal("get_purchase"),
    purchase_id: purchaseId,
  }).strict().describe("Read the purchase and its current quote or receipt."),
  z.object({
    action: z.literal("update_cart"),
    purchase_id: purchaseId,
    items,
  }).strict().describe("Replace all items in the purchase cart."),
  z.object({
    action: z.literal("quote_purchase"),
    purchase_id: purchaseId,
    shipping_options: shippingOptions.optional(),
  }).strict().describe("Prepare a quote. Use the available delivery options if selection is required."),
  z.object({
    action: z.literal("confirm_test_purchase"),
    purchase_id: purchaseId,
    quote_id: z.string().uuid(),
    buyer_approved: z.literal(true).describe("The buyer explicitly approved the exact quote shown."),
  }).strict().describe("Submit a test purchase against its approved quote."),
  z.object({
    action: z.literal("list_events"),
    purchase_id: purchaseId,
    after: z.number().int().nonnegative().safe().optional()
      .describe("Last event ID read. Start at zero."),
  }).strict().describe("Read purchase events after the cursor."),
]);

function execute(client, request) {
  switch (request.action) {
    case "search_catalog":
      return client.searchCatalog(request);
    case "resolve":
      return client.resolvePurchaseProduct(request);
    case "list_merchants":
      return client.listPurchaseMerchants();
    case "create_purchase":
      return client.createPurchase({ ...request, requestId: request.request_id });
    case "get_purchase":
      return client.getPurchase(request.purchase_id);
    case "update_cart":
      return client.updatePurchaseCart(request.purchase_id, request);
    case "quote_purchase":
      return client.quotePurchase(request.purchase_id, { shippingOptions: request.shipping_options });
    case "confirm_test_purchase":
      return client.confirmPurchase(request.purchase_id, { quoteId: request.quote_id });
    case "list_events":
      return client.listPurchaseEvents(request.purchase_id, request);
  }
}

export function registerBuyTool(server, client) {
  server.registerTool("buy", {
    title: "Shopify purchase",
    description: "Search Shopify products, resolve storefront product links, and manage a test purchase. "
      + "Use list_merchants to find a merchant "
      + "with test_checkout capability. Before confirm_test_purchase, show the buyer the exact current "
      + "quote, including merchant, items, delivery options, total and currency. Call confirm_test_purchase "
      + "only when the buyer explicitly approves that quote. If confirmation is interrupted, use get_purchase "
      + "with the same purchase ID to recover its status.",
    inputSchema: { request: requestSchema },
  }, async ({ request }) => {
    try {
      const result = await execute(client, request);
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      const status = error instanceof CheckoutApiError ? error.status : undefined;
      const message = status >= 400 && status < 500 ? error.message : "The checkout service request failed.";
      const result = { error: message, http_status: status };
      return { isError: true, content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  });
}
