#!/usr/bin/env python3
"""Deterministic Playwright navigation helpers for Shopify checkout candidates."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urljoin, urlparse
import asyncio
import json
import re

from .adapters.common import click_first_visible, pause
from .candidates import rank_candidates
from .results import default_payload
from .runtime import get_env
from .security import looks_like_security_verification, normalize_text


try:  # pragma: no cover - runtime integration
    from playwright.async_api import async_playwright
except Exception as exc:  # pragma: no cover
    async_playwright = None
    PLAYWRIGHT_IMPORT_ERROR = exc
else:  # pragma: no cover
    PLAYWRIGHT_IMPORT_ERROR = None

try:  # pragma: no cover - runtime integration
    from browser_use import Agent, Browser, BrowserProfile, ChatBrowserUse
    from browser_use.browser.profile import ProxySettings
    from browser_use.llm import ChatOpenAI, ChatOpenRouter
except Exception as exc:  # pragma: no cover
    Agent = Browser = BrowserProfile = ChatBrowserUse = ChatOpenAI = ChatOpenRouter = ProxySettings = None
    BROWSER_USE_IMPORT_ERROR = exc
else:  # pragma: no cover
    BROWSER_USE_IMPORT_ERROR = None


GIFT_CARD_PATTERNS = (
    "gift card",
    "gift-card",
    "giftcard",
    "egift",
    "e-gift",
    "digital gift",
    "gift certificate",
)

MONEY_PATTERN = re.compile(r"(?:US\$|CA\$|CAD\$|USD\$|\$)\s*([0-9]+(?:\.[0-9]{1,2})?)", re.I)
MONEY_LABEL_PATTERN = re.compile(r"(?:(?:US\$|CA\$|CAD\$|USD\$|\$)\s*[0-9]+(?:\.[0-9]{1,2})?(?:\s*(?:USD|CAD))?)", re.I)

ADD_TO_CART_SELECTORS = [
    "button[data-testid='pdp-atc-button']",
    "button[data-testid='pdp-add-to-cart-button']",
    "button:has-text('Add to cart')",
    "button:has-text('Add to Cart')",
    "button:has-text('Add to bag')",
    "button:has-text('Add to basket')",
    "button[name='add']",
    "input[type='submit'][value*='Add to cart' i]",
]

CHECKOUT_SELECTORS = [
    "button:has-text('Check out')",
    "a:has-text('Check out')",
    "button:has-text('Checkout')",
    "a:has-text('Checkout')",
    "button:has-text('CHECKOUT')",
    "a:has-text('CHECKOUT')",
    "#cart-drawer-checkout-button",
    "button[name='checkout']",
    "input[type='submit'][name='checkout']",
]

COOKIE_DISMISS_SELECTORS = [
    "button:has-text('Accept Cookies')",
    "button:has-text('Accept')",
    "button:has-text('Accept all')",
    "button:has-text('I agree')",
    "button:has-text('Got it')",
    "button:has-text('Close')",
]

GENERIC_DISMISS_SELECTORS = [
    "button[aria-label*='close' i]",
    "button[title*='close' i]",
    "button:has-text('No thanks')",
    "button:has-text('Not now')",
    "button:has-text('Dismiss')",
    "button:has-text('Skip')",
    "button:has-text('Continue shopping')",
    "[role='button'][aria-label*='close' i]",
    ".modal button.close",
    ".popup button.close",
    ".drawer button.close",
    ".mfp-close",
    "[data-close]",
]

GEOFENCING_MODAL_SELECTOR = "[data-testid='geofencing-modal']"

STATUS_PRIORITY = {
    "no_shopify_candidate": 0,
    "candidate_selected": 1,
    "product_selected": 2,
    "checkout_reached": 3,
    "needs_manual_verification": 4,
}


def build_allowed_domains(candidates: list[dict[str, Any]]) -> list[str]:
    allowed = {
        "checkout.shopify.com",
        "pay.shopify.com",
        "shop.app",
        "shopify.com",
        "cdn.shopify.com",
        "js.stripe.com",
        "hooks.stripe.com",
        "m.stripe.network",
        "stripe.com",
    }
    for candidate in candidates:
        host = urlparse(candidate.get("url") or "").netloc.lower()
        if host:
            allowed.add(host)
    return sorted(allowed)


def build_navigation_task(config: Any, candidates: list[dict[str, Any]]) -> str:
    candidate_lines = "\n".join(f"- {item['url']}" for item in candidates)
    mode_instruction = (
        "6. Stop after you reach the checkout page and confirm a payment provider is visible. Do not submit payment.\n"
    )
    if config.mode == "execute":
        mode_instruction = (
            "6. Stop after you reach the checkout page and confirm a payment provider is visible. Do not submit payment; the deterministic adapter will handle submit.\n"
        )
    return (
        "Do this Shopify checkout discovery flow.\n"
        f"1. The user query is: {config.query}\n"
        "2. Try these Shopify candidates in order until one works:\n"
        f"{candidate_lines}\n"
        "3. For each candidate, confirm it is a Shopify storefront page that can reach a standard checkout.\n"
        "4. Prefer the direct product page. If you land on a collection or homepage, open a product page.\n"
        "5. If the page shows purchasable options with visible price labels, choose the lowest-priced visible option; otherwise keep the default option. Then add to cart and continue to checkout.\n"
        f"{mode_instruction}"
        "7. If no candidate works, return no_shopify_candidate.\n"
        "8. If Cloudflare, CAPTCHA, Shop Pay login wall, or another manual challenge blocks progress, return needs_manual_verification.\n"
        "9. Final response must be a single JSON object only with keys: status, hint, candidate_chosen, store_domain, product_url, checkout_url, gift_card_denomination, current_url.\n"
        "10. status must be exactly one of: no_shopify_candidate, candidate_selected, product_selected, checkout_reached, needs_manual_verification, unknown.\n"
    )


def extract_json_object(text: str | None) -> dict[str, Any] | None:
    if not text:
        return None
    text = text.strip()
    if not text:
        return None
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def is_checkout_url(url: str | None) -> bool:
    lowered = normalize_text(url).lower()
    return bool(
        lowered
        and (
            "/checkouts/" in lowered
            or lowered.rstrip("/").endswith("/checkout")
            or "checkout.shopify.com" in lowered
            or "pay.shopify.com" in lowered
        )
    )


def looks_like_gift_card(value: Any) -> bool:
    lowered = normalize_text(value).lower()
    return any(pattern in lowered for pattern in GIFT_CARD_PATTERNS)


def parse_money_amount(value: Any) -> float | None:
    match = MONEY_PATTERN.search(normalize_text(value))
    if not match:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


def normalize_selection_label(value: Any) -> str | None:
    text = normalize_text(value)
    if not text:
        return None
    money_matches = MONEY_LABEL_PATTERN.findall(text)
    if money_matches:
        return normalize_text(money_matches[0])
    segments = [segment.strip() for segment in re.split(r"\s{2,}|[|/]", text) if segment.strip()]
    return segments[0] if segments else text


def normalize_navigation_result(raw: dict[str, Any] | None, candidate_urls: list[str], history: Any = None) -> dict[str, Any]:
    payload = default_payload()
    parsed = raw or {}
    payload.update(
        {
            "entryUrl": parsed.get("entry_url") or parsed.get("candidate_chosen"),
            "candidateChosen": parsed.get("candidate_chosen"),
            "storeDomain": parsed.get("store_domain"),
            "productUrl": parsed.get("product_url"),
            "checkoutUrl": parsed.get("checkout_url"),
            "giftCardDenomination": normalize_selection_label(parsed.get("gift_card_denomination")),
            "hint": parsed.get("hint") or "",
            "outcome": {"status": parsed.get("status") or "unknown", "hint": parsed.get("hint") or None},
        }
    )
    current_url = parsed.get("current_url")
    urls = history.urls() if history else []
    current_url = current_url or (urls[-1] if urls else None)

    if not payload["candidateChosen"]:
        for url in urls:
            if url in candidate_urls:
                payload["candidateChosen"] = url
                break
        if not payload["candidateChosen"] and candidate_urls:
            payload["candidateChosen"] = candidate_urls[0]
    if not payload["storeDomain"]:
        source_url = payload["checkoutUrl"] or payload["productUrl"] or current_url or payload["candidateChosen"]
        payload["storeDomain"] = urlparse(source_url or "").netloc.lower() or None

    status = payload["outcome"]["status"]
    checkout_url = payload["checkoutUrl"] or current_url
    product_url = payload["productUrl"] or current_url
    if status not in {"needs_manual_verification", "no_shopify_candidate"} and is_checkout_url(checkout_url):
        status = "checkout_reached"
        payload["checkoutUrl"] = payload["checkoutUrl"] or checkout_url
    elif status == "unknown":
        if product_url and "/products/" in product_url:
            status = "product_selected"
            payload["productUrl"] = payload["productUrl"] or product_url
        elif payload["candidateChosen"]:
            status = "candidate_selected"
        else:
            status = "no_shopify_candidate"

    payload["outcome"]["status"] = status
    return payload


def resolve_llm(config: Any):
    provider = config.llm_provider
    if provider == "browser-use" or (provider == "auto" and get_env("BROWSER_USE_API_KEY")):
        api_key = get_env("BROWSER_USE_API_KEY")
        if not api_key:
            raise ValueError("BROWSER_USE_API_KEY is required when using the browser-use provider.")
        return ChatBrowserUse(model=config.browser_use_model, api_key=api_key)
    if provider == "openrouter" or (provider == "auto" and get_env("OPENROUTER_API_KEY")):
        api_key = get_env("OPENROUTER_API_KEY")
        if not api_key:
            raise ValueError("OPENROUTER_API_KEY is required when using the OpenRouter provider.")
        return ChatOpenRouter(
            model=get_env("OPENROUTER_MODEL", "openai/gpt-4.1-mini"),
            api_key=api_key,
            base_url=get_env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
            temperature=0,
        )
    api_key = get_env("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required when using the OpenAI provider.")
    return ChatOpenAI(
        model=config.openai_model,
        api_key=api_key,
        base_url=get_env("OPENAI_BASE_URL"),
        temperature=0,
    )


def _proxy_settings(config: Any) -> dict[str, str] | None:
    if not getattr(config, "proxy_server", None):
        return None
    proxy: dict[str, str] = {"server": config.proxy_server}
    if getattr(config, "proxy_bypass", None):
        proxy["bypass"] = config.proxy_bypass
    if getattr(config, "proxy_username", None):
        proxy["username"] = config.proxy_username
    if getattr(config, "proxy_password", None):
        proxy["password"] = config.proxy_password
    return proxy


def _build_payload(
    status: str,
    *,
    candidate_url: str | None,
    current_url: str | None,
    product_url: str | None = None,
    checkout_url: str | None = None,
    denomination: str | None = None,
    hint: str = "",
) -> dict[str, Any]:
    payload = default_payload()
    source_url = checkout_url or product_url or current_url or candidate_url
    payload.update(
        {
            "entryUrl": candidate_url,
            "candidateChosen": candidate_url,
            "storeDomain": urlparse(source_url or "").netloc.lower() or None,
            "productUrl": product_url,
            "checkoutUrl": checkout_url,
            "giftCardDenomination": normalize_selection_label(denomination),
            "hint": hint,
            "outcome": {"status": status, "hint": hint or None},
        }
    )
    return payload


def _better_payload(current: dict[str, Any] | None, candidate: dict[str, Any]) -> dict[str, Any]:
    if current is None:
        return candidate
    current_status = current.get("outcome", {}).get("status", "no_shopify_candidate")
    candidate_status = candidate.get("outcome", {}).get("status", "no_shopify_candidate")
    if STATUS_PRIORITY.get(candidate_status, -1) > STATUS_PRIORITY.get(current_status, -1):
        return candidate
    return current


def _select_candidate_for_url(current_url: str | None, ranked_candidates: list[dict[str, Any]]) -> str | None:
    normalized_url = normalize_text(current_url)
    if not normalized_url:
        return ranked_candidates[0]["url"] if ranked_candidates else None
    current_host = urlparse(normalized_url).netloc.lower()
    for candidate in ranked_candidates:
        candidate_url = normalize_text(candidate.get("url"))
        if candidate_url == normalized_url:
            return candidate_url
    for candidate in ranked_candidates:
        candidate_url = normalize_text(candidate.get("url"))
        if urlparse(candidate_url).netloc.lower() == current_host:
            return candidate_url
    return ranked_candidates[0]["url"] if ranked_candidates else None


def recover_navigation_from_current_url(
    current_url: str | None,
    ranked_candidates: list[dict[str, Any]],
    *,
    error_text: str | None = None,
) -> dict[str, Any] | None:
    normalized_url = normalize_text(current_url)
    if not normalized_url:
        return None

    candidate_url = _select_candidate_for_url(normalized_url, ranked_candidates)
    if is_checkout_url(normalized_url):
        return _build_payload(
            "checkout_reached",
            candidate_url=candidate_url,
            current_url=normalized_url,
            product_url=candidate_url if candidate_url and "/products/" in candidate_url else None,
            checkout_url=normalized_url,
            hint="Browser Use reached checkout before agent termination; continuing with deterministic checkout handoff.",
        )
    if "/products/" in normalized_url:
        return _build_payload(
            "product_selected",
            candidate_url=candidate_url,
            current_url=normalized_url,
            product_url=normalized_url,
            hint=(
                "Browser Use stopped on the product page before checkout."
                if error_text
                else ""
            ),
        )
    return _build_payload(
        "candidate_selected",
        candidate_url=candidate_url,
        current_url=normalized_url,
        hint="Browser Use reached the candidate store before agent termination." if error_text else "",
    )


async def _dismiss_geofencing_modal(page: Any, config: Any) -> bool:
    modal = page.locator(GEOFENCING_MODAL_SELECTOR).first
    try:
        if await modal.count() == 0 or not await modal.is_visible():
            return False
    except Exception:
        return False

    close_candidates = [
        modal.get_by_role("button", name="Close").first,
        modal.locator("button").first,
    ]
    for button in close_candidates:
        try:
            if await button.count() == 0:
                continue
            await button.click(timeout=3_000, force=True)
            await pause(config, 0.5)
            try:
                if not await modal.is_visible():
                    return True
            except Exception:
                return True
        except Exception:
            continue

    try:
        await page.keyboard.press("Escape")
        await pause(config, 0.2)
    except Exception:
        pass

    try:
        return not await modal.is_visible()
    except Exception:
        return True


async def _dismiss_banners(page: Any, config: Any) -> None:
    async def _dismiss_generic_overlays() -> bool:
        clicked = await click_first_visible(page, COOKIE_DISMISS_SELECTORS + GENERIC_DISMISS_SELECTORS, timeout_ms=2_500)
        closed_modal = await _dismiss_geofencing_modal(page, config)
        try:
            await page.keyboard.press("Escape")
            await pause(config, 0.15)
        except Exception:
            pass
        try:
            await page.evaluate(
                """() => {
                  for (const el of Array.from(document.querySelectorAll('[aria-hidden="true"][inert], .modal-backdrop, .popup-backdrop, .drawer-backdrop, .fancybox-overlay, .mfp-bg'))) {
                    el.remove();
                  }
                  if (document.body) {
                    document.body.style.overflow = '';
                  }
                  if (document.documentElement) {
                    document.documentElement.style.overflow = '';
                  }
                }"""
            )
        except Exception:
            pass
        return bool(clicked or closed_modal)

    for _ in range(3):
        dismissed = await _dismiss_generic_overlays()
        if not dismissed:
            break
        await pause(config, 0.2)


async def _body_text(page: Any) -> str:
    try:
        return normalize_text(await page.locator("body").inner_text(timeout=4_000))
    except Exception:
        return ""


async def _goto_best_effort(page: Any, url: str, timeout_ms: int = 45_000) -> None:
    target = normalize_text(url)
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        return
    except Exception as exc:
        current = normalize_text(page.url)
        if current:
            same_without_query = current.split("?", 1)[0] == target.split("?", 1)[0]
            if current == target or same_without_query or is_checkout_url(current):
                try:
                    await page.wait_for_load_state("domcontentloaded", timeout=5_000)
                    return
                except Exception:
                    pass
                try:
                    if await page.locator("body").count() > 0:
                        return
                except Exception:
                    pass
        try:
            await page.goto(url, wait_until="commit", timeout=15_000)
            return
        except Exception:
            raise exc


async def _save_screenshot(page: Any, screenshot_dir: Path, stem: str) -> str | None:
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    path = screenshot_dir / f"{stem}.png"
    try:
        await page.screenshot(path=str(path), full_page=True)
    except Exception:
        return None
    return str(path)


async def _is_checkout_ready(page: Any) -> bool:
    if is_checkout_url(page.url):
        return True
    try:
        title = normalize_text(await page.title()).lower()
        if "checkout" in title:
            return True
    except Exception:
        pass
    try:
        email = page.locator("main input[autocomplete='email'], main input[type='email']")
        pay = page.locator("button:has-text('Pay now'), button:has-text('Complete order')")
        if await email.count() > 0 and await pay.count() > 0:
            return True
    except Exception:
        pass
    return False


async def _wait_for_checkout(page: Any, timeout_seconds: float = 12.0) -> bool:
    deadline = asyncio.get_running_loop().time() + max(timeout_seconds, 1.0)
    while asyncio.get_running_loop().time() < deadline:
        if await _is_checkout_ready(page):
            return True
        await asyncio.sleep(0.25)
    return await _is_checkout_ready(page)


async def _cart_item_count(page: Any) -> int | None:
    try:
        data = await page.evaluate(
            """async () => {
              const response = await fetch('/cart.js', {
                credentials: 'same-origin',
                headers: {accept: 'application/json'},
              });
              if (!response.ok) return null;
              return await response.json();
            }"""
        )
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    count = data.get("item_count")
    try:
        return int(count)
    except (TypeError, ValueError):
        return None


async def _wait_for_cart_ready(page: Any, timeout_seconds: float = 8.0) -> bool:
    deadline = asyncio.get_running_loop().time() + max(timeout_seconds, 1.0)
    while asyncio.get_running_loop().time() < deadline:
        count = await _cart_item_count(page)
        if count and count > 0:
            return True
        await asyncio.sleep(0.5)
    count = await _cart_item_count(page)
    return bool(count and count > 0)


def normalize_variant_id(value: Any) -> str | None:
    text = normalize_text(value)
    if not re.fullmatch(r"\d{6,}", text):
        return None
    return text


def build_cart_permalink_candidates(url: str, variant_id: str | None) -> list[str]:
    normalized_variant_id = normalize_variant_id(variant_id)
    parsed = urlparse(normalize_text(url))
    if not normalized_variant_id or not parsed.scheme or not parsed.netloc:
        return []
    origin = f"{parsed.scheme}://{parsed.netloc}"
    base = f"{origin}/cart/{normalized_variant_id}:1"
    return [
        f"{base}?storefront=true&skip_shop_pay=true",
        f"{base}?storefront=true",
        base,
    ]


async def _resolve_selected_variant_id(page: Any) -> str | None:
    parsed = urlparse(normalize_text(page.url))
    direct_variant = normalize_variant_id(parse_qs(parsed.query).get("variant", [None])[-1])
    if direct_variant:
        return direct_variant

    try:
        resolved = await page.evaluate(
            """async () => {
              const normalize = (value) => {
                const text = String(value || '').trim();
                return /^\\d{6,}$/.test(text) ? text : null;
              };

              const selectors = [
                "form[action*='/cart/add'] input[name='id']:checked",
                "form[action*='/cart/add'] select[name='id']",
                "form[action*='/cart/add'] input[name='id'][type='hidden']",
                "form[action*='/cart/add'] input[name='id'][value]",
                "input[name='id']:checked",
                "select[name='id']",
                "input[name='id'][type='hidden']",
              ];

              for (const selector of selectors) {
                const node = document.querySelector(selector);
                if (!node) continue;
                const value = normalize(node.value);
                if (value) return value;
              }

              const match = window.location.pathname.match(/\\/products\\/([^/?#]+)/i);
              const handle = match ? match[1] : '';
              if (!handle) return null;

              try {
                const response = await fetch(`/products/${handle}.js`, {
                  credentials: 'same-origin',
                  headers: {accept: 'application/json'},
                });
                if (!response.ok) return null;
                const product = await response.json();
                const variants = Array.isArray(product?.variants) ? product.variants : [];
                const firstAvailable = variants.find((variant) => variant && variant.available) || variants[0];
                return normalize(firstAvailable?.id);
              } catch {
                return null;
              }
            }"""
        )
    except Exception:
        return None
    return normalize_variant_id(resolved)


async def _post_cart_add_variant(page: Any, variant_id: str) -> bool:
    normalized_variant_id = normalize_variant_id(variant_id)
    if not normalized_variant_id:
        return False
    try:
        added = await page.evaluate(
            """async (resolvedVariantId) => {
              const params = new URLSearchParams();
              params.set('id', resolvedVariantId);
              params.set('quantity', '1');
              const response = await fetch('/cart/add.js', {
                method: 'POST',
                body: params,
                credentials: 'same-origin',
                headers: {
                  accept: 'application/json',
                  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                },
              });
              return response.ok;
            }""",
            normalized_variant_id,
        )
    except Exception:
        return False
    return bool(added)


async def _go_to_checkout_via_cart_permalink(page: Any, config: Any) -> bool:
    variant_id = await _resolve_selected_variant_id(page)
    if not variant_id:
        return False

    current_url = normalize_text(page.url)
    for candidate_url in build_cart_permalink_candidates(current_url, variant_id):
        try:
            await _goto_best_effort(page, candidate_url, timeout_ms=45_000)
        except Exception:
            continue
        await pause(config, 0.8)
        await _dismiss_banners(page, config)
        if await _wait_for_checkout(page, timeout_seconds=6.0):
            return True
        if await _wait_for_cart_ready(page, timeout_seconds=3.0) and await _go_to_checkout(page, config):
            return True

    parsed = urlparse(current_url)
    if not parsed.scheme or not parsed.netloc:
        return False
    origin = f"{parsed.scheme}://{parsed.netloc}"
    added = await _post_cart_add_variant(page, variant_id)
    if not added and not await _wait_for_cart_ready(page, timeout_seconds=2.0):
        return False

    try:
        await _goto_best_effort(page, f"{origin}/checkout?skip_shop_pay=true", timeout_ms=45_000)
    except Exception:
        return False
    await pause(config, 0.8)
    await _dismiss_banners(page, config)
    return await _wait_for_checkout(page, timeout_seconds=8.0)


async def _extract_checkout_url(page: Any) -> str | None:
    try:
        href = await page.evaluate(
            """() => {
              const anchors = Array.from(document.querySelectorAll('a[href], form[action]'));
              for (const el of anchors) {
                const value = el.getAttribute('href') || el.getAttribute('action') || '';
                if (!value) continue;
                if (value.includes('/checkouts/') || /\\/checkout(\\?|$|\\/)/i.test(value)) {
                  try {
                    return new URL(value, window.location.href).toString();
                  } catch {
                    return value;
                  }
                }
              }
              return null;
            }"""
        )
    except Exception:
        return None
    normalized = normalize_text(href)
    return normalized or None


async def _resolve_product_page(page: Any, config: Any) -> str | None:
    body = await _body_text(page)
    if "/products/" in page.url:
        return page.url
    try:
        if await page.locator("form[action*='/cart/add']").count() > 0:
            return page.url
    except Exception:
        pass

    links = page.locator("a[href*='/products/']")
    scored_links: list[tuple[int, str]] = []
    try:
        count = min(await links.count(), 40)
    except Exception:
        count = 0
    for index in range(count):
        link = links.nth(index)
        try:
            href = normalize_text(await link.get_attribute("href"))
            text = normalize_text(await link.inner_text())
        except Exception:
            continue
        if not href:
            continue
        haystack = f"{text} {href}"
        score = 0
        if "/products/" in href:
            score += 20
        if text:
            score += 5
        if "gift-card" in href or "giftcard" in href:
            score += 10
        if looks_like_gift_card(haystack):
            score += 8
        if parse_money_amount(text) is not None:
            score += 5
        scored_links.append((score, urljoin(page.url, href)))

    if not scored_links:
        return None

    scored_links.sort(key=lambda item: item[0], reverse=True)
    destination = scored_links[0][1]
    if destination != page.url:
        await _goto_best_effort(page, destination, timeout_ms=45_000)
        await pause(config, 0.5)
    return page.url


async def _select_lowest_denomination(page: Any, config: Any) -> str | None:
    await _dismiss_geofencing_modal(page, config)
    amount_buttons = page.locator(
        "button:has-text('$'), button[aria-label*='$'], [role='button']:has-text('$')"
    )
    try:
        button_count = min(await amount_buttons.count(), 30)
    except Exception:
        button_count = 0
    button_choices = []
    for index in range(button_count):
        button = amount_buttons.nth(index)
        try:
            text = normalize_text(await button.inner_text())
            aria = normalize_text(await button.get_attribute("aria-label"))
            disabled = await button.is_disabled()
        except Exception:
            continue
        haystack = " ".join(part for part in (text, aria) if part)
        amount = parse_money_amount(haystack)
        if amount is None or disabled:
            continue
        if "select" not in haystack.lower() and "amount" not in haystack.lower() and "gift" not in haystack.lower():
            continue
        button_choices.append((amount, index, text or aria))
    if button_choices:
        button_choices.sort(key=lambda item: item[0])
        _amount, index, text = button_choices[0]
        button = amount_buttons.nth(index)
        try:
            await button.click(timeout=3_000)
        except Exception:
            try:
                await button.click(force=True, timeout=3_000)
            except Exception:
                pass
        await pause(config, 0.6)
        return text

    radios = page.locator("input[type='radio']")
    choices: list[tuple[float, int, str]] = []
    try:
        count = min(await radios.count(), 20)
    except Exception:
        count = 0

    radio_js = """(el) => {
      const parts = [];
      const push = (value) => {
        if (value) parts.push(String(value).replace(/\\s+/g, ' ').trim());
      };
      push(el.value);
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) push(label.innerText);
      }
      const parentLabel = el.closest('label');
      if (parentLabel) push(parentLabel.innerText);
      if (el.parentElement) push(el.parentElement.innerText);
      return parts.join(' ').trim();
    }"""
    for index in range(count):
        radio = radios.nth(index)
        try:
            text = normalize_text(await radio.evaluate(radio_js))
        except Exception:
            continue
        amount = parse_money_amount(text)
        if amount is None:
            continue
        choices.append((amount, index, normalize_selection_label(text) or text))

    if choices:
        choices.sort(key=lambda item: item[0])
        _amount, index, text = choices[0]
        radio = radios.nth(index)
        clicked = False
        try:
            radio_id = await radio.get_attribute("id")
        except Exception:
            radio_id = None
        if radio_id:
            try:
                label = page.locator(f"label[for='{radio_id}']").first
                if await label.count() > 0:
                    await label.click(timeout=3_000)
                    clicked = True
            except Exception:
                pass
        if not clicked:
            try:
                await radio.check(force=True, timeout=3_000)
                clicked = True
            except Exception:
                pass
        if not clicked:
            try:
                await radio.click(force=True, timeout=3_000)
            except Exception:
                pass
        await pause(config, 0.4)
        return text

    selects = page.locator("select")
    try:
        select_count = min(await selects.count(), 4)
    except Exception:
        select_count = 0
    for index in range(select_count):
        select = selects.nth(index)
        option_locator = select.locator("option")
        try:
            option_count = min(await option_locator.count(), 40)
        except Exception:
            continue
        choices = []
        for option_index in range(option_count):
            option = option_locator.nth(option_index)
            try:
                text = normalize_text(await option.inner_text())
                value = normalize_text(await option.get_attribute("value"))
            except Exception:
                continue
            amount = parse_money_amount(text)
            if amount is None or not value:
                continue
            choices.append((amount, value, normalize_selection_label(text) or text))
        if not choices:
            continue
        choices.sort(key=lambda item: item[0])
        _amount, value, text = choices[0]
        try:
            await select.select_option(value=value)
            await pause(config, 0.4)
            return text
        except Exception:
            continue
    return None


async def _add_to_cart(page: Any, config: Any) -> bool:
    await _dismiss_banners(page, config)
    if await click_first_visible(page, ADD_TO_CART_SELECTORS, timeout_ms=5_000):
        await pause(config, 1.0)
        await _dismiss_banners(page, config)
        if await _wait_for_cart_ready(page):
            return True
    try:
        form = page.locator("form[action*='/cart/add']").first
        if await form.count() > 0:
            await form.evaluate("(node) => node.requestSubmit ? node.requestSubmit() : node.submit()")
            await pause(config, 1.0)
            await _dismiss_banners(page, config)
            if await _wait_for_cart_ready(page):
                return True
    except Exception:
        pass
    resolved_variant_id = await _resolve_selected_variant_id(page)
    if resolved_variant_id and await _post_cart_add_variant(page, resolved_variant_id):
        await pause(config, 1.0)
        await _dismiss_banners(page, config)
        if await _wait_for_cart_ready(page):
            return True
    try:
        added = await page.evaluate(
            """async () => {
              const variantFromUrl = new URL(window.location.href).searchParams.get('variant');
              const post = async (body, headers = {}) => {
                const response = await fetch('/cart/add.js', {
                  method: 'POST',
                  body,
                  credentials: 'same-origin',
                  headers: {accept: 'application/json', ...headers},
                });
                return response.ok;
              };

              const form = document.querySelector("form[action*='/cart/add']");
              if (form) {
                const formData = new FormData(form);
                if (!formData.get('id') && variantFromUrl) formData.set('id', variantFromUrl);
                if (!formData.get('quantity')) formData.set('quantity', '1');
                if (formData.get('id')) {
                  try {
                    if (await post(formData)) return true;
                  } catch {}
                }
              }

              if (variantFromUrl) {
                const params = new URLSearchParams();
                params.set('id', variantFromUrl);
                params.set('quantity', '1');
                try {
                  if (
                    await post(params, {
                      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    })
                  ) return true;
                } catch {}
              }
              return false;
            }"""
        )
        if added:
            await pause(config, 1.0)
            await _dismiss_banners(page, config)
            if await _wait_for_cart_ready(page):
                return True
    except Exception:
        pass
    return False


async def _go_to_checkout(page: Any, config: Any) -> bool:
    await _dismiss_banners(page, config)
    if await _is_checkout_ready(page):
        return True

    if await click_first_visible(page, CHECKOUT_SELECTORS, timeout_ms=5_000):
        await pause(config, 0.8)
        await _dismiss_banners(page, config)
        if await _wait_for_checkout(page):
            return True

    checkout_url = await _extract_checkout_url(page)
    if checkout_url:
        await _goto_best_effort(page, checkout_url, timeout_ms=45_000)
        await pause(config, 0.8)
        await _dismiss_banners(page, config)
        if await _wait_for_checkout(page):
            return True

    parsed = urlparse(page.url)
    origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else ""
    if not origin:
        return False

    cart_url = f"{origin}/cart"
    await _goto_best_effort(page, cart_url, timeout_ms=45_000)
    await pause(config, 0.5)
    await _dismiss_banners(page, config)
    if await click_first_visible(page, CHECKOUT_SELECTORS, timeout_ms=5_000):
        await pause(config, 0.8)
        await _dismiss_banners(page, config)
        if await _wait_for_checkout(page):
            return True

    checkout_url = await _extract_checkout_url(page) or f"{origin}/checkout?skip_shop_pay=true"
    await _goto_best_effort(page, checkout_url, timeout_ms=45_000)
    await pause(config, 0.8)
    await _dismiss_banners(page, config)
    return await _wait_for_checkout(page, timeout_seconds=12.0)


async def run_navigation_agent(
    config: Any,
    run_id: str,
    user_data_dir: Path | None,
    traces_dir: Path,
    videos_dir: Path | None,
    conversations_dir: Path,
    ranked_candidates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if Agent is None or Browser is None or BrowserProfile is None:
        raise RuntimeError(f"browser-use is required for Shopify navigation: {BROWSER_USE_IMPORT_ERROR}")

    ranked_candidates = ranked_candidates or rank_candidates(config.candidate_urls_json, query=config.query, limit=3)
    if not ranked_candidates:
        payload = default_payload()
        payload["outcome"] = {"status": "no_shopify_candidate", "hint": "No viable Shopify checkout candidate was available."}
        payload["hint"] = "No viable Shopify checkout candidate was available."
        return {"navigation": payload, "artifacts": {"conversation": None, "screenshots": [], "urls": [], "method": "browser_use"}}

    allowed_domains = build_allowed_domains(ranked_candidates)
    llm = resolve_llm(config)
    conversation_path = conversations_dir / f"shopify-navigation-{run_id}.json"

    browser_profile = BrowserProfile(
        headless=not config.headed,
        channel=config.browser_channel,
        user_data_dir=user_data_dir,
        record_video_dir=videos_dir if config.record_video else None,
        traces_dir=traces_dir if config.record_trace else None,
        enable_default_extensions=False,
        proxy=(
            ProxySettings(
                server=config.proxy_server,
                bypass=config.proxy_bypass,
                username=config.proxy_username,
                password=config.proxy_password,
            )
            if config.proxy_server
            else None
        ),
        allowed_domains=allowed_domains,
        wait_between_actions=max(config.action_delay_seconds, 0.25),
        minimum_wait_page_load_time=0.1,
        wait_for_network_idle_page_load_time=0.1,
        highlight_elements=False,
        cross_origin_iframes=True,
        captcha_solver=False,
        keep_alive=True,
    )

    browser = Browser(browser_profile=browser_profile)
    agent = Agent(
        task=build_navigation_task(config, ranked_candidates),
        llm=llm,
        browser=browser,
        sensitive_data={},
        save_conversation_path=conversation_path,
        use_vision=config.use_vision,
        max_failures=4,
        max_actions_per_step=5,
        step_timeout=min(max(config.max_run_seconds, 90), 600),
        source="agent-shopify-checkout-browser-use",
    )
    history = None
    handoff_runtime: dict[str, Any] | None = None
    try:
        history = await asyncio.wait_for(agent.run(max_steps=config.max_steps), timeout=config.max_run_seconds)
        screenshots = []
        try:
            screenshots = [path for path in history.screenshot_paths(return_none_if_not_screenshot=False) if path]
        except TypeError:
            screenshots = [path for path in history.screenshot_paths() if path]
        parsed = extract_json_object(history.final_result())
        normalized = normalize_navigation_result(parsed, [item["url"] for item in ranked_candidates], history=history)
        if normalized.get("outcome", {}).get("status") == "checkout_reached" and getattr(browser, "cdp_url", None):
            handoff_runtime = {
                "handoff": "browser_use_cdp",
                "cdp_url": browser.cdp_url,
                "browser_session": browser,
                "checkout_url": normalized.get("checkoutUrl"),
            }
        result = {
            "navigation": normalized,
            "artifacts": {
                "conversation": str(conversation_path),
                "screenshots": screenshots,
                "urls": history.urls(),
                "errors": history.errors(),
                "actions": history.action_names(),
                "rankedCandidates": ranked_candidates,
                "method": "browser_use",
            },
        }
        if handoff_runtime is not None:
            result["runtime"] = handoff_runtime
        return result
    finally:
        if handoff_runtime is None:
            stop = getattr(browser, "stop", None)
            if callable(stop):
                await stop()


async def run_navigation_playwright_fallback(
    config: Any,
    run_id: str,
    user_data_dir: Path | None,
    traces_dir: Path,
    videos_dir: Path | None,
    conversations_dir: Path,
    ranked_candidates: list[dict[str, Any]],
    fallback_reason: str | None = None,
) -> dict[str, Any]:
    if async_playwright is None:
        raise RuntimeError(f"Playwright is required for Shopify navigation fallback: {PLAYWRIGHT_IMPORT_ERROR}")

    artifacts: dict[str, Any] = {
        "conversation": None,
        "screenshots": [],
        "urls": [],
        "errors": [],
        "rankedCandidates": ranked_candidates,
        "method": "playwright_fallback",
    }
    if fallback_reason:
        artifacts["errors"].append(f"browser_use_fallback:{fallback_reason}")

    screenshot_dir = conversations_dir.parent / "screenshots" / run_id
    best_payload: dict[str, Any] | None = None
    playwright = None
    context = None
    page = None
    trace_path = traces_dir / f"navigation-fallback-{run_id}.zip"
    handoff_runtime: dict[str, Any] | None = None
    try:
        playwright = await async_playwright().start()  # pragma: no cover - runtime integration
        context = await playwright.chromium.launch_persistent_context(
            user_data_dir=str(user_data_dir or conversations_dir.parent / "shopify-navigation-profile"),
            headless=not config.headed,
            channel=config.browser_channel,
            ignore_https_errors=True,
            record_video_dir=str(videos_dir) if videos_dir else None,
            proxy=_proxy_settings(config),
        )
        page = context.pages[0] if context.pages else await context.new_page()
        if config.record_trace:
            await context.tracing.start(screenshots=True, snapshots=True, sources=False)

        for index, candidate in enumerate(ranked_candidates, start=1):
            candidate_url = candidate["url"]
            try:
                current_url = normalize_text(page.url if page else "")
                same_store = urlparse(current_url).netloc.lower() == urlparse(candidate_url).netloc.lower()
                if not current_url or current_url == "about:blank" or (not same_store and not is_checkout_url(current_url)):
                    await _goto_best_effort(page, candidate_url, timeout_ms=45_000)
                artifacts["urls"].append(page.url)
                await _dismiss_banners(page, config)

                if await _wait_for_checkout(page, timeout_seconds=3.0):
                    checkout_shot = await _save_screenshot(page, screenshot_dir, f"{index:02d}-checkout")
                    if checkout_shot:
                        artifacts["screenshots"].append(checkout_shot)
                    payload = _build_payload(
                        "checkout_reached",
                        candidate_url=candidate_url,
                        current_url=page.url,
                        product_url=candidate_url if "/products/" in candidate_url else None,
                        checkout_url=page.url,
                        hint="Entry URL redirected straight to Shopify checkout.",
                    )
                    handoff_runtime = {
                        "playwright": playwright,
                        "context": context,
                        "page": page,
                        "trace_path": str(trace_path),
                        "trace_started": bool(config.record_trace),
                    }
                    return {"navigation": payload, "artifacts": artifacts, "runtime": handoff_runtime}

                body = await _body_text(page)
                if looks_like_security_verification(body):
                    payload = _build_payload(
                        "needs_manual_verification",
                        candidate_url=candidate_url,
                        current_url=page.url,
                        hint="Store requires CAPTCHA, Cloudflare, or another manual verification step before product selection.",
                    )
                    best_payload = _better_payload(best_payload, payload)
                    return {"navigation": payload, "artifacts": artifacts}

                product_url = await _resolve_product_page(page, config)
                if not product_url:
                    payload = _build_payload(
                        "candidate_selected",
                        candidate_url=candidate_url,
                        current_url=page.url,
                        hint="Candidate opened, but no visible Shopify product link was confirmed.",
                    )
                    best_payload = _better_payload(best_payload, payload)
                    continue

                product_shot = await _save_screenshot(page, screenshot_dir, f"{index:02d}-product")
                if product_shot:
                    artifacts["screenshots"].append(product_shot)

                denomination = await _select_lowest_denomination(page, config)
                added_to_cart = await _add_to_cart(page, config)
                if not added_to_cart:
                    if await _go_to_checkout_via_cart_permalink(page, config):
                        artifacts["urls"].append(page.url)
                        checkout_shot = await _save_screenshot(page, screenshot_dir, f"{index:02d}-checkout")
                        if checkout_shot:
                            artifacts["screenshots"].append(checkout_shot)

                        body = await _body_text(page)
                        if looks_like_security_verification(body):
                            payload = _build_payload(
                                "needs_manual_verification",
                                candidate_url=candidate_url,
                                current_url=page.url,
                                product_url=product_url,
                                checkout_url=page.url,
                                denomination=denomination,
                                hint="Checkout was reached via cart permalink fallback, but manual verification is required.",
                            )
                            best_payload = _better_payload(best_payload, payload)
                            return {"navigation": payload, "artifacts": artifacts}

                        payload = _build_payload(
                            "checkout_reached",
                            candidate_url=candidate_url,
                            current_url=page.url,
                            product_url=product_url,
                            checkout_url=page.url,
                            denomination=denomination,
                            hint="Reached Shopify checkout via cart permalink fallback after direct add-to-cart failed.",
                        )
                        handoff_runtime = {
                            "playwright": playwright,
                            "context": context,
                            "page": page,
                            "trace_path": str(trace_path),
                            "trace_started": bool(config.record_trace),
                        }
                        return {"navigation": payload, "artifacts": artifacts, "runtime": handoff_runtime}
                    payload = _build_payload(
                        "product_selected",
                        candidate_url=candidate_url,
                        current_url=page.url,
                        product_url=product_url,
                        denomination=denomination,
                        hint="Shopify product was confirmed, but Add to cart could not be completed.",
                    )
                    best_payload = _better_payload(best_payload, payload)
                    continue

                if not await _go_to_checkout(page, config):
                    payload = _build_payload(
                        "product_selected",
                        candidate_url=candidate_url,
                        current_url=page.url,
                        product_url=product_url,
                        denomination=denomination,
                        hint="Shopify product was added to cart, but checkout was not reached.",
                    )
                    best_payload = _better_payload(best_payload, payload)
                    continue

                artifacts["urls"].append(page.url)
                checkout_shot = await _save_screenshot(page, screenshot_dir, f"{index:02d}-checkout")
                if checkout_shot:
                    artifacts["screenshots"].append(checkout_shot)

                body = await _body_text(page)
                if looks_like_security_verification(body):
                    payload = _build_payload(
                        "needs_manual_verification",
                        candidate_url=candidate_url,
                        current_url=page.url,
                        product_url=product_url,
                        checkout_url=page.url,
                        denomination=denomination,
                        hint="Checkout requires CAPTCHA, Cloudflare, or another manual verification step.",
                    )
                    best_payload = _better_payload(best_payload, payload)
                    return {"navigation": payload, "artifacts": artifacts}

                payload = _build_payload(
                    "checkout_reached",
                    candidate_url=candidate_url,
                    current_url=page.url,
                    product_url=product_url,
                    checkout_url=page.url,
                    denomination=denomination,
                    hint="Reached Shopify checkout via deterministic Playwright fallback.",
                )
                handoff_runtime = {
                    "playwright": playwright,
                    "context": context,
                    "page": page,
                    "trace_path": str(trace_path),
                    "trace_started": bool(config.record_trace),
                }
                return {"navigation": payload, "artifacts": artifacts, "runtime": handoff_runtime}
            except Exception as exc:
                artifacts["errors"].append(f"{candidate_url}: {type(exc).__name__}: {exc}")
                payload = recover_navigation_from_current_url(
                    page.url if page else None,
                    ranked_candidates,
                    error_text=f"{type(exc).__name__}: {exc}",
                ) or _build_payload(
                    "candidate_selected",
                    candidate_url=candidate_url,
                    current_url=page.url if page else None,
                    hint=f"Candidate opened but navigation failed: {type(exc).__name__}: {exc}",
                )
                best_payload = _better_payload(best_payload, payload)

        if best_payload is None:
            best_payload = _build_payload(
                "no_shopify_candidate",
                candidate_url=ranked_candidates[0]["url"] if ranked_candidates else None,
                current_url=None,
                hint="No viable Shopify checkout candidate was available.",
            )
        return {"navigation": best_payload, "artifacts": artifacts}
    finally:
        if handoff_runtime is None:
            if context is not None:
                if config.record_trace:
                    try:
                        await context.tracing.stop(path=str(trace_path))
                    except Exception:
                        pass
                try:
                    await asyncio.wait_for(context.close(), timeout=10)
                except Exception:
                    pass
            if playwright is not None:
                try:
                    await asyncio.wait_for(playwright.stop(), timeout=5)
                except Exception:
                    pass


async def run_navigation(
    config: Any,
    run_id: str,
    user_data_dir: Path | None,
    traces_dir: Path,
    videos_dir: Path | None,
    conversations_dir: Path,
) -> dict[str, Any]:
    ranked_candidates = rank_candidates(config.candidate_urls_json, query=config.query, limit=3)
    if not ranked_candidates:
        payload = _build_payload(
            "no_shopify_candidate",
            candidate_url=None,
            current_url=None,
            hint="No viable Shopify checkout candidate was available.",
        )
        return {
            "navigation": payload,
            "artifacts": {"conversation": None, "screenshots": [], "urls": [], "errors": [], "rankedCandidates": [], "method": "none"},
        }

    browser_use_error: str | None = None
    try:
        result = await run_navigation_agent(
            config=config,
            run_id=run_id,
            user_data_dir=user_data_dir,
            traces_dir=traces_dir,
            videos_dir=videos_dir,
            conversations_dir=conversations_dir,
            ranked_candidates=ranked_candidates,
        )
        status = result["navigation"].get("outcome", {}).get("status", "unknown")
        if status in {"checkout_reached", "needs_manual_verification", "no_shopify_candidate"}:
            return result
        if status not in {"unknown", "candidate_selected", "product_selected"}:
            return result
        browser_use_error = f"partial_navigation:{status}"
    except Exception as exc:
        browser_use_error = f"{type(exc).__name__}: {exc}"

    return await run_navigation_playwright_fallback(
        config=config,
        run_id=run_id,
        user_data_dir=user_data_dir,
        traces_dir=traces_dir,
        videos_dir=videos_dir,
        conversations_dir=conversations_dir,
        ranked_candidates=ranked_candidates,
        fallback_reason=browser_use_error,
    )
