#!/usr/bin/env python3
"""General checkout runner with Playwright automation and handoff signals."""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

try:  # pragma: no cover - runtime integration
    from dotenv import load_dotenv
except Exception:  # pragma: no cover
    load_dotenv = None


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from shopify.checkout import run_checkout_flow
from shopify.candidates import normalize_candidates
from shopify.navigation import run_navigation_playwright_fallback
from shopify.results import default_payload, normalize_checkout_state
from shopify.runtime import (
    Config,
    build_sensitive_data,
    get_env,
    json_dumps,
    load_secrets,
    normalize_text,
    parse_bool,
    resolve_path,
    resolve_proxy_settings,
)
from order_store import OrderStore


SCRIPT_VERSION = "checkout_playwright_handoff@v3"
SKILL_ROOT = SCRIPT_DIR.parent

STRIPE_HOSTS = ("checkout.stripe.com", "buy.stripe.com", "billing.stripe.com")
SHOPIFY_HOST_MARKERS = ("myshopify.com", "shopify.com")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the general checkout Playwright flow with structured handoff results.")
    parser.add_argument("--query", default=None)
    parser.add_argument("--entry-url", action="append", default=[])
    parser.add_argument("--entry-urls-json", default=None)
    parser.add_argument("--product-url", action="append", default=[])
    parser.add_argument("--candidate-urls-json", default=None)
    parser.add_argument("--mode", choices=["preview", "execute"], default=None)
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--secrets-path", default=None)
    parser.add_argument("--user-data-dir", default=None)
    parser.add_argument("--fresh-profile", action="store_true")
    parser.add_argument("--out-dir", default=None)
    parser.add_argument("--record-trace", action="store_true")
    parser.add_argument("--record-video", action="store_true")
    parser.add_argument("--browser-channel", default=None)
    parser.add_argument("--max-run-seconds", type=int, default=None)
    parser.add_argument("--max-total-usd", type=float, default=None)
    parser.add_argument("--keep-open-seconds", type=float, default=None)
    parser.add_argument("--action-delay-seconds", type=float, default=None)
    parser.add_argument("--manual-verification-timeout-seconds", type=int, default=None)
    parser.add_argument("--proxy-server", default=None)
    parser.add_argument("--proxy-bypass", default=None)
    parser.add_argument("--proxy-username", default=None)
    parser.add_argument("--proxy-password", default=None)
    parser.add_argument("--confirm-delivery", action="store_true")
    parser.add_argument("--confirm-legal-consent", action="store_true")
    parser.add_argument("--resident-id-number", default=None)
    parser.add_argument("--record-order-on-success", action="store_true")
    parser.add_argument("--no-record-order-on-success", dest="record_order_on_success", action="store_false")
    parser.set_defaults(record_order_on_success=None)
    parser.add_argument("--order-label", default=None)
    parser.add_argument("--order-note", default=None)
    parser.add_argument("--order-currency", default=None)
    parser.add_argument("--order-store-dir", default=None)
    return parser


def resolve_entry_urls_json(args: argparse.Namespace) -> str:
    explicit = (
        getattr(args, "entry_urls_json", None)
        or getattr(args, "candidate_urls_json", None)
        or get_env("ENTRY_URLS_JSON")
        or get_env("CANDIDATE_URLS_JSON")
    )
    if explicit:
        return explicit

    raw_urls = [value.strip() for value in getattr(args, "entry_url", []) if str(value or "").strip()]
    raw_urls.extend(value.strip() for value in getattr(args, "product_url", []) if str(value or "").strip())
    for env_name in ("ENTRY_URL", "PRODUCT_URL"):
        env_value = str(get_env(env_name, "") or "").strip()
        if env_value:
            raw_urls.append(env_value)

    if raw_urls:
        deduped = []
        seen = set()
        for url in raw_urls:
            if url in seen:
                continue
            seen.add(url)
            deduped.append(url)
        return json.dumps(deduped, ensure_ascii=False)

    raise ValueError("Provide --entry-url, ENTRY_URL, --entry-urls-json, or the legacy product/candidate URL flags.")


def normalize_entry_candidates(raw_candidates: str) -> list[dict[str, str]]:
    return normalize_candidates(raw_candidates)


