"""Verify and read Shopify order creation receipts."""

import base64
import hmac
import json
import re
from dataclasses import dataclass, field
from decimal import Context, Decimal, Inexact, InvalidOperation

from iso4217 import Currency

from .contract import ORDER_ID, VARIANT_ID


@dataclass(frozen=True)
class OrderReceipt:
    checkout_token: str = field(repr=False)
    order_id: str
    items: dict[str, int]
    currency: str
    total_minor_units: int


def verify_signature(body: bytes, signature: str, secret: str) -> bool:
    if not secret or not signature.isascii():
        return False
    expected = base64.b64encode(hmac.digest(secret.encode(), body, "sha256"))
    return hmac.compare_digest(signature.encode("ascii"), expected)


def _presentment_total(order: dict) -> tuple[str, int] | None:
    price = order.get("total_price_set")
    money = price.get("presentment_money") if isinstance(price, dict) else None
    if not isinstance(money, dict):
        return None
    currency, amount = money.get("currency_code"), money.get("amount")
    if (
        not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency)
        or not isinstance(amount, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", amount)
    ):
        return None
    try:
        exponent = Currency(currency).exponent
        if exponent is None:
            return None
        # An approved amount has at most 13 digits in minor units.
        context = Context(prec=13, traps=[Inexact, InvalidOperation])
        scaled = Decimal(amount).scaleb(exponent, context=context)
    except (ValueError, Inexact, InvalidOperation):
        return None
    if not 0 < scaled <= 10**12 or scaled != scaled.to_integral_value():
        return None
    return currency, int(scaled)


def read_order_receipt(body: bytes) -> OrderReceipt | None:
    try:
        order = json.loads(body)
    except (ValueError, RecursionError):
        return None
    if not isinstance(order, dict) or order.get("test") is not True:
        return None
    token = order.get("checkout_token")
    order_id = order.get("admin_graphql_api_id")
    lines = order.get("line_items")
    if (
        not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", token)
        or not isinstance(order_id, str) or not ORDER_ID.fullmatch(order_id)
        or not isinstance(lines, list) or not lines
    ):
        return None
    items: dict[str, int] = {}
    for line in lines:
        if not isinstance(line, dict) or type(line.get("variant_id")) is not int:
            return None
        variant = str(line["variant_id"])
        quantity = line.get("quantity")
        if not VARIANT_ID.fullmatch(variant) or type(quantity) is not int or quantity < 1:
            return None
        items[variant] = items.get(variant, 0) + quantity
    total = _presentment_total(order)
    return OrderReceipt(token, order_id, items, *total) if total else None
