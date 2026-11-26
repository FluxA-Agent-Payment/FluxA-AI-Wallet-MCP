"""Buy from Shop catalog offers through Shopify's hosted checkout protocol."""

import hashlib
import hmac
import json
import time
from dataclasses import dataclass, field
from datetime import datetime
from uuid import UUID, uuid4

import httpx

from .attempts import UNKNOWN
from .catalog import checkout_quote, shop_call
from .contract import ORDER_ID
from .purchase_store import PurchaseConflict, encode

SHOP_ERRORS = (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError)
PREPARE_WINDOW = 30


class ShopSessionUnavailable(Exception):
    """The operator could not read the shopper’s Shop account."""


@dataclass(frozen=True)
class ShopSession:
    """A shopper's Shop OAuth access token and stable account identifier."""

    subject: str = field(repr=False)
    access_token: str = field(repr=False)


def snapshot(row, document):
    checkout = checkout_quote(document, row["merchant"])
    requested = json.loads(row["items"])
    if ({line.variant_id: line.quantity for line in checkout.items} != requested
            or len(checkout.items) != len(requested)
            or (row["native_ref"] and checkout.checkout_ref != row["native_ref"])):
        raise ValueError("Shopify returned different checkout items or a different checkout.")
    raw_expires = checkout.expires_at
    timestamp = datetime.fromisoformat(raw_expires) if raw_expires else None
    if timestamp and timestamp.tzinfo:
        expires_at = timestamp.timestamp()
    elif checkout.status == "completed" and row["native_ref"] and row["expires_at"]:
        expires_at = row["expires_at"]
    else:
        raise ValueError("Shopify did not return a checkout expiration.")
    instruments = {}
    payment = document.get("payment") or {}
    for method in payment.get("instruments") or []:
        identity = method.get("id")
        if (method.get("type") == "shop_pay" and isinstance(identity, str) and 0 < len(identity) <= 256):
            if identity in instruments:
                raise ValueError("Shopify returned duplicate payment methods.")
            instruments[identity] = method
    order = document.get("order")
    order_id = order.get("id") if isinstance(order, dict) else None
    if checkout.status == "completed" and (not isinstance(order_id, str) or not ORDER_ID.fullmatch(order_id)):
        raise ValueError("Shopify did not return a confirmed order ID.")
    methods = []
    if checkout.status == "ready_for_complete" and expires_at > time.time() and row["native_subject"]:
        for identity, instrument in instruments.items():
            brand, last_four = instrument.get("brand"), instrument.get("last4")
            label = "Shop Pay"
            if isinstance(brand, str) and brand.isalpha() and len(brand) <= 24:
                label += f" · {brand}"
            if isinstance(last_four, str) and len(last_four) == 4 and last_four.isascii() and last_four.isdigit():
                label += f" •••• {last_four}"
            methods.append({"id": identity, "label": label})
    quote = {
        "currency": checkout.currency, "minor_units": next(total.amount for total in checkout.totals if total.type == "total"),
        "totals": [total.model_dump(exclude_none=True) for total in checkout.totals],
        "shipping_options": {}, "expires_at": expires_at, "amount_provisional": checkout.amount_provisional,
        "messages": [message.model_dump(exclude_none=True) for message in checkout.messages],
        "links": [link.model_dump(exclude_none=True) for link in checkout.links],
    }
    if methods and len({method["label"] for method in methods}) == len(methods):
        quote["payment_methods"] = methods
    terms = hashlib.sha256(encode([
        quote, document.get("fulfillment"), document.get("buyer"), document.get("declared_fields"),
    ]).encode()).hexdigest()
    return checkout, quote, terms, instruments, order_id