def is_shopify_like_url(url: str) -> bool:
    lowered = str(url or "").lower()
    return any(marker in lowered for marker in SHOPIFY_HOST_MARKERS) or any(
        token in lowered for token in ("/products/", "/collections/", "/cart", "/checkout", "/checkouts/")
    )


def is_direct_checkout_like_url(url: str) -> bool:
    lowered = str(url or "").lower()
    return (
        any(host in lowered for host in STRIPE_HOSTS)
        or "/checkout" in lowered
        or "/checkouts/" in lowered
        or looks_like_cart_checkout_url(lowered)
    )


def looks_like_cart_checkout_url(url: str) -> bool:
    lowered = str(url or "").lower()
    return bool(re.search(r"/cart/[^/?#]+:\d", lowered))


def choose_route(entry_candidates: list[dict[str, str]]) -> str:
    first_url = entry_candidates[0]["url"] if entry_candidates else ""
    if is_shopify_like_url(first_url) and not is_direct_checkout_like_url(first_url):
        return "shopify_navigation"
    return "direct_checkout"


def build_direct_navigation_result(entry_candidate: dict[str, str]) -> dict[str, object]:
    entry_url = entry_candidate["url"]
    cart_checkout = looks_like_cart_checkout_url(entry_url)
    payload = default_payload()
    payload.update(
        {
            "entryUrl": entry_url,
            "candidateChosen": entry_url,
            "productUrl": None if cart_checkout else entry_url,
            "checkoutUrl": entry_url,
            "hint": "Direct checkout-like surface provided; attempting in-place autofill before any handoff.",
            "outcome": {"status": "checkout_reached", "hint": "Direct checkout-like surface provided."},
        }
    )
    return {
        "navigation": payload,
        "artifacts": {
            "conversation": None,
            "screenshots": [],
            "urls": [entry_url],
            "errors": [],
            "rankedCandidates": [entry_candidate],
            "method": "direct_checkout",
        },
    }


def resolve_config(args: argparse.Namespace) -> Config:
    query = args.query or get_env("QUERY", "checkout preview")
    candidate_urls_json = resolve_entry_urls_json(args)
    mode = args.mode or get_env("MODE", "preview")
    headed = True if args.headed else False
    if not args.headed and not args.headless:
        headed = parse_bool(get_env("HEADED"), False)
    if args.headless:
        headed = False

    secrets_raw = args.secrets_path or get_env("SECRETS_PATH")
    if not secrets_raw:
        raise ValueError("SECRETS_PATH is required.")

    user_data_dir_value = args.user_data_dir or get_env("USER_DATA_DIR")
    user_data_dir = resolve_path(user_data_dir_value) if user_data_dir_value else None
    fresh_profile = True if args.fresh_profile else parse_bool(get_env("FRESH_PROFILE"), True)
    out_dir = resolve_path(args.out_dir or get_env("OUT_DIR", "artifacts/agentic-checkout"))
    record_trace = True if args.record_trace else parse_bool(get_env("RECORD_TRACE"), False)
    record_video = True if args.record_video else parse_bool(get_env("RECORD_VIDEO"), False)
    browser_channel = args.browser_channel or get_env("BROWSER_CHANNEL")
    max_run_seconds = args.max_run_seconds or int(get_env("MAX_RUN_SECONDS", 600))
    max_total_usd = args.max_total_usd if args.max_total_usd is not None else float(get_env("MAX_TOTAL_USD", 10))
    keep_open_seconds = args.keep_open_seconds if args.keep_open_seconds is not None else float(get_env("KEEP_OPEN_SECONDS", 0))
    action_delay_seconds = (
        args.action_delay_seconds
        if args.action_delay_seconds is not None
        else float(get_env("ACTION_DELAY_SECONDS", 1.0 if headed else 0.4))
    )
    manual_verification_timeout_seconds = (
        args.manual_verification_timeout_seconds
        if args.manual_verification_timeout_seconds is not None
        else int(get_env("MANUAL_VERIFICATION_TIMEOUT_SECONDS", 300))
    )
    proxy_server, proxy_bypass, proxy_username, proxy_password = resolve_proxy_settings(args)
    confirm_delivery = True if getattr(args, "confirm_delivery", False) else parse_bool(get_env("CONFIRM_DELIVERY"), False)
    confirm_legal_consent = (
        True if getattr(args, "confirm_legal_consent", False) else parse_bool(get_env("CONFIRM_LEGAL_CONSENT"), False)
    )
    resident_id_number = normalize_text(getattr(args, "resident_id_number", None) or get_env("RESIDENT_ID_NUMBER"))
    record_order_on_success = (
        args.record_order_on_success
        if getattr(args, "record_order_on_success", None) is not None
        else parse_bool(get_env("RECORD_ORDER_ON_SUCCESS"), default=(mode == "execute"))
    )
    order_label = getattr(args, "order_label", None) or get_env("ORDER_LABEL")
    order_note = getattr(args, "order_note", None) or get_env("ORDER_NOTE")
    order_currency = getattr(args, "order_currency", None) or get_env("ORDER_CURRENCY", "USD")
    order_store_dir_value = getattr(args, "order_store_dir", None) or get_env("CHECKOUT_HANDOFF_ORDER_DIR")
    order_store_dir = resolve_path(order_store_dir_value) if order_store_dir_value else SKILL_ROOT / "data" / "paid_orders"

    return Config(
        query=query,
        candidate_urls_json=candidate_urls_json,
        mode=mode,
        secrets_path=resolve_path(secrets_raw),
        out_dir=out_dir,
        user_data_dir=user_data_dir,
        fresh_profile=fresh_profile,
        headed=headed,
        use_vision=False,
        record_trace=record_trace,
        record_video=record_video,
        browser_channel=browser_channel,
        max_run_seconds=max_run_seconds,
        max_total_usd=max_total_usd,
        keep_open_seconds=keep_open_seconds,
        action_delay_seconds=action_delay_seconds,
        manual_verification_timeout_seconds=manual_verification_timeout_seconds,
        llm_provider="playwright_only",
        browser_use_model="",
        openai_model="",
        max_steps=0,
        proxy_server=proxy_server,
        proxy_bypass=proxy_bypass,
        proxy_username=proxy_username,
        proxy_password=proxy_password,
        confirm_delivery=confirm_delivery,
        confirm_legal_consent=confirm_legal_consent,
        resident_id_number=resident_id_number or None,
        record_order_on_success=record_order_on_success,
        order_label=order_label,
        order_note=order_note,
        order_currency=order_currency,
        order_store_dir=order_store_dir,
    )


