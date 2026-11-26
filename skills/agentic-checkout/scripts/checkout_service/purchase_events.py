"""Bind verified Shopify events to receipts and deliver the private purchase event stream."""

import asyncio
import hashlib
import hmac
import json
import logging
import sqlite3
from urllib.parse import urlsplit

import httpx

from .attempts import checkout_digest, order_binding
from .purchase_store import PurchaseNotFound, encode
from .reconciliation import read_order_receipt

LOGGER = logging.getLogger(__name__)


def apply_shopify_event(purchases, attempts, shop, host, topic, raw):
    if topic.startswith("orders/"):
        receipt = read_order_receipt(raw)
        if receipt is None:
            return
        binding = order_binding(host, receipt.items, receipt.total_minor_units, receipt.currency)
        approval_id = attempts.record_order(checkout_digest(receipt.checkout_token), binding, receipt.order_id)
        if approval_id:
            try:
                purchases.synchronize(approval_id)
            except PurchaseNotFound:
                pass
        purchases.order_update(shop, receipt.order_id, "paid" if topic == "orders/paid" else "placed")
        return

    try:
        fulfillment = json.loads(raw)
    except (ValueError, RecursionError):
        return
    if not isinstance(fulfillment, dict):
        return
    order_id = fulfillment.get("order_id")
    if type(order_id) is not int or order_id <= 0 or fulfillment.get("status") != "success":
        return
    numbers, urls = fulfillment.get("tracking_numbers"), fulfillment.get("tracking_urls")
    numbers = numbers[:50] if isinstance(numbers, list) else []
    urls = urls[:50] if isinstance(urls, list) else []
    company = fulfillment.get("tracking_company")
    tracking = []
    for index in range(max(len(numbers), len(urls))):
        entry = {"company": company} if isinstance(company, str) and len(company) <= 100 else {}
        if index < len(numbers) and isinstance(numbers[index], str) and len(numbers[index]) <= 100:
            entry["number"] = numbers[index]
        if index < len(urls) and isinstance(urls[index], str) and len(urls[index]) <= 2048:
            try:
                url = urlsplit(urls[index])
                if url.scheme == "https" and url.hostname and not url.username and not url.password:
                    entry["url"] = urls[index]
            except ValueError:
                pass
        if "number" in entry or "url" in entry:
            tracking.append(entry)
    purchases.order_update(shop, f"gid://shopify/Order/{order_id}", "shipped", tracking)


class EventDelivery:
    def __init__(self, purchases, url, secret):
        parsed = urlsplit(url)
        if (parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password
                or parsed.fragment or (parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "::1"})
                or len(secret) < 32):
            raise ValueError("Configure a private event callback with a strong signing secret.")
        self.purchases = purchases
        self.url = url
        self.secret = secret.encode()
        self.sink = hashlib.sha256(url.encode()).hexdigest()

    async def run(self, stop):
        # An acknowledgement can be lost. Consumers deduplicate using the durable event ID.
        retry = 1
        async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
            while not stop.is_set():
                try:
                    event = await asyncio.to_thread(self.purchases.next_delivery, self.sink)
                    if event:
                        body = encode(event).encode()
                        response = await client.post(self.url, content=body, headers={
                            "Content-Type": "application/json",
                            "X-FluxA-Event-ID": str(event["id"]),
                            "X-FluxA-Signature": hmac.digest(self.secret, body, "sha256").hex(),
                        })
                        response.raise_for_status()
                        await asyncio.to_thread(self.purchases.mark_delivered, self.sink, event["id"])
                        retry = 1
                        continue
                except (httpx.HTTPError, sqlite3.OperationalError):
                    LOGGER.warning("Purchase callback is pending delivery.")
                    retry = min(retry * 2, 60)
                try:
                    await asyncio.wait_for(stop.wait(), timeout=retry)
                except TimeoutError:
                    pass
