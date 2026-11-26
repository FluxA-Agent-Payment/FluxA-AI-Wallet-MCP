"""Wire one approved synthetic checkout into the real API for hosted acceptance."""

import json
import os
from pathlib import Path
from uuid import UUID

from .api import create_app
from .contract import CheckoutGrant, PreviewStore, TestStore, checkout_entry_host
from .purchase import PurchaseMerchant


def app():
    previews = {
        host: PreviewStore(settings["permalink_endpoint"], tuple(settings.get("network_hosts", [])))
        for host, settings in json.loads(os.environ.get("CHECKOUT_PREVIEW_STORES", "{}")).items()
    }
    configured = json.loads(os.environ.get("CHECKOUT_PURCHASE_STORES", "{}"))
    purchase_merchants = {
        host: PurchaseMerchant(
            TestStore(settings["gateway"], tuple(settings.get("network_hosts", ())), settings.get("checkout_host")),
            settings.get("profile", {}), tuple(settings.get("products", ())), settings.get("storefront_token"),
        )
        for host, settings in configured.items()
    }
    order_webhooks = {
        shop: (settings["checkout_host"], settings["secret"])
        for shop, settings in json.loads(os.environ.get("CHECKOUT_ORDER_WEBHOOKS", "{}")).items()
    }
    event_url, event_secret = os.environ.get("CHECKOUT_PURCHASE_EVENT_URL"), os.environ.get("CHECKOUT_PURCHASE_EVENT_SECRET")
    if bool(event_url) != bool(event_secret):
        raise ValueError("Configure both the purchase callback URL and signing secret.")

    def purchase_credentials(_, host, country):
        settings = configured[host]
        return settings.get("profiles", {}).get(country, settings.get("profile", {}))

    def purchase_card(_, host):
        return configured[host]["card"]

    service = {
        "purchase_merchants": purchase_merchants,
        "purchase_credentials": purchase_credentials,
        "purchase_card": purchase_card,
        "purchase_events": (event_url, event_secret) if event_url else None,
        "order_webhooks": order_webhooks,
        "preview_stores": previews,
        "bearer_token": os.environ["CHECKOUT_SERVICE_TOKEN"],
        "database": Path(os.environ["CHECKOUT_ATTEMPTS_DB"]),
        "template": os.environ["CHECKOUT_E2B_TEMPLATE"],
    }
    if "CHECKOUT_TEST_URL" not in os.environ:
        return create_app(
            authorize=lambda _: None,
            credentials=lambda _: {},
            card=lambda _: {},
            test_stores={},
            **service,
        )

    approval_id = UUID(os.environ["CHECKOUT_APPROVAL_ID"])
    grant = CheckoutGrant(
        checkout_url=os.environ["CHECKOUT_TEST_URL"],
        items=json.loads(os.environ["CHECKOUT_TEST_ITEMS"]),
        total_minor_units=int(os.environ["CHECKOUT_TEST_TOTAL_MINOR_UNITS"]),
        currency=os.environ["CHECKOUT_TEST_CURRENCY"],
        expires_at=float(os.environ["CHECKOUT_TEST_EXPIRES_AT"]),
        shipping_options=json.loads(os.environ.get("CHECKOUT_TEST_SHIPPING_OPTIONS", "{}")),
    )
    host = checkout_entry_host(grant.checkout_url)
    checkout_host = os.environ.get("CHECKOUT_TEST_CHECKOUT_HOST", host)
    webhook_shop = os.environ.get("CHECKOUT_TEST_WEBHOOK_SHOP")
    webhook_secret = os.environ.get("CHECKOUT_TEST_WEBHOOK_SECRET")
    if bool(webhook_shop) != bool(webhook_secret):
        raise ValueError("Configure both the Shopify webhook shop and app client secret.")
    if webhook_shop:
        order_webhooks[webhook_shop] = checkout_host, webhook_secret
    profile = {
        "email": "checkout@example.com",
        "delivery": json.loads(os.environ["CHECKOUT_TEST_DELIVERY"]),
        "billing": json.loads(os.environ.get("CHECKOUT_TEST_BILLING", '{"same_as_delivery": true}')),
        "storefront_password": os.environ.get("CHECKOUT_TEST_STOREFRONT_PASSWORD"),
    }
    gateway = os.environ["CHECKOUT_TEST_GATEWAY"]
    test_card = {
        "card_number": os.environ["CHECKOUT_TEST_CARD"],
        "exp": "12/39",
        "cvc": "111",
        "name": "Test payment gateway" if gateway == "shopify_test_gateway" else "Test Buyer",
    }
    store = TestStore(
        gateway=gateway,
        network_hosts=tuple(os.environ.get("CHECKOUT_TEST_NETWORK_HOSTS", "cdn.shopify.com").split()),
        checkout_host=checkout_host,
    )
    return create_app(
        authorize=lambda attempt: grant if attempt == approval_id else None,
        credentials=lambda _: profile,
        card=lambda _: test_card,
        test_stores={host: store},
        **service,
    )