def _order_label_from_result(config: Config, result: dict[str, object]) -> str:
    explicit = str(config.order_label or "").strip()
    if explicit:
        return explicit
    for key in ("selectionLabel", "giftCardDenomination", "query"):
        value = result.get(key)
        if str(value or "").strip():
            return str(value).strip()
    store_domain = str(result.get("storeDomain") or "").strip()
    provider = str(result.get("provider") or "").strip()
    if store_domain and provider:
        return f"{store_domain} checkout via {provider}"
    if store_domain:
        return f"{store_domain} checkout purchase"
    return "checkout purchase"


def record_paid_order_if_needed(config: Config, result: dict[str, object]) -> dict[str, object] | None:
    if not config.record_order_on_success:
        return None
    if config.mode != "execute":
        return None
    if result.get("phase") != "execute_success":
        return None

    try:
        store = OrderStore(config.order_store_dir)
        order_record = store.save_paid_order(
            {
                "order_id": f"CHK-{result['runId']}",
                "product": _order_label_from_result(config, result),
                "price": result.get("displayedTotal"),
                "currency": config.order_currency,
                "merchant": result.get("storeDomain"),
                "provider": result.get("provider"),
                "route": result.get("route"),
                "purchase_reason": result.get("hint"),
                "note": config.order_note or result.get("hint"),
                "paid_at": result.get("finishedAt"),
                "metadata": {
                    "scriptVersion": result.get("scriptVersion"),
                    "runId": result.get("runId"),
                    "query": result.get("query"),
                    "entryUrl": result.get("entryUrl"),
                    "candidateChosen": result.get("candidateChosen"),
                    "productUrl": result.get("productUrl"),
                    "checkoutUrl": result.get("checkoutUrl"),
                    "filledCheckoutScreenshot": result.get("filledCheckoutScreenshot"),
                    "handoffRequired": result.get("handoffRequired"),
                    "outcome": result.get("outcome"),
                },
            }
        )
    except Exception as exc:
        result["orderRecorded"] = False
        result["orderRecordError"] = str(exc)
        return None

    result["orderRecorded"] = True
    result["orderId"] = order_record["order_id"]
    result["orderPath"] = str(store.order_path(order_record["order_id"]))
    result["orderStorageDir"] = str(store.root_dir)
    result["orderRecord"] = order_record
    return order_record


