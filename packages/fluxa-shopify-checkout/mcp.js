import { z } from "zod";
import { CheckoutApiError } from "./index.js";

const purchaseId = z.string().uuid();
const country = z.string().regex(/^[A-Z]{2}$/).describe("Two-letter country code.");
const currency = z.string().regex(/^[A-Z]{3}$/).describe("Three-letter currency code.");
const merchant = z.string().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/);
const productUrl = z.string().url().max(2048).regex(/^https:\/\//);
const quantity = z.number().int().min(1).max(100);
const testItems = z.record(z.string().regex(/^[1-9][0-9]{0,19}$/), quantity)
  .describe("Map of numeric Shopify variant IDs to quantities.");
const catalogItems = z.record(z.string().max(512)
  .regex(/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]{0,19}(?:\?[^\s#]+)?$/), quantity)
  .describe("Map of exact Shopify variant GIDs from the catalog to quantities.");
const shippingOptions = z.record(z.string().min(1), z.object({
  selected_option_id: z.string().min(1),
}).strict()).describe("Map of delivery group IDs to selected options from the purchase.");
const createFields = {
  action: z.literal("create_purchase"),
  request_id: z.string().uuid().describe("Generate once for a new purchase and reuse on retry."),
  country,
};
const confirmFields = {
  purchase_id: purchaseId,
  quote_id: z.string().uuid(),
  buyer_approved: z.literal(true).describe("The buyer explicitly approved the exact quote shown."),
};

const requestSchema = z.union([
  z.object({
    action: z.literal("search_catalog"),
    query: z.string().max(256).regex(/\S/),
    country,
    currency,
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().min(1).max(2048).optional(),
  }).strict().describe("Search products and variants."),
  z.object({
    action: z.literal("lookup_catalog"),
    url: productUrl,
    country,
    currency,
  }).strict().describe("Find Shopify catalog variants for a product URL."),
  z.object({
    action: z.literal("resolve"),
    url: productUrl.describe("Product URL from a configured Shopify test store."),
    country,
  }).strict().describe("Find purchasable variants and prices for a storefront product link."),
  z.object({
    action: z.literal("list_merchants"),
  }).strict().describe("List merchants and their checkout capabilities."),
  z.object({
    ...createFields,
    merchant: merchant.describe("Exact host from list_merchants."),
    items: testItems,
  }).strict().describe("Start a purchase for a configured test merchant."),
  z.object({
    ...createFields,
    channel: z.literal("shop_catalog"),
    merchant: merchant.describe("Exact seller.domain of the selected catalog variants."),
    items: catalogItems,
    currency,
  }).strict().describe("Start a purchase for variants selected from the Shopify catalog."),
  z.object({
    action: z.literal("get_purchase"),
    purchase_id: purchaseId,
  }).strict().describe("Read the purchase and its current quote or receipt."),
  z.object({
    action: z.literal("update_cart"),
    purchase_id: purchaseId,
    items: z.union([testItems, catalogItems]),
  }).strict().describe("Replace all items in the purchase cart."),
  z.object({
    action: z.literal("quote_purchase"),
    purchase_id: purchaseId,
    shipping_options: shippingOptions.optional(),
  }).strict().describe("Prepare a quote. Use the available delivery options if selection is required."),
  z.object({
    action: z.literal("confirm_test_purchase"),
    ...confirmFields,
  }).strict().describe("Submit a test purchase against its approved quote."),
  z.object({
    action: z.literal("confirm_purchase"),
    ...confirmFields,
    payment_method_id: z.string().min(1).optional().describe("Payment method the buyer selected from the current quote."),
  }).strict().describe("Submit a catalog purchase against its approved final quote."),
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
    case "lookup_catalog":
      return client.lookupCatalog(request);
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
    case "confirm_purchase":
      return client.confirmPurchase(request.purchase_id, {
        quoteId: request.quote_id, paymentMethodId: request.payment_method_id,
      });
    case "list_events":
      return client.listPurchaseEvents(request.purchase_id, request);
  }
}

export function registerBuyTool(server, client) {
  server.registerTool("buy", {
    title: "Shopify purchase",
    description: "Find Shopify products by search or URL and manage purchases. For a catalog purchase, use "
      + "the exact variant IDs and seller.domain from the catalog. Use list_merchants for configured test stores. "
      + "If required, share the merchant checkout link with the buyer and use get_purchase to check for the receipt. "
      + "Before confirming, show the exact final quote, including merchant, items, delivery, total, currency, and "
      + "any selected payment method. Confirm only after the buyer explicitly approves that quote. Use get_purchase "
      + "with the same purchase ID after an interrupted confirmation.",
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
