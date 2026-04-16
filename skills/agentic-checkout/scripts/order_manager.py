#!/usr/bin/env python3
"""Manage paid orders recorded by the checkout and shopping skills."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from order_store import OrderStore


if sys.platform == "win32":
    import io

    sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8")
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def _json_print(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def _load_create_payload(args: argparse.Namespace) -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if raw:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON input: {exc}") from exc
        if not isinstance(payload, dict):
            raise ValueError("create expects a JSON object")
        return payload
    return {
        "order_id": args.order_id,
        "product": args.product,
        "price": args.price,
        "currency": args.currency,
        "merchant": args.merchant,
        "provider": args.provider,
        "platform": args.platform,
        "language": args.language,
        "route": args.route,
        "purchase_reason": args.purchase_reason,
        "user_input": args.user_input,
        "source": args.source,
        "note": args.note,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage paid orders stored under data/paid_orders.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    create_parser = subparsers.add_parser("create", help="Create or upsert a paid order record.")
    create_parser.add_argument("--order-id")
    create_parser.add_argument("--product")
    create_parser.add_argument("--price", type=float)
    create_parser.add_argument("--currency")
    create_parser.add_argument("--merchant")
    create_parser.add_argument("--provider")
    create_parser.add_argument("--platform")
    create_parser.add_argument("--language")
    create_parser.add_argument("--route")
    create_parser.add_argument("--purchase-reason")
    create_parser.add_argument("--user-input")
    create_parser.add_argument("--source", default="manual")
    create_parser.add_argument("--note")

    get_parser = subparsers.add_parser("get", help="Get one paid order by local order ID.")
    get_parser.add_argument("--order-id", required=True)

    list_parser = subparsers.add_parser("list", help="List paid orders.")
    list_parser.add_argument("--limit", type=int, default=20)
    list_parser.add_argument("--merchant")
    list_parser.add_argument("--provider")
    list_parser.add_argument("--platform")
    list_parser.add_argument("--status")
    list_parser.add_argument("--payment-status")
    list_parser.add_argument("--language")
    list_parser.add_argument("--keyword")
    list_parser.add_argument("--start-date")
    list_parser.add_argument("--end-date")

    search_parser = subparsers.add_parser("search", help="Search paid orders by keyword.")
    search_parser.add_argument("--keyword", required=True)
    search_parser.add_argument("--limit", type=int, default=20)
    search_parser.add_argument("--merchant")
    search_parser.add_argument("--provider")
    search_parser.add_argument("--platform")
    search_parser.add_argument("--status")
    search_parser.add_argument("--payment-status")
    search_parser.add_argument("--language")

    summary_parser = subparsers.add_parser("summary", help="Summarize paid orders.")
    summary_parser.add_argument("--days", type=int)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    store = OrderStore()

    try:
        if args.command == "create":
            order = store.save_paid_order(_load_create_payload(args))
            _json_print({"ok": True, "order": order, "storage_dir": str(store.root_dir)})
            return 0

        if args.command == "get":
            order = store.get_order(args.order_id)
            if order is None:
                _json_print({"ok": False, "error": f"Order not found: {args.order_id}", "storage_dir": str(store.root_dir)})
                return 1
            _json_print({"ok": True, "order": order, "storage_dir": str(store.root_dir)})
            return 0

        if args.command == "list":
            orders = store.list_orders(
                limit=args.limit,
                merchant=args.merchant,
                provider=args.provider,
                platform=args.platform,
                status=args.status,
                payment_status=args.payment_status,
                language=args.language,
                keyword=args.keyword,
                start_date=args.start_date,
                end_date=args.end_date,
            )
            _json_print({"ok": True, "count": len(orders), "orders": orders, "storage_dir": str(store.root_dir)})
            return 0

        if args.command == "search":
            orders = store.search_orders(
                keyword=args.keyword,
                limit=args.limit,
                merchant=args.merchant,
                provider=args.provider,
                platform=args.platform,
                status=args.status,
                payment_status=args.payment_status,
                language=args.language,
            )
            _json_print({"ok": True, "count": len(orders), "orders": orders, "storage_dir": str(store.root_dir)})
            return 0

        if args.command == "summary":
            _json_print({"ok": True, "summary": store.summary(days=args.days), "storage_dir": str(store.root_dir)})
            return 0
    except ValueError as exc:
        _json_print({"ok": False, "error": str(exc), "storage_dir": str(store.root_dir)})
        return 1

    _json_print({"ok": False, "error": f"Unsupported command: {args.command}", "storage_dir": str(store.root_dir)})
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
