"""Exercise checkout HTTP outcomes across the service's real SQLite boundary."""

import base64
import hmac
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from e2b import Sandbox
from fastapi.testclient import TestClient
from httpx import ReadTimeout

from checkout_service.api import create_app
from checkout_service.contract import RECEIPT_PATH, CheckoutGrant, PreviewStore, TestStore
from checkout_service.template import SOURCE_MARKER, source_digest


SHOP = "fixture.myshopify.com"
CHECKOUT_HOST = "checkout.fixture.example.com"
VARIANT = "123456789"
CHECKOUT_TOKEN = "fixture-checkout-token"
CHECKOUT_URL = f"https://{CHECKOUT_HOST}/checkouts/cn/{CHECKOUT_TOKEN}/en-sg"
ORDER_ID = "gid://shopify/Order/1042"
SUBMITTED = {"status": "submitted", "order_id": ORDER_ID}
UNRESOLVED = {"status": "reconciliation_required"}
BEARER_TOKEN = "checkout-service-fixture-token-only"
WEBHOOK_SECRET = "fixture-app-client-secret"

# orders/create reports both the shop money and the customer's presentment money.
SHOPIFY_ORDER = {
    "admin_graphql_api_id": ORDER_ID,
    "checkout_token": CHECKOUT_TOKEN,
    "test": True,
    "currency": "USD",
    "presentment_currency": "SGD",
    "total_price": "9.00",
    "total_price_set": {
        "shop_money": {"amount": "9.00", "currency_code": "USD"},
        "presentment_money": {"amount": "12.34", "currency_code": "SGD"},
    },
    "line_items": [{"variant_id": 123456789, "quantity": 1}],
}


class WorkerHandle:
    def __init__(self, result):
        self.result = result
        self.received_input = False

    def send_stdin(self, data, **_kwargs):
        self.received_input = bool(data)

    def wait(self):
        if not self.received_input or self.result is None:
            raise TimeoutError("No process stream was returned.")
        return SimpleNamespace(stdout=json.dumps(self.result))


class SandboxResponse:
    """Supply the public E2B responses needed to exercise the local host contract."""

    def __init__(self, result, marker, resolved_url=None):
        self.sandbox_id = uuid4().hex
        self.files = self.commands = self
        self.marker = marker
        self.result = result
        self.receipt = None
        self.resolved_url = resolved_url

    def read(self, path, **_kwargs):
        if path == SOURCE_MARKER:
            return self.marker
        if path == RECEIPT_PATH and self.receipt is not None:
            return json.dumps(self.receipt)
        raise FileNotFoundError(path)

    def run(self, command, **_kwargs):
        if command.endswith(".preview") and self.resolved_url:
            return WorkerHandle({"status": "resolved", "checkout_url": self.resolved_url})
        return WorkerHandle(self.result)

    def kill(self, **_kwargs):
        pass


def send_order(client, order=SHOPIFY_ORDER, secret=WEBHOOK_SECRET):
    body = json.dumps(order).encode()
    signature = base64.b64encode(hmac.digest(secret.encode(), body, "sha256")).decode()
    request = client.build_request("POST", "/webhooks/shopify/orders", content=body, headers={
        "content-type": "application/json",
        "x-shopify-topic": "orders/create",
        "x-shopify-shop-domain": SHOP,
        "x-shopify-hmac-sha256": signature,
    })
    del request.headers["authorization"]
    return client.send(request)


class CheckoutServiceTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.database = Path(directory) / "checkout.db"
        self.marker = source_digest()
        self.grants = {}
        self.credentials_available = True
        self.create_sandbox = self.enterContext(patch.object(Sandbox, "create"))
        self.connect_sandbox = self.enterContext(patch.object(Sandbox, "connect", side_effect=TimeoutError))

    def approve(self, url):
        approval = uuid4()
        self.grants[approval] = CheckoutGrant(url, {VARIANT: 1}, 1234, "SGD", time.time() + 120)
        return f"/checkouts/{approval}"

    def credentials(self, _approval):
        if not self.credentials_available:
            raise TimeoutError("Purchase profile provider did not respond.")
        return {"email": "payment-fixture@example.com", "billing": {"same_as_delivery": True}}

    def client(self):
        app = create_app(
            authorize=self.grants.get,
            credentials=self.credentials,
            card=lambda _: {"card_number": "1", "exp": "12/34", "cvc": "111", "name": "Test Buyer"},
            test_stores={SHOP: TestStore("shopify_test_gateway", checkout_host=CHECKOUT_HOST)},
            preview_stores={SHOP: PreviewStore(f"https://{SHOP}/buy")},
            order_webhooks={SHOP: (CHECKOUT_HOST, WEBHOOK_SECRET)},
            bearer_token=BEARER_TOKEN,
            database=self.database,
            template="example/fixture:12345678-1234-1234-1234-123456789abc",
        )
        return TestClient(app, headers={"Authorization": f"Bearer {BEARER_TOKEN}"})

    def assert_result(self, response, expected):
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), expected)

    def test_retry_pre_dispatch_failures_and_guard_canonical_checkout(self):
        """Handoff requires safe repeat POSTs and a durable conflict for a second approval.

        The HTTP/SQLite boundary proves ownership survives provider and template failures;
        worker or provider checks alone cannot establish that behavior.
        """
        first = self.approve(CHECKOUT_URL)
        duplicate = self.approve(f"https://{CHECKOUT_HOST}/checkouts/{CHECKOUT_TOKEN}/en-us?locale=en")
        self.create_sandbox.side_effect = [
            SandboxResponse(SUBMITTED, "0" * 64),
            SandboxResponse(SUBMITTED, self.marker),
            SandboxResponse(SUBMITTED, self.marker),
        ]
        with self.client() as client:
            self.credentials_available = False
            self.assert_result(client.post(first), {"status": "credentials_unavailable"})
            self.credentials_available = True
            self.assert_result(client.post(first), {"status": "browser_unavailable"})
            self.assert_result(client.post(first), SUBMITTED)
            self.assert_result(client.post(first), SUBMITTED)
            self.assertEqual(client.post(duplicate).status_code, 409)
            self.assert_result(client.get(first), SUBMITTED)

    def test_preview_recovers_the_sandbox_when_the_create_response_times_out(self):
        """The preview must recover without creating a second sandbox across a lost response."""
        quote = {
            "status": "preview_ready", "source": "shopify_webmcp", "merchant": SHOP,
            "checkout_status": "incomplete", "item": {"variant_id": VARIANT, "quantity": 1, "title": "Fixture"},
            "total": {"currency": "SGD", "minor_units": 1234},
        }
        created = {}

        def create_sandbox(*_args, idempotency_key, **_kwargs):
            if idempotency_key and idempotency_key in created:
                return created[idempotency_key]
            if idempotency_key:
                created[idempotency_key] = SandboxResponse(quote, self.marker)
            raise ReadTimeout("Sandbox created but its response was lost.")

        self.create_sandbox.side_effect = create_sandbox
        with self.client() as client:
            self.assert_result(client.post("/checkout-previews", json={"merchant": SHOP, "variant_id": VARIANT}), quote)

    def test_persistent_startup_timeout_stops_before_dispatch_and_preserves_approval(self):
        """A persistent E2B timeout must end this request and leave the approval safe to retry."""
        first = self.approve(CHECKOUT_URL)
        self.create_sandbox.side_effect = [
            ReadTimeout("Sandbox creation timed out."),
            ReadTimeout("Sandbox creation replay timed out."),
            SandboxResponse(SUBMITTED, self.marker),
        ]
        with self.client() as client:
            self.assert_result(client.post(first), {"status": "browser_unavailable"})
            self.assert_result(client.get(first), {"status": "browser_unavailable"})
            self.assert_result(client.post(first), SUBMITTED)

    def test_verified_order_resolves_lost_cart_checkout_reply_after_restart(self):
        """Handoff requires a persisted claim and a verified order bound to that checkout.

        Reopening the app on its SQLite database detects state lost across restart.
        A standalone webhook parser cannot prove promotion or safe repeat requests.
        """
        checkout = self.approve(f"https://{SHOP}/cart/c/fixture-entry?key=fixture-key")
        self.create_sandbox.return_value = SandboxResponse(None, self.marker, resolved_url=CHECKOUT_URL)
        with self.client() as client:
            self.assert_result(client.post(checkout), UNRESOLVED)

        with self.client() as client:
            self.assert_result(client.get(checkout), UNRESOLVED)
            self.assertEqual(send_order(client, secret="other-secret").status_code, 401)
            self.assert_result(client.get(checkout), UNRESOLVED)

            self.assertEqual(send_order(client, {**SHOPIFY_ORDER, "test": False}).status_code, 204)
            self.assert_result(client.get(checkout), UNRESOLVED)
            self.assertEqual(send_order(client, {**SHOPIFY_ORDER, "total_price_set": {
                **SHOPIFY_ORDER["total_price_set"],
                "presentment_money": {"amount": "12.35", "currency_code": "SGD"},
            }}).status_code, 204)
            self.assert_result(client.get(checkout), UNRESOLVED)
            self.assertEqual(send_order(client, {**SHOPIFY_ORDER, "line_items": [
                {"variant_id": 123456788, "quantity": 1},
            ]}).status_code, 204)
            self.assert_result(client.get(checkout), UNRESOLVED)

            self.assertEqual(send_order(client).status_code, 204)
            self.assert_result(client.get(checkout), SUBMITTED)
            self.assertEqual(send_order(client).status_code, 204)
            self.assert_result(client.post(checkout), SUBMITTED)

    def test_reconnect_persists_sandbox_receipt_before_it_becomes_unavailable(self):
        """A surviving E2B receipt must resolve the approval without a Shopify webhook."""
        checkout = self.approve(CHECKOUT_URL)
        sandbox = SandboxResponse(None, self.marker)
        self.create_sandbox.return_value = sandbox
        with self.client() as client:
            self.assert_result(client.post(checkout), UNRESOLVED)

        sandbox.receipt = SUBMITTED
        self.connect_sandbox.side_effect = [sandbox, TimeoutError()]
        with self.client() as client:
            self.assert_result(client.get(checkout), SUBMITTED)
            sandbox.receipt = None
            self.assert_result(client.get(checkout), SUBMITTED)
