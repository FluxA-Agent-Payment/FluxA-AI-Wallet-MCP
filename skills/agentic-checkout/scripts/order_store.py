#!/usr/bin/env python3
"""Filesystem-backed paid-order storage shared by shopping and checkout flows."""

from __future__ import annotations

import json
import os
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


SKILL_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ORDER_DIR = SKILL_ROOT / "data" / "paid_orders"
ORDER_DIR_ENVS = ("CHECKOUT_HANDOFF_ORDER_DIR", "SMART_SHOPPER_ORDER_DIR")


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


def _coerce_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _ensure_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _sanitize_filename(order_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", order_id).strip("._") or "order"


def _matches_keyword(order: dict[str, Any], keyword: str | None) -> bool:
    if not keyword:
        return True
    needle = keyword.lower().strip()
    haystacks = [
        order.get("order_id"),
        order.get("product"),
        order.get("merchant"),
        order.get("provider"),
        order.get("platform"),
        order.get("route"),
        order.get("purchase_reason"),
        order.get("user_input"),
        order.get("source"),
        order.get("note"),
    ]
    metadata = order.get("metadata")
    if metadata:
        haystacks.append(json.dumps(metadata, ensure_ascii=False))
    return any(needle in str(item).lower() for item in haystacks if item)


def _infer_currency(
    language: str | None,
    platform: str | None,
    merchant: str | None,
    currency: str | None,
) -> str:
    if currency:
        return currency.upper()
    if (language or "").lower() == "zh":
        return "CNY"
    source = " ".join(part for part in (platform, merchant) if part).lower()
    if any(token in source for token in ("jd", "taobao", "tmall", "douyin", "pdd")):
        return "CNY"
    return "USD"


class OrderStore:
    """Persist paid checkout orders inside the skill folder or configured override directory."""

    def __init__(self, root_dir: str | os.PathLike[str] | None = None) -> None:
        configured = root_dir
        if not configured:
            for env_name in ORDER_DIR_ENVS:
                env_value = os.environ.get(env_name)
                if env_value:
                    configured = env_value
                    break
        self.root_dir = Path(configured).expanduser() if configured else DEFAULT_ORDER_DIR
        self.root_dir.mkdir(parents=True, exist_ok=True)

    def order_path(self, order_id: str) -> Path:
        return self.root_dir / f"{_sanitize_filename(order_id)}.json"

    def save_paid_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        order_id = _clean_text(payload.get("order_id"))
        product = _clean_text(payload.get("product"))
        if not order_id:
            raise ValueError("order_id is required")
        if not product:
            raise ValueError("product is required")

        existing = self.get_order(order_id)
        now_iso = _now_iso()
        paid_at = _clean_text(payload.get("paid_at")) or (existing or {}).get("paid_at") or now_iso
        price = _coerce_float(payload.get("price"))
        merchant = _clean_text(payload.get("merchant")) or _clean_text(payload.get("store_domain"))
        platform = _clean_text(payload.get("platform")) or (existing or {}).get("platform")
        language = _clean_text(payload.get("language")) or (existing or {}).get("language")

        record = {
            "order_id": order_id,
            "status": _clean_text(payload.get("status")) or (existing or {}).get("status") or "paid",
            "payment_status": _clean_text(payload.get("payment_status")) or (existing or {}).get("payment_status") or "paid",
            "product": product,
            "price": price,
            "currency": _infer_currency(
                language,
                platform,
                merchant or (existing or {}).get("merchant"),
                _clean_text(payload.get("currency")) or (existing or {}).get("currency"),
            ),
            "merchant": merchant or (existing or {}).get("merchant"),
            "provider": _clean_text(payload.get("provider")) or (existing or {}).get("provider"),
            "platform": platform,
            "language": language,
            "route": _clean_text(payload.get("route")) or (existing or {}).get("route"),
            "purchase_reason": _clean_text(payload.get("purchase_reason")) or (existing or {}).get("purchase_reason"),
            "user_input": _clean_text(payload.get("user_input")) or (existing or {}).get("user_input"),
            "source": _clean_text(payload.get("source")) or (existing or {}).get("source") or "manual",
            "note": _clean_text(payload.get("note")) or (existing or {}).get("note"),
            "notes": _ensure_list(payload.get("notes")) or (existing or {}).get("notes") or [],
            "metadata": payload.get("metadata") if isinstance(payload.get("metadata"), dict) else (existing or {}).get("metadata") or {},
            "paid_at": paid_at,
            "created_at": (existing or {}).get("created_at") or now_iso,
            "updated_at": now_iso,
        }

        with self.order_path(order_id).open("w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=False, indent=2)
        return record

    def get_order(self, order_id: str) -> dict[str, Any] | None:
        path = self.order_path(order_id)
        if not path.exists():
            return None
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)

    def list_orders(
        self,
        *,
        limit: int | None = None,
        merchant: str | None = None,
        provider: str | None = None,
        platform: str | None = None,
        status: str | None = None,
        payment_status: str | None = None,
        language: str | None = None,
        keyword: str | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> list[dict[str, Any]]:
        start_dt = _parse_iso(start_date)
        end_dt = _parse_iso(end_date)
        merchant_value = (merchant or "").strip().lower()
        provider_value = (provider or "").strip().lower()
        platform_value = (platform or "").strip().lower()
        status_value = (status or "").strip().lower()
        payment_status_value = (payment_status or "").strip().lower()
        language_value = (language or "").strip().lower()

        orders: list[dict[str, Any]] = []
        for path in self.root_dir.glob("*.json"):
            with path.open("r", encoding="utf-8") as handle:
                order = json.load(handle)
            if merchant_value and (order.get("merchant") or "").lower() != merchant_value:
                continue
            if provider_value and (order.get("provider") or "").lower() != provider_value:
                continue
            if platform_value and (order.get("platform") or "").lower() != platform_value:
                continue
            if status_value and (order.get("status") or "").lower() != status_value:
                continue
            if payment_status_value and (order.get("payment_status") or "").lower() != payment_status_value:
                continue
            if language_value and (order.get("language") or "").lower() != language_value:
                continue
            if not _matches_keyword(order, keyword):
                continue
            paid_at = _parse_iso(order.get("paid_at"))
            if start_dt and (paid_at is None or paid_at < start_dt):
                continue
            if end_dt and (paid_at is None or paid_at > end_dt):
                continue
            orders.append(order)

        orders.sort(
            key=lambda item: (
                _parse_iso(item.get("paid_at")) or datetime.min.replace(tzinfo=timezone.utc),
                item.get("order_id") or "",
            ),
            reverse=True,
        )
        if limit is not None and limit >= 0:
            return orders[:limit]
        return orders

    def search_orders(
        self,
        *,
        keyword: str,
        limit: int | None = None,
        merchant: str | None = None,
        provider: str | None = None,
        platform: str | None = None,
        status: str | None = None,
        payment_status: str | None = None,
        language: str | None = None,
    ) -> list[dict[str, Any]]:
        return self.list_orders(
            keyword=keyword,
            limit=limit,
            merchant=merchant,
            provider=provider,
            platform=platform,
            status=status,
            payment_status=payment_status,
            language=language,
        )

    def summary(self, *, days: int | None = None) -> dict[str, Any]:
        start_date = None
        if days is not None and days > 0:
            start_date = (datetime.now(timezone.utc) - timedelta(days=days)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        orders = self.list_orders(start_date=start_date)

        by_merchant = Counter()
        by_provider = Counter()
        by_platform = Counter()
        by_currency: dict[str, dict[str, Any]] = defaultdict(lambda: {"count": 0, "total_paid": 0.0})
        total_paid = 0.0
        latest_paid_at = None

        for order in orders:
            merchant = order.get("merchant") or "unknown"
            provider = order.get("provider") or "unknown"
            platform = order.get("platform") or "unknown"
            currency = order.get("currency") or "UNKNOWN"
            amount = _coerce_float(order.get("price")) or 0.0

            by_merchant[merchant] += 1
            by_provider[provider] += 1
            by_platform[platform] += 1
            by_currency[currency]["count"] += 1
            by_currency[currency]["total_paid"] += amount
            total_paid += amount

            paid_at = order.get("paid_at")
            if paid_at and (latest_paid_at is None or paid_at > latest_paid_at):
                latest_paid_at = paid_at

        return {
            "count": len(orders),
            "total_paid": round(total_paid, 2),
            "by_merchant": dict(by_merchant),
            "by_provider": dict(by_provider),
            "by_platform": dict(by_platform),
            "by_currency": {
                key: {"count": value["count"], "total_paid": round(value["total_paid"], 2)}
                for key, value in by_currency.items()
            },
            "latest_paid_at": latest_paid_at,
        }
