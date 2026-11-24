"""Wire one approved synthetic checkout into the real API for hosted acceptance."""

import json
import os
from pathlib import Path
from uuid import UUID

from .api import create_app
from .contract import CheckoutGrant, PreviewStore, TestStore, checkout_identity


def app():
    previews = {
        host: PreviewStore(settings["permalink_endpoint"], tuple(settings.get("network_hosts", [])))
        for host, settings in json.loads(os.environ.get("CHECKOUT_PREVIEW_STORES", "{}")).items()
    }
    service = {
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
    )
    host, _ = checkout_identity(grant.checkout_url)
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
    )
    return create_app(
        authorize=lambda attempt: grant if attempt == approval_id else None,
        credentials=lambda _: profile,
        card=lambda _: test_card,
        test_stores={host: store},
        **service,
    )
