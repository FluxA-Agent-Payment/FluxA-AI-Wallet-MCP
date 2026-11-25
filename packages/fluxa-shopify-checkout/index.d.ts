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

export class ShopifyCheckoutClient {
  constructor(options: { baseUrl: string; token: string; timeoutMs?: number });
  preview(input: { merchant: string; variantId: string; quantity?: number; country?: string }): Promise<PreviewResult>;
  getAttempt(approvalId: string): Promise<AttemptResult>;
  submitApprovedTest(approvalId: string): Promise<AttemptResult>;
}
