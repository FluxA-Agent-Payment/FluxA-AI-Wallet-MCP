"""Prepare and approve a single native Shopify checkout in an isolated browser."""

import json
import re
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import parse_qs, urlsplit
from uuid import UUID, uuid4

import httpx
from e2b import Sandbox
from e2b.exceptions import NotFoundException
from fastapi import Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from .api import ADDRESS_FIELDS, CARD_FIELDS, close_sandbox, open_sandbox, recover_result, start_worker
from .attempts import UNKNOWN
from .catalog import Currency, Merchant, VariantGID
from .contract import (
    PCI_HOST, PURCHASE_QUOTE_PATH, PURCHASE_SELECTION_PATH, RECEIPT_TIMEOUT, SANDBOX_TIMEOUT, TEST_CARDS,
    VARIANT_ID, TestStore,
    checkout_entry_host, is_hostname, normalize_live_payment,
)
from .purchase_store import PurchaseConflict, PurchaseNotFound, Purchases, storefront_items
from .shop_purchase import SHOP_ERRORS, ShopSessionUnavailable

STOREFRONT_VERSION = "2026-10"
QUOTE_WAIT = 65
RECEIPT_WAIT = 32
MIN_APPROVAL_TIME = 12
STOREFRONT_TIMEOUT = 12
CARD_NETWORK_HOSTS = ("cdn.shopify.com", "checkout.shopify.com", "shop.app")
SHOP_DOMAIN = "query CheckoutDomain { shop { primaryDomain { host } } }"
QUOTE_FAILURES = {
    "approval_expired", "cart_mismatch", "checkout_not_ready", "checkout_unavailable",
    "identity_incomplete", "manual_verification", "payment_method_unavailable",
    "shipping_option_required", "shipping_unavailable", "total_mismatch", "unsupported_checkout",
    "browser_unavailable", "navigation_failed", "preview_failed",
}
CART_CREATE = """
mutation CreatePurchaseCart($input: CartInput!) {
  cartCreate(input: $input) {
    userErrors { code field }
    cart {
      checkoutUrl
      lines(first: 51) { nodes { quantity merchandise { ... on ProductVariant { id } } } pageInfo { hasNextPage } }
    }
  }
}
"""
PRODUCT = """
query ResolvePurchaseProduct($handle: String!, $country: CountryCode!)
@inContext(country: $country) {
  product(handle: $handle) {
    title
    variants(first: 50) { nodes { id title availableForSale price { amount currencyCode } } }
  }
}
"""

Variant = Annotated[str, StringConstraints(pattern=f"^{VARIANT_ID.pattern}$")]
Country = Annotated[str, StringConstraints(pattern=r"^[A-Z]{2}$")]
Quantity = Annotated[int, Field(ge=1, le=100)]
Text = Annotated[str, StringConstraints(min_length=1, max_length=256)]
Items = Annotated[dict[Variant | VariantGID, Quantity], Field(min_length=1, max_length=50)]


@dataclass(frozen=True)
class PurchaseMerchant:
    store: TestStore
    profile: dict = field(default_factory=dict, repr=False)
    products: tuple[dict, ...] = ()
    storefront_token: str | None = field(default=None, repr=False)


