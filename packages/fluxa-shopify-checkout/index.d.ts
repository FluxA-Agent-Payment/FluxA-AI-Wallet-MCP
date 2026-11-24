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
      status: "navigation_failed" | "manual_verification" | "checkout_unavailable" | "cart_mismatch";
      merchant: string;
    }
  | { status: "browser_unavailable" | "worker_unavailable" | "preview_failed" };

export interface AttemptResult {
  status: string;
  order_id?: string;
}

export class ShopifyCheckoutClient {
  constructor(options: { baseUrl: string; token: string; timeoutMs?: number });
  preview(input: { merchant: string; variantId: string; quantity?: number; country?: string }): Promise<PreviewResult>;
  getAttempt(approvalId: string): Promise<AttemptResult>;
  submitApprovedTest(approvalId: string): Promise<AttemptResult>;
}