async def run_flow(
    config: Config,
    sensitive_data: dict[str, str],
    user_data_dir: Path | None,
    run_id: str,
    traces_dir: Path,
    videos_dir: Path | None,
    conversations_dir: Path,
) -> tuple[dict[str, object], dict[str, object], str]:
    entry_candidates = normalize_entry_candidates(config.candidate_urls_json)
    if not entry_candidates:
        final_payload = normalize_checkout_state(config.mode, default_payload(), max_total_usd=config.max_total_usd)
        return (
            final_payload,
            {"artifacts": {"conversation": None, "screenshots": [], "urls": [], "errors": [], "rankedCandidates": [], "method": "none"}},
            "none",
        )

    route = choose_route(entry_candidates)
    if route == "shopify_navigation":
        navigation_result = await run_navigation_playwright_fallback(
            config=config,
            run_id=run_id,
            user_data_dir=user_data_dir,
            traces_dir=traces_dir,
            videos_dir=videos_dir,
            conversations_dir=conversations_dir,
            ranked_candidates=entry_candidates[:3],
            fallback_reason="checkout_playwright_handoff",
        )
    else:
        navigation_result = build_direct_navigation_result(entry_candidates[0])

    navigation_payload = navigation_result["navigation"]
    navigation_status = navigation_payload.get("outcome", {}).get("status")
    if navigation_status in {"no_shopify_candidate", "candidate_selected", "product_selected", "needs_manual_verification"}:
        final_payload = normalize_checkout_state(config.mode, navigation_payload, max_total_usd=config.max_total_usd)
        return final_payload, navigation_result, route

    final_payload = await run_checkout_flow(
        config=config,
        navigation_payload=navigation_payload,
        sensitive_data=sensitive_data,
        user_data_dir=user_data_dir,
        run_id=run_id,
        traces_dir=traces_dir,
        videos_dir=videos_dir,
        runtime=navigation_result.get("runtime"),
    )
    return final_payload, navigation_result, route