class Input(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class Cart(Input):
    items: Items


class Create(Cart):
    request_id: UUID = Field(strict=False)
    merchant: Merchant
    country: Country
    channel: Literal["e2b_test", "shop_catalog", "e2b_card"] = "e2b_test"
    currency: Currency | None = None


class ShippingOption(Input):
    selected_option_id: Text


class ObservedShippingOption(ShippingOption):
    selected_option_details: dict[str, str] | None = Field(default=None, exclude=True)


class QuoteRequest(Input):
    shipping_options: dict[Text, ShippingOption] = Field(default_factory=dict, max_length=50)


class Approval(Input):
    quote_id: UUID = Field(strict=False)
    payment_method_id: Text | None = None


class ProductRequest(Input):
    url: str = Field(max_length=2048)
    country: Country


class DeliveryOption(Input):
    id: Text
    title: str | None = Field(default=None, max_length=256)
    amount: str | int | None = None
    display_text: str | None = Field(default=None, max_length=256)


class QuoteTotal(Input):
    type: Text
    amount: int
    display_text: str | None = Field(default=None, max_length=256)


class NativeQuote(Input):
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    minor_units: int = Field(gt=0, le=10**12)
    totals: list[QuoteTotal] = Field(min_length=1, max_length=50)
    shipping_options: dict[Text, ObservedShippingOption] = Field(max_length=50)
    expires_at: int | float
    delivery_options: dict[Text, list[DeliveryOption]] | None = None


def validate_merchants(merchants, credentials):
    for host, merchant in merchants.items():
        store = merchant.store
        if (
            not host.endswith(".myshopify.com") or store.gateway not in TEST_CARDS
            or not all(map(is_hostname, (host, store.checkout_host or host, *store.network_hosts)))
            or (credentials is None and not merchant.profile.get("email", "").lower().endswith("@example.com"))
        ):
            raise ValueError("Configure exact Shopify test hosts, a supported test gateway and a synthetic buyer.")


def guest_profile(contact, *, live=False):
    email = contact["email"]
    if (not isinstance(email, str) or not re.fullmatch(r"[^\s@]+@[^\s@]+", email)
            or (not live and not email.lower().endswith("@example.com"))):
        raise ValueError("The checkout buyer does not have a valid email.")
    return {
        "email": email,
        "delivery": {key: value for key, value in contact.get("delivery", {}).items() if key in ADDRESS_FIELDS},
        "billing": {key: value for key, value in contact.get("billing", {}).items()
                    if key in ADDRESS_FIELDS or key == "same_as_delivery"},
        "storefront_password": None if live else contact.get("storefront_password"),
    }


def storefront(host, merchant, query, variables):
    headers = ({"X-Shopify-Storefront-Access-Token": merchant.storefront_token}
               if merchant.storefront_token else {})
    response = httpx.post(
        f"https://{host}/api/{STOREFRONT_VERSION}/graphql.json",
        json={"query": query, "variables": variables}, headers=headers, timeout=STOREFRONT_TIMEOUT,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or payload.get("errors") or not isinstance(payload.get("data"), dict):
        raise ValueError("Shopify did not return Storefront API data.")
    return payload["data"]


def checkout_url(host, merchant, country, items, *, public=False):
    data = storefront(host, merchant, CART_CREATE, {"input": {
        "buyerIdentity": {"countryCode": country},
        "lines": [{"merchandiseId": f"gid://shopify/ProductVariant/{variant}", "quantity": quantity}
                  for variant, quantity in items.items()],
    }})
    created = data["cartCreate"]
    if created["userErrors"] or not created["cart"]:
        raise ValueError("The requested Shopify cart could not be created.")
    cart = created["cart"]
    lines = cart["lines"]["nodes"]
    actual = {line["merchandise"]["id"].removeprefix("gid://shopify/ProductVariant/"): line["quantity"]
              for line in lines}
    url = cart["checkoutUrl"]
    entry = checkout_entry_host(url)
    expected = merchant.store.checkout_host or host
    if public and entry != host:
        expected = storefront(host, merchant, SHOP_DOMAIN, {})["shop"]["primaryDomain"]["host"]
    if (actual != items or len(lines) != len(items) or cart["lines"]["pageInfo"]["hasNextPage"]
            or entry not in (host, expected)):
        raise ValueError("Shopify returned a different checkout or cart.")
    return url


def close_previous(sandbox_id):
    if sandbox_id:
        try:
            close_sandbox(Sandbox.connect(sandbox_id, request_timeout=3))
        except Exception:
            pass


def read_quote(sandbox, receipt_path, deadline):
    while time.monotonic() < deadline:
        try:
            value = json.loads(sandbox.files.read(receipt_path, request_timeout=2))
            if not isinstance(value, dict):
                raise ValueError("Invalid checkout quote.")
            return value
        except NotFoundException:
            time.sleep(0.4)
    raise TimeoutError("The Shopify checkout did not reach a payable quote in time.")


class PurchaseFlow:
    def __init__(self, attempts, merchants, credentials, card, template, digest, read_provider, card_provider=None):
        self.purchases = Purchases(attempts)
        self.attempts = attempts
        self.merchants = merchants
        self.credentials = credentials
        self.card = card
        self.card_provider = card_provider
        self.template = template
        self.digest = digest
        self.read_provider = read_provider

    def prepare(self, initial, shipping):
        purchase_id = initial["id"]
        live = initial["channel"] == "e2b_card"
        if live and self.card_provider is None:
            raise HTTPException(status_code=503, detail="Browser card checkout is unavailable.")
        # E2B's lease starts at creation. Using an earlier start leaves room for final receipt.
        expires_at = time.time() + SANDBOX_TIMEOUT
        row, lease = self.purchases.begin_prepare(purchase_id, shipping, expires_at)
        if lease is None:
            return self.purchases.view(row)
        merchant_id = row["merchant"]
        merchant = PurchaseMerchant(TestStore("shopify_payments", CARD_NETWORK_HOSTS)) if live else self.merchants[merchant_id]
        store = merchant.store
        host = store.checkout_host or merchant_id
        items = storefront_items(json.loads(row["items"]))
        card_scope = json.loads(row["card_scope"]) if shipping and row["card_scope"] else None
        sandbox = worker = None
        retained = False
        reason = "checkout_unavailable"
        try:
            if shipping:
                approval_deadline = row["expires_at"]
                reason = "browser_unavailable"
                sandbox = Sandbox.connect(row["sandbox_id"], request_timeout=3)
                pid = row["pid"]
                try:
                    sandbox.commands.send_stdin(pid, json.dumps({"shipping_options": shipping}) + "\n", request_timeout=8)
                except Exception:
                    # A lost acknowledgment can still reach this exact worker.
                    pass
                path = PURCHASE_SELECTION_PATH
            else:
                close_previous(row["sandbox_id"])
                try:
                    credentials = self.card_provider.profile if live else self.credentials
                    contact = self.read_provider(
                        lambda identifier: credentials(identifier, merchant_id, row["country"]), UUID(purchase_id),
                    ) if credentials else merchant.profile
                    profile = guest_profile(contact, live=live)
                    if live:
                        buyer_id = contact.get("buyer_id")
                        if not isinstance(buyer_id, str) or not re.fullmatch(r"[^\s@]{1,256}", buyer_id):
                            raise ValueError("The buyer profile is missing its account ID.")
                except Exception:
                    return self.purchases.finish_prepare(purchase_id, lease, "requires_action",
                        result={"status": "identity_incomplete", "reason": "credentials_unavailable"})[0]
                delivery_country = profile["delivery"].get("country")
                if delivery_country and delivery_country != row["country"]:
                    return self.purchases.finish_prepare(purchase_id, lease, "requires_action",
                        result={"status": "identity_incomplete", "reason": "delivery_country_mismatch"})[0]
                url = checkout_url(merchant_id, merchant, row["country"], items, public=live)
                if live:
                    host = checkout_entry_host(url)
                    card_scope = {"buyer_id": buyer_id, "checkout_host": host}
                reason = "browser_unavailable"
                sandbox = open_sandbox(self.template, self.digest, (merchant_id, host, PCI_HOST, *store.network_hosts),
                                       lease, expires_at=expires_at)
                worker = start_worker(sandbox, "purchase_worker", max(1, int(expires_at - time.time())))
                pid = worker.pid
                worker.send_stdin(json.dumps({
                    "checkout_url": url, "checkout_host": host, "items": items,
                    "profile": profile, "expires_at": expires_at,
                    **({"card_mode": "live_card"} if live else {}),
                }, allow_nan=False) + "\n", request_timeout=8)
                approval_deadline = expires_at - RECEIPT_TIMEOUT
                path = PURCHASE_QUOTE_PATH
            observation = read_quote(sandbox, path, time.monotonic() + min(
                QUOTE_WAIT, max(0, approval_deadline - time.time()),
            ))
            if observation.get("status") == "quoted":
                quote = NativeQuote.model_validate(observation["quote"]).model_dump(exclude_none=True)
                digest = observation["checkout_digest"]
                if (not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
                        or not time.time() + MIN_APPROVAL_TIME < quote["expires_at"] <= approval_deadline):
                    raise ValueError("The Shopify quote has an invalid receipt binding or deadline.")
                quote["id"] = str(uuid4())
                result, retained = self.purchases.finish_prepare(
                    purchase_id, lease, "quoted", quote=quote, sandbox_id=sandbox.sandbox_id,
                    pid=pid, digest=digest, card_scope=card_scope,
                )
                return result
            status = observation.get("status")
            code = observation.get("reason") or status
            if isinstance(code, str) and code in QUOTE_FAILURES:
                reason = code
            failure = {"status": status if isinstance(status, str) and status in QUOTE_FAILURES else reason, "reason": reason}
            options = observation.get("delivery_options")
            if reason == "shipping_option_required" and isinstance(options, dict) and len(options) <= 50:
                failure["delivery_options"] = {
                    group: [DeliveryOption.model_validate(option).model_dump(exclude_none=True) for option in choices]
                    for group, choices in options.items()
                    if isinstance(group, str) and len(group) <= 256 and isinstance(choices, list) and len(choices) <= 50
                }
                selection_expiry = observation.get("selection_expires_at")
                if (not shipping and type(selection_expiry) in (float, int)
                        and time.time() + MIN_APPROVAL_TIME < selection_expiry <= approval_deadline
                        and len(failure["delivery_options"]) == len(options)
                        and failure["delivery_options"] and all(failure["delivery_options"].values())):
                    result, retained = self.purchases.finish_prepare(
                        purchase_id, lease, "requires_action", result=failure,
                        sandbox_id=sandbox.sandbox_id, pid=pid, expires_at=selection_expiry, card_scope=card_scope,
                    )
                    return result
        except (httpx.HTTPError, TimeoutError, KeyError, TypeError, ValueError):
            failure = {"status": reason}
        except Exception:
            if sandbox is None and reason != "browser_unavailable":
                raise
            failure = {"status": reason}
        finally:
            if retained:
                if worker:
                    worker.disconnect()
            elif sandbox:
                close_sandbox(sandbox)
        state = "requires_action" if reason in {
            "manual_verification", "shipping_option_required", "shipping_unavailable",
            "identity_incomplete", "payment_method_unavailable",
        } else "failed"
        return self.purchases.finish_prepare(purchase_id, lease, state, result=failure)[0]

    def read(self, purchase_id):
        row = self.purchases.current(purchase_id)
        if row["status"] not in ("submitting", UNKNOWN):
            return self.purchases.view(row)
        attempt = self.attempts.get(purchase_id)
        if not attempt:
            return self.purchases.view(self.purchases.current(purchase_id))
        stored = json.loads(attempt["result"]) if attempt["result"] else None
        if stored is None or stored["status"] == UNKNOWN:
            try:
                sandbox = Sandbox.connect(attempt["sandbox_id"], request_timeout=3)
                result = recover_result(sandbox)
                if result and result["status"] != UNKNOWN:
                    self.attempts.finish(purchase_id, attempt["lease"], result)
                    close_sandbox(sandbox)
            except Exception:
                pass
            if stored is None and time.time() >= attempt["expires_at"]:
                self.attempts.finish(purchase_id, attempt["lease"], {"status": UNKNOWN})
        return self.purchases.synchronize(purchase_id)

    def confirm(self, current, quote_id):
        purchase_id = current["id"]
        merchant_id = current["merchant"]
        live = current["channel"] == "e2b_card"
        scope = json.loads(current["card_scope"]) if current["card_scope"] else {}
        if live and not current["approved_at"] and self.card_provider is None:
            raise HTTPException(status_code=503, detail="Browser card checkout is unavailable.")
        if live:
            host, gateway = scope.get("checkout_host"), "shopify_payments"
            if not host:
                raise PurchaseConflict("Prepare the current browser checkout before approval.")
        else:
            store = self.merchants[merchant_id].store
            host, gateway = store.checkout_host or merchant_id, store.gateway
        row, lease = self.purchases.claim(purchase_id, quote_id, host, time.time() + RECEIPT_WAIT + 10)
        if lease is None:
            return self.read(purchase_id)
        try:
            if live:
                quote = json.loads(row["quote"])
                claim = {
                    **scope, "purchase_id": purchase_id, "quote_id": quote_id,
                    "merchant": merchant_id, "country": row["country"], "items": json.loads(row["items"]),
                    "total_minor_units": quote["minor_units"], "currency": quote["currency"],
                    "expires_at": quote["expires_at"], "shipping_options": quote["shipping_options"],
                }
                payment = self.read_provider(self.card_provider.card, claim)
                if payment is None:
                    raise HTTPException(status_code=403, detail="The card provider has not authorized this quote.")
                payment = normalize_live_payment(payment)
            else:
                payment = self.read_provider(lambda approval: self.card(approval, merchant_id), UUID(purchase_id))
                payment = {key: value for key, value in payment.items() if key in CARD_FIELDS}
                if payment.get("card_number") not in TEST_CARDS[gateway]:
                    raise ValueError("Only synthetic credentials are allowed.")
            payload = json.dumps({"gateway": gateway, "payment": payment}, allow_nan=False) + "\n"
            if len(payload) > 8192 or time.time() >= row["expires_at"]:
                raise ValueError("The prepared checkout or its credentials are unavailable.")
            sandbox = Sandbox.connect(row["sandbox_id"], request_timeout=3)
        except Exception as error:
            self.purchases.release_claim(purchase_id, lease)
            if isinstance(error, HTTPException):
                raise
            raise HTTPException(status_code=503, detail="Card credentials or the prepared checkout are unavailable.") from None

        deadline = time.monotonic() + RECEIPT_WAIT
        try:
            # A transport failure can still mean the command received payment. Never send twice.
            sandbox.commands.send_stdin(row["pid"], payload, request_timeout=8)
        except Exception:
            pass
        result = None
        while time.monotonic() < deadline:
            result = recover_result(sandbox)
            if result is not None:
                break
            time.sleep(0.5)
        self.attempts.finish(purchase_id, lease, result or {"status": UNKNOWN})
        outcome = self.purchases.synchronize(purchase_id)
        if (result and result["status"] != UNKNOWN) or outcome["status"] == "submitted":
            close_sandbox(sandbox)
        return outcome


def mount_purchase_routes(app, require_service, flow, previews, shop):
    auth = [Depends(require_service)]

    @app.get("/purchase-merchants", dependencies=auth)
    def merchants():
        return {"card_checkout": flow.card_provider is not None, "merchants": [
            *({"merchant": host, "status": "test_checkout", "products": merchant.products}
              for host, merchant in sorted(flow.merchants.items())),
            *({"merchant": host, "status": "preview_only"} for host in sorted(previews.keys() - flow.merchants.keys())),
        ]}

    @app.post("/purchase-products/resolve", dependencies=auth)
    def product(request: ProductRequest):
        parsed = urlsplit(request.url)
        merchant = flow.merchants.get(parsed.netloc)
        match = re.fullmatch(r"/products/([a-zA-Z0-9][a-zA-Z0-9_-]{0,254})/?", parsed.path)
        if not merchant or parsed.scheme != "https" or not match:
            raise HTTPException(status_code=422, detail="Enter a product URL from a configured Shopify test store.")
        try:
            found = storefront(parsed.netloc, merchant, PRODUCT,
                               {"handle": match[1], "country": request.country})["product"]
            if found is None:
                raise HTTPException(status_code=404, detail="This product is unavailable in the requested market.")
            selected = parse_qs(parsed.query).get("variant", [""])[0]
            return {"merchant": parsed.netloc, "title": found["title"], "variants": [
                {"variant_id": variant["id"].rsplit("/", 1)[-1], "title": variant["title"],
                 "available": variant["availableForSale"], "price": variant["price"],
                 "selected": variant["id"].endswith("/" + selected)}
                for variant in found["variants"]["nodes"]
            ]}
        except (httpx.HTTPError, KeyError, ValueError, TypeError):
            raise HTTPException(status_code=502, detail="Shopify product details are unavailable.") from None

    def shop_items(items, channel):
        catalog = channel != "e2b_test"
        if any(variant.startswith("gid://") != catalog for variant in items):
            raise HTTPException(status_code=422, detail="Use the Shopify variant IDs required by the checkout channel.")
        if channel == "e2b_card":
            try:
                storefront_items(items)
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from None

    def shop_operation(operation, *args):
        try:
            return operation(*args)
        except ShopSessionUnavailable:
            raise HTTPException(status_code=503, detail="Shop sign-in is temporarily unavailable.") from None
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="This Shopify checkout is already linked to a purchase.") from None
        except SHOP_ERRORS:
            raise HTTPException(status_code=502, detail="Shopify checkout is temporarily unavailable.") from None
    def shop_result(operation, *args):
        return JSONResponse(shop_operation(operation, *args), headers={"Cache-Control": "no-store"})

    @app.post("/purchases", dependencies=auth)
    def create(request: Create):
        shop_items(request.items, request.channel)
        if request.channel == "shop_catalog":
            if request.currency is None:
                raise HTTPException(status_code=422, detail="Select a market currency for the Shopify purchase.")
        elif request.channel == "e2b_card":
            if flow.card_provider is None:
                raise HTTPException(status_code=503, detail="Browser card checkout is unavailable.")
        elif request.merchant not in flow.merchants:
            raise HTTPException(status_code=422, detail="This merchant is outside the configured Shopify test scope.")
        return flow.purchases.create(
            str(request.request_id), request.merchant, request.items, request.country, request.channel, request.currency,
        )

    @app.get("/purchases/{purchase_id}", dependencies=auth)
    def get(purchase_id: UUID):
        row = flow.purchases.current(str(purchase_id))
        if row["channel"] == "shop_catalog":
            return shop_result(shop.read, row)
        return flow.read(str(purchase_id))

    @app.put("/purchases/{purchase_id}/cart", dependencies=auth)
    def amend(purchase_id: UUID, request: Cart):
        row = flow.purchases.current(str(purchase_id))
        shop_items(request.items, row["channel"])
        if row["channel"] == "shop_catalog":
            shop_operation(shop.session, row)
        view, old_sandbox = flow.purchases.amend(str(purchase_id), request.items)
        close_previous(old_sandbox)
        return view

    @app.post("/purchases/{purchase_id}/quote", dependencies=auth)
    def quote(purchase_id: UUID, request: QuoteRequest):
        row = flow.purchases.current(str(purchase_id))
        if row["channel"] == "shop_catalog":
            if request.shipping_options:
                raise HTTPException(status_code=422, detail="Select delivery options on the Shopify checkout page.")
            return shop_result(shop.prepare, row)
        return flow.prepare(row, request.model_dump()["shipping_options"])

    @app.post("/purchases/{purchase_id}/confirm", dependencies=auth)
    def confirm(purchase_id: UUID, request: Approval):
        row = flow.purchases.current(str(purchase_id))
        if row["channel"] == "shop_catalog":
            return shop_result(shop.confirm, row, request)
        if request.payment_method_id is not None:
            raise HTTPException(status_code=422, detail="Browser checkout obtains card details from the service.")
        return flow.confirm(row, str(request.quote_id))

    @app.get("/purchases/{purchase_id}/events", dependencies=auth)
    def events(purchase_id: UUID, after: int = Query(default=0, ge=0, le=2**63 - 1)):
        row = flow.purchases.current(str(purchase_id))
        if row["channel"] == "shop_catalog":
            shop_operation(shop.session, row)
        return {"events": flow.purchases.events(str(purchase_id), after)}

    @app.exception_handler(PurchaseConflict)
    async def conflict(_request: Request, error):
        return JSONResponse({"detail": str(error)}, status_code=409)

    @app.exception_handler(PurchaseNotFound)
    async def not_found(_request: Request, _error):
        return JSONResponse({"detail": "Purchase not found."}, status_code=404)

    demo = Path(__file__).resolve().parents[2] / "demo"
    if demo.is_dir():
        app.mount("/shopping-demo", StaticFiles(directory=demo, html=True), name="shopping-demo")
