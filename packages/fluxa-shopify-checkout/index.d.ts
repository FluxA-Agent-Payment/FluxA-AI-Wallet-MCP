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

export class ShopifyCheckoutClient {
  constructor(options: { baseUrl: string; token: string; timeoutMs?: number });
  searchCatalog(input: { query: string; country: string; currency: string; limit?: number; cursor?: string }): Promise<CatalogSearchResult>;
  createCart(input: { merchant: string; items: { variantId: string; quantity: number }[]; country: string; currency: string; idempotencyKey: string }): Promise<NativeCart>;
  createCheckoutQuote(input: { merchant: string; cartRef: string; idempotencyKey: string }): Promise<NativeCheckoutQuote>;
  getCheckoutQuote(input: { merchant: string; checkoutRef: string }): Promise<NativeCheckoutQuote>;
  preview(input: { merchant: string; variantId: string; quantity?: number; country?: string }): Promise<PreviewResult>;
  getAttempt(approvalId: string): Promise<AttemptResult>;
  submitApprovedTest(approvalId: string): Promise<AttemptResult>;
}