async def async_main() -> int:
    if load_dotenv is not None:
        load_dotenv()
    parser = build_parser()
    args = parser.parse_args()
    try:
        config = resolve_config(args)
        secrets = load_secrets(config.secrets_path)
        sensitive_data = build_sensitive_data(secrets)
        if config.resident_id_number:
            sensitive_data["resident_id_number"] = config.resident_id_number
        if config.mode == "execute" and sensitive_data.get("delivery_name") and not config.confirm_delivery:
            raise ValueError("Execute mode requires explicit delivery confirmation. Re-run with --confirm-delivery after the user confirms the Delivery information.")
    except Exception as exc:
        result = {
            "ok": False,
            "phase": "config_error",
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "scriptVersion": SCRIPT_VERSION,
            "userMessage": "Checkout cannot start yet because required information is missing or the local setup is not ready. Once the missing details are provided, I can continue from there.",
            "hint": str(exc),
        }
        print(json_dumps(result))
        return 1

    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    run_id = str(int(time.time() * 1000))
    out_dir = config.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    traces_dir = out_dir / "traces"
    conversations_dir = out_dir / "conversations"
    traces_dir.mkdir(parents=True, exist_ok=True)
    conversations_dir.mkdir(parents=True, exist_ok=True)
    videos_dir = out_dir / "videos" / run_id if config.record_video else None
    if videos_dir:
        videos_dir.mkdir(parents=True, exist_ok=True)

    temp_profile_dir: Path | None = None
    user_data_dir = config.user_data_dir
    if config.fresh_profile:
        temp_profile_dir = Path(tempfile.mkdtemp(prefix="agentic-checkout-"))
        user_data_dir = temp_profile_dir
    elif user_data_dir:
        user_data_dir.mkdir(parents=True, exist_ok=True)

    try:
        final_payload, navigation_result, route = await asyncio.wait_for(
            run_flow(
                config=config,
                sensitive_data=sensitive_data,
                user_data_dir=user_data_dir,
                run_id=run_id,
                traces_dir=traces_dir,
                videos_dir=videos_dir,
                conversations_dir=conversations_dir,
            ),
            timeout=config.max_run_seconds,
        )
        result = {
            "ok": final_payload["phase"] in {"preview_complete", "execute_success"},
            "phase": final_payload["phase"],
            "startedAt": started_at,
            "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "scriptVersion": SCRIPT_VERSION,
            "runId": run_id,
            "mode": config.mode,
            "query": config.query,
            "route": route,
            "entryUrl": final_payload.get("entryUrl"),
            "candidateChosen": final_payload["candidateChosen"],
            "storeDomain": final_payload["storeDomain"],
            "productUrl": final_payload["productUrl"],
            "checkoutUrl": final_payload["checkoutUrl"],
            "provider": final_payload["provider"],
            "displayedTotal": final_payload["displayedTotal"],
            "selectionLabel": final_payload.get("selectionLabel"),
            "giftCardDenomination": final_payload["giftCardDenomination"],
            "contactFilled": final_payload["contactFilled"],
            "deliveryFilled": final_payload.get("deliveryFilled"),
            "billingIdentityFilled": final_payload.get("billingIdentityFilled"),
            "postalFilled": final_payload["postalFilled"],
            "residentIdFilled": final_payload.get("residentIdFilled"),
            "paymentFieldVerification": final_payload.get("paymentFieldVerification"),
            "legalConsentChecked": final_payload.get("legalConsentChecked"),
            "saveInfoUnchecked": final_payload["saveInfoUnchecked"],
            "handoffRequired": final_payload.get("handoffRequired", False),
            "handoffReason": final_payload.get("handoffReason"),
            "userMessage": final_payload.get("userMessage"),
            "filledCheckoutScreenshot": final_payload.get("filledCheckoutScreenshot"),
            "hint": final_payload["hint"],
            "outcome": final_payload["outcome"],
            "traceDir": str(traces_dir) if config.record_trace else None,
            "videoDir": str(videos_dir) if config.record_video and videos_dir else None,
            "userDataDirUsed": str(user_data_dir) if user_data_dir else None,
            "freshProfileUsed": config.fresh_profile,
            "navigationArtifacts": navigation_result["artifacts"],
            "orderRecorded": False,
        }
        record_paid_order_if_needed(config, result)
    except asyncio.TimeoutError:
        result = {
            "ok": False,
            "phase": "timeout",
            "startedAt": started_at,
            "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "scriptVersion": SCRIPT_VERSION,
            "runId": run_id,
            "mode": config.mode,
            "query": config.query,
            "route": "unknown",
            **default_payload(),
            "userMessage": f"I have been working on this for a while, but the page still could not complete this step within {config.max_run_seconds} seconds. You can try again later, or send me the current page link so I can keep investigating.",
            "hint": f"Checkout run exceeded MAX_RUN_SECONDS={config.max_run_seconds}.",
            "traceDir": str(traces_dir) if config.record_trace else None,
            "videoDir": str(videos_dir) if config.record_video and videos_dir else None,
            "orderRecorded": False,
        }
    except Exception as exc:
        result = {
            "ok": False,
            "phase": "exception",
            "startedAt": started_at,
            "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "scriptVersion": SCRIPT_VERSION,
            "runId": run_id,
            "mode": config.mode,
            "query": config.query,
            "route": "unknown",
            **default_payload(),
            "userMessage": "The page encountered an unexpected issue while continuing the checkout, so I could not complete this step for you yet. Send me the link and I can continue investigating.",
            "hint": str(exc),
            "traceDir": str(traces_dir) if config.record_trace else None,
            "videoDir": str(videos_dir) if config.record_video and videos_dir else None,
            "orderRecorded": False,
        }
    finally:
        if config.keep_open_seconds > 0:
            await asyncio.sleep(config.keep_open_seconds)
        if temp_profile_dir:
            shutil.rmtree(temp_profile_dir, ignore_errors=True)

    result_path = out_dir / f"result-{run_id}.json"
    latest_path = out_dir / "result-latest.json"
    result_path.write_text(json_dumps(result) + "\n", encoding="utf-8")
    latest_path.write_text(json_dumps(result) + "\n", encoding="utf-8")
    print(json_dumps(result))
    return 0 if result.get("ok") else 1


def main() -> int:
    return asyncio.run(async_main())


if __name__ == "__main__":
    raise SystemExit(main())
