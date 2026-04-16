#!/usr/bin/env python3
"""Provider detection helpers for Shopify checkout pages."""

from __future__ import annotations

from typing import Any
import re


UNSUPPORTED_MARKERS = ("paypal", "braintree", "adyen", "klarna", "afterpay", "amazon pay")
CARD_FIELD_MARKERS = (
    "card number",
    "name on card",
    "expiration date",
    "security code",
    "mm / yy",
    "cvc",
    "cvv",
    "autocomplete=\"cc-number\"",
    "autocomplete='cc-number'",
)


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def detect_provider(
    current_url: str,
    html: str,
    iframe_urls: list[str] | None = None,
    button_texts: list[str] | None = None,
) -> dict[str, Any]:
    iframe_urls = iframe_urls or []
    button_texts = button_texts or []
    haystack = " ".join(
        [
            normalize_text(current_url).lower(),
            normalize_text(html).lower(),
            " ".join(normalize_text(item).lower() for item in iframe_urls),
            " ".join(normalize_text(item).lower() for item in button_texts),
        ]
    )
    hints: list[str] = []
    has_card_fields = any(marker in haystack for marker in CARD_FIELD_MARKERS)

    if any("js.stripe.com" in iframe.lower() or "stripe" in iframe.lower() for iframe in iframe_urls):
        hints.append("iframe:stripe")
        return {"provider": "stripe_hosted", "hints": hints}

    if any(host in normalize_text(current_url).lower() for host in ("checkout.stripe.com", "buy.stripe.com", "billing.stripe.com")):
        hints.append("url:stripe_checkout")
        return {"provider": "stripe_hosted", "hints": hints}

    if "secure payment input frame" in haystack or "autocomplete=\"cc-number\"" in haystack:
        hints.append("dom:stripe_card_markers")
        return {"provider": "stripe_hosted", "hints": hints}

    if any("checkout.pci.shopifyinc.com" in iframe.lower() for iframe in iframe_urls):
        hints.append("iframe:shopify_pci")
        return {"provider": "shopify_checkout_card", "hints": hints}

    if (
        "/checkouts/" in normalize_text(current_url).lower()
        and "credit card" in haystack
        and ("field container for: card number" in haystack or "expiration date (mm / yy)" in haystack)
    ):
        hints.append("dom:shopify_checkout_card")
        return {"provider": "shopify_checkout_card", "hints": hints}

    if "pay.shopify.com" in normalize_text(current_url).lower() and has_card_fields:
        hints.append("url:shop_pay")
        return {"provider": "shop_pay_card", "hints": hints}

    if any("pay.shopify.com" in iframe.lower() or "shop.app" in iframe.lower() for iframe in iframe_urls) and has_card_fields:
        hints.append("iframe:shop_pay")
        return {"provider": "shop_pay_card", "hints": hints}

    if "shop pay" in haystack and has_card_fields:
        hints.append("dom:shop_pay")
        return {"provider": "shop_pay_card", "hints": hints}

    unsupported = [marker for marker in UNSUPPORTED_MARKERS if marker in haystack]
    if unsupported:
        for marker in unsupported:
            hints.append(f"unsupported:{marker}")
        return {"provider": "unsupported", "hints": hints}

    hints.append("provider:unknown")
    return {"provider": "unknown", "hints": hints}