class ShopPurchases:
    def __init__(self, purchases, credentials, read_provider):
        self.purchases = purchases
        self.db = purchases.connection
        self.credentials = credentials
        self.read_provider = read_provider

    def session(self, row):
        if row["native_key"] and not row["native_subject"]:
            return None, None
        try:
            session = self.read_provider(self.credentials, UUID(row["id"])) if self.credentials else None
        except Exception:
            raise ShopSessionUnavailable from None
        token, subject = None, None
        if session:
            if not isinstance(session, ShopSession) or not session.subject or not session.access_token:
                raise ShopSessionUnavailable
            token = session.access_token
            subject = hashlib.sha256(session.subject.encode()).hexdigest()
        if row["native_subject"] and (not subject or not hmac.compare_digest(row["native_subject"], subject)):
            raise PurchaseConflict("Reconnect the Shop account that opened this checkout.")
        return token, subject

    def start(self, purchase_id, subject):
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self.purchases.row(db, purchase_id)
            if row["native_key"] and row["native_subject"] != subject:
                raise PurchaseConflict("Reconnect the Shop account that opened this checkout.")
            if row["native_ref"] or (row["status"] == "preparing" and row["expires_at"] > time.time()):
                return row, None
            key = row["native_key"] or str(uuid4())
            lease = uuid4().hex
            db.execute("""UPDATE purchases SET status='preparing', lease=?, expires_at=?, native_key=?, native_subject=?,
                          result=NULL WHERE id=?""", (lease, time.time() + PREPARE_WINDOW, key, subject, purchase_id))
            return self.purchases.row(db, purchase_id), lease

    def record(self, row, document, *, lease=None):
        checkout, quote, terms, _, order_id = snapshot(row, document)
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            current = self.purchases.row(db, row["id"])
            if current["status"] == "submitted":
                return self.purchases.view(current)
            if lease is not None and current["lease"] != lease:
                return self.purchases.view(current)
            if lease is None and current["native_ref"] != checkout.checkout_ref:
                return self.purchases.view(current)
            # A read that began before approval cannot replace newer submission state.
            if lease is None and current["approved_at"] and checkout.status != "completed":
                if current["status"] != "submitting" or current["approved_at"] + PREPARE_WINDOW > time.time():
                    return self.purchases.view(current)
            previous = json.loads(current["quote"]) if current["quote"] else None
            quote["id"] = previous["id"] if previous and current["native_terms"] == terms else str(uuid4())
            order_status = None
            if checkout.status == "completed":
                expected = current["approved_at"] and previous and all(
                    previous[field] == quote[field] for field in ("currency", "minor_units")
                )
                if not current["approved_at"] or expected:
                    status, result, order_status = "submitted", {"status": "submitted", "order_id": order_id}, "placed"
                else:
                    status = UNKNOWN
                    result = {"status": UNKNOWN, "reason": "final_total_changed", "order_id": order_id}
                    quote = previous
            elif checkout.status == "complete_in_progress" or (
                current["approved_at"] and (lease is None or checkout.status != "requires_escalation")
            ):
                status, result = UNKNOWN, {"status": UNKNOWN}
            elif checkout.status == "canceled" or quote["expires_at"] <= time.time():
                status, result = "expired", {"status": "approval_expired"}
            elif quote.get("payment_methods"):
                status, result = "quoted", None
            elif checkout.continue_url:
                status, result = "requires_action", {"status": "requires_action", "reason": "merchant_checkout"}
            else:
                status, result = "failed", {"status": "checkout_unavailable"}
            db.execute("""UPDATE purchases SET status=?, result=?, quote=?, expires_at=?, native_ref=?, native_url=?,
                          native_terms=?, lease=NULL, order_status=COALESCE(?, order_status) WHERE id=?""",
                       (status, encode(result) if result else None, encode(quote), quote["expires_at"],
                        checkout.checkout_ref, checkout.continue_url, terms, order_status, row["id"]))
            return self.purchases.view(self.purchases.row(db, row["id"]))

    def prepare(self, row):
        if row["native_ref"]:
            return self.read(row)
        token, subject = self.session(row)
        row, lease = self.start(row["id"], subject)
        if lease is None:
            return self.purchases.view(row)
        try:
            document = shop_call("create_checkout", {
                "shop": row["merchant"], "meta": {"idempotency-key": row["native_key"]},
                "checkout": {
                    "line_items": [{"item": {"id": variant}, "quantity": quantity}
                                   for variant, quantity in json.loads(row["items"]).items()],
                    "context": {"address_country": row["country"], "currency": row["currency"]},
                },
            }, access_token=token)
            return self.record(row, document, lease=lease)
        except SHOP_ERRORS:
            return self.purchases.finish_prepare(
                row["id"], lease, "failed", result={"status": "checkout_unavailable"},
            )[0]

    def get(self, row, token):
        return shop_call("get_checkout", {"shop": row["merchant"], "id": row["native_ref"]}, access_token=token)

    def read(self, row):
        token, _ = self.session(row)
        if row["native_ref"] and row["status"] != "submitted":
            try:
                return self.record(row, self.get(row, token))
            except SHOP_ERRORS:
                pass
        if row["status"] == "submitting" and row["approved_at"] + PREPARE_WINDOW <= time.time():
            with self.db() as db:
                db.execute("""UPDATE purchases SET status=?,result=?,lease=NULL
                              WHERE id=? AND status='submitting' AND approved_at=?""",
                           (UNKNOWN, encode({"status": UNKNOWN}), row["id"], row["approved_at"]))
                row = self.purchases.row(db, row["id"])
        return self.purchases.view(row)

    def confirm(self, row, approval):
        token, _ = self.session(row)
        if row["approved_at"]:
            return self.read(row)
        if not token or not row["native_ref"] or not approval.payment_method_id:
            raise PurchaseConflict("Select a payment method from the current Shop checkout.")
        document = self.get(row, token)
        checkout, quote, terms, instruments, _ = snapshot(row, document)
        method = approval.payment_method_id
        if (checkout.status != "ready_for_complete" or terms != row["native_terms"]
                or method not in {choice["id"] for choice in quote.get("payment_methods", [])}):
            self.record(row, document)
            raise PurchaseConflict("Shopify updated checkout. Review the current terms before approving again.")
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            current = self.purchases.row(db, row["id"])
            approved = json.loads(current["quote"]) if current["quote"] else {}
            if current["approved_at"]:
                return self.purchases.view(current)
            if (approved.get("id") != str(approval.quote_id) or current["native_terms"] != terms
                    or current["expires_at"] <= time.time() or current["status"] != "quoted"):
                raise PurchaseConflict("Approve the current Shopify quote.")
            lease = str(uuid4())
            db.execute("UPDATE purchases SET status='submitting', approved_at=?, lease=? WHERE id=?",
                       (time.time(), lease, row["id"]))
        try:
            completed = shop_call("complete_checkout", {
                "shop": row["merchant"], "id": row["native_ref"], "meta": {"idempotency-key": lease},
                "checkout": {"payment": {"instruments": [{**instruments[method], "selected": True}]}},
            }, access_token=token)
            return self.record(row, completed, lease=lease)
        except SHOP_ERRORS:
            with self.db() as db:
                db.execute("""UPDATE purchases SET status=?,result=?,lease=NULL WHERE id=? AND lease=?""",
                           (UNKNOWN, encode({"status": UNKNOWN}), row["id"], lease))
                return self.purchases.view(self.purchases.row(db, row["id"]))
