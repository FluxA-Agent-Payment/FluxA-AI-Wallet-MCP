export class CheckoutApiError extends Error {
  constructor(status: number, message: string);
  status: number;
}

export type PreviewResult =
  | {
      status: "preview_ready";
      merchant: string;
      source: "shopify_webmcp";
      checkout_status: string;
      item: { variant_id: string; quantity: number; title: string | null };
      total: { currency: string; minor_units: number };
    }
  | {
      status: "checkout_reached";
      merchant: string;
      source: "page";
      items: { title: string; quantity: number }[];
      webmcp_status: string;
      total?: { currency: string; display_amount: string };
    }
  | {
      status: "navigation_failed" | "manual_verification" | "checkout_unavailable";
      merchant: string;
    }
  | { status: "cart_mismatch"; merchant: string; source?: "shopify_webmcp" }
  | { status: "browser_unavailable" | "worker_unavailable" | "preview_failed" };

export type AttemptResult =
  | { status: "submitted"; order_id: string }
  | {
      status: "processing" | "test_data_required" | "approval_expired" | "manual_verification"
        | "unsupported_checkout" | "identity_incomplete" | "total_mismatch" | "payment_fields_incomplete"
        | "checkout_unavailable" | "checkout_not_ready" | "cart_mismatch" | "payment_method_unavailable"
        | "payment_failed" | "reconciliation_required" | "browser_unavailable" | "credentials_unavailable";
      order_id?: never;
    };

export type CatalogSearchResult = {
  products: Array<{
    id: string;
    title: string;
    variants: Array<{
      id: string;
      url?: string;
      price?: { amount: number; currency: string };
      availability?: { available: boolean };
      seller?: { name: string; url?: string; domain?: string };
    }>;
  }>;
  messages?: Array<{ type: string; code: string; content: string }>;
  pagination?: { has_next_page: boolean; cursor?: string };
};

export type NativeCartSummary = {
  merchant: string;
  currency: string;
  items: { variant_id: string; title: string; quantity: number }[];
  totals: { type: string; amount: number; display_text?: string }[];
  messages: { type: string; content: string; code?: string; severity?: string; path?: string }[];
  links: { type: string; url: string; title?: string }[];
  expires_at?: string;
};

export type NativeCart = NativeCartSummary & {
  cart_ref: string;
};

export type NativeCheckoutQuote = NativeCartSummary & {
  checkout_ref: string;
  status: "incomplete" | "requires_escalation" | "ready_for_complete" | "complete_in_progress" | "completed" | "canceled";
  amount_provisional: boolean;
  continue_url?: string;
};

export type PurchaseItems = Record<string, number>;

export type PurchaseShippingOptions = Record<string, {
  selected_option_id: string;
  selected_option_details?: { phone_number?: string; instructions?: string };
}>;

export type PurchaseDeliveryOptions = Record<string, Array<{
  id: string;
  title?: string;
  amount?: number;
  display_text?: string;
}>>;

export type PurchaseQuote = {
  id: string;
  currency: string;
  minor_units: number;
  totals: NativeCartSummary["totals"];
  shipping_options: PurchaseShippingOptions;
  expires_at: number;
  delivery_options?: PurchaseDeliveryOptions;
};

export type PurchaseStatus = "draft" | "preparing" | "quoted" | "submitting" | "submitted"
  | "failed" | "requires_action" | "reconciliation_required" | "expired";

export type Purchase = {
  id: string;
  merchant: string;
  items: PurchaseItems;
  country: string;
  status: PurchaseStatus;
  quote?: PurchaseQuote;
  result?: {
    status: string;
    order_id?: string;
    reason?: string;
    delivery_options?: PurchaseDeliveryOptions;
  };
  order_status?: "placed" | "paid" | "shipped";
  tracking?: Array<{ company?: string; number?: string; url?: string }>;
};

export type PurchaseEvent = {
  id: number;
  purchase_id: string;
  type: string;
  data: Record<string, unknown>;
  created_at: number;
};

export type PurchaseMerchant = {
  merchant: string;
  status: "test_checkout" | "preview_only" | "catalog_only";
  products?: Array<{ variant_id: string; title: string; country: string; currency: string }>;
};

export class ShopifyCheckoutClient {
  static fromEnv(options?: { timeoutMs?: number }): ShopifyCheckoutClient;
  constructor(options: { baseUrl: string; token: string; timeoutMs?: number });
  searchCatalog(input: { query: string; country: string; currency: string; limit?: number; cursor?: string }): Promise<CatalogSearchResult>;
  listPurchaseMerchants(): Promise<{ merchants: PurchaseMerchant[] }>;
  createPurchase(input: { requestId: string; merchant: string; items: PurchaseItems; country: string }): Promise<Purchase>;
  getPurchase(purchaseId: string): Promise<Purchase>;
  updatePurchaseCart(purchaseId: string, input: { items: PurchaseItems }): Promise<Purchase>;
  quotePurchase(purchaseId: string, input?: { shippingOptions?: PurchaseShippingOptions }): Promise<Purchase>;
  /** Submit the current quote for a test purchase after the buyer approves that quote. */
  confirmPurchase(purchaseId: string, input: { quoteId: string }): Promise<Purchase>;
  listPurchaseEvents(purchaseId: string, input?: { after?: number }): Promise<{ events: PurchaseEvent[] }>;
  createCart(input: { merchant: string; items: { variantId: string; quantity: number }[]; country: string; currency: string; idempotencyKey: string }): Promise<NativeCart>;
  createCheckoutQuote(input: { merchant: string; cartRef: string; idempotencyKey: string }): Promise<NativeCheckoutQuote>;
  getCheckoutQuote(input: { merchant: string; checkoutRef: string }): Promise<NativeCheckoutQuote>;
  preview(input: { merchant: string; variantId: string; quantity?: number; country?: string }): Promise<PreviewResult>;
  getAttempt(approvalId: string): Promise<AttemptResult>;
  submitApprovedTest(approvalId: string): Promise<AttemptResult>;
}
