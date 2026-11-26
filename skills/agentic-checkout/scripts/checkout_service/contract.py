"""Contracts shared by the checkout API and its sandbox worker."""

import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

PCI_HOST = "checkout.pci.shopifyinc.com"
TEST_CARDS = {
    "shopify_test_gateway": frozenset({"1", "2", "3"}),
    "shopify_payments": frozenset({"4242424242424242", "4000000000000002"}),
}
ORDER_ID = re.compile(r"gid://shopify/Order/[1-9][0-9]*")
VARIANT_ID = re.compile(r"[1-9][0-9]{0,19}")
CHECKOUT_STEPS = ("information", "shipping", "payment", "review")
WORKER_TIMEOUT = 110
SANDBOX_TIMEOUT = 180
ATTEMPT_TIMEOUT = 165
RECEIPT_TIMEOUT = 25
RECEIPT_PATH = "/tmp/fluxa-checkout-result.json"
PURCHASE_QUOTE_PATH = "/tmp/fluxa-purchase-quote.json"
RESOLVED_STORAGE = "/tmp/fluxa-checkout-session.json"


@dataclass(frozen=True, repr=False)
class CheckoutGrant:
    checkout_url: str
    items: dict[str, int]
    total_minor_units: int
    currency: str
    expires_at: float
    shipping_options: dict[str, dict] = field(default_factory=dict)


@dataclass(frozen=True)
class TestStore:
    gateway: str
    network_hosts: tuple[str, ...] = ()
    checkout_host: str | None = None


@dataclass(frozen=True)
class PreviewStore:
    permalink_endpoint: str
    network_hosts: tuple[str, ...] = ()


def is_hostname(host: str) -> bool:
    return bool(
        re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", host)
        and host.rsplit(".", 1)[-1].isalpha()
    )


def checkout_url_parts(url: str):
    parsed = urlsplit(url)
    host = parsed.hostname
    if parsed.scheme != "https" or not host or not is_hostname(host) or parsed.netloc != host or parsed.fragment:
        raise ValueError("Expected an HTTPS Shopify checkout URL.")
    return parsed


def checkout_entry_host(url: str) -> str:
    parsed = checkout_url_parts(url)
    if re.fullmatch(r"/cart/c/[A-Za-z0-9_-]+/?", parsed.path):
        return parsed.netloc
    return checkout_identity(url)[0]


def checkout_route(url: str) -> tuple[str, str, str | None]:
    parsed = checkout_url_parts(url)
    match = re.fullmatch(
        r"/checkouts/(?:cn/)?([A-Za-z0-9_-]+)(?:/[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)?"
        r"(?:/(information|shipping|payment|review|thank-you))?/?",
        parsed.path,
    )
    if not match:
        raise ValueError("Expected an HTTPS Shopify checkout URL.")
    return parsed.netloc, match[1], match[2]


def checkout_identity(url: str) -> tuple[str, str]:
    host, token, step = checkout_route(url)
    if step == "thank-you":
        raise ValueError("Expected an open Shopify checkout.")
    return host, token


def validate_approval(grant: CheckoutGrant) -> None:
    if (
        type(grant.total_minor_units) is not int or not 0 < grant.total_minor_units <= 10**12
        or not re.fullmatch(r"[A-Z]{3}", grant.currency)
    ):
        raise ValueError("Expected the approved Shopify total in minor units and currency.")
    validate_selections(grant.items, grant.shipping_options)


def validate_selections(items: dict, shipping_options: dict) -> None:
    if not isinstance(items, dict) or not items or any(
        not isinstance(variant, str) or not VARIANT_ID.fullmatch(variant)
        or type(quantity) is not int or not 1 <= quantity <= 100 for variant, quantity in items.items()
    ):
        raise ValueError("Expected approved Shopify variants and quantities.")
    if not isinstance(shipping_options, dict):
        raise ValueError("Expected Shopify delivery selections by group.")
    for group, option in shipping_options.items():
        if (not isinstance(group, str) or not group or not isinstance(option, dict)
                or option.keys() - {"selected_option_id", "selected_option_details"}
                or not isinstance(option.get("selected_option_id"), str) or not option["selected_option_id"]):
            raise ValueError("Expected an approved Shopify delivery option for each group.")
        details = option.get("selected_option_details", {})
        if (not isinstance(details, dict) or details.keys() - {"phone_number", "instructions"}
                or any(not isinstance(value, str) for value in details.values())):
            raise ValueError("Invalid Shopify delivery option details.")


def uses_test_data(gateway: str, email: str, card_number: str) -> bool:
    return email.lower().endswith("@example.com") and card_number in TEST_CARDS[gateway]
