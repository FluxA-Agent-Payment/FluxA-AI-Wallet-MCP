"""Resolve Shopify cart links and read anonymous checkout quotes."""

import asyncio
import json
import re
import sys
from decimal import Decimal
from urllib.parse import urlencode, urlsplit

from playwright.async_api import Error, Page, async_playwright

from shopify.security import looks_like_security_verification

from .contract import RESOLVED_STORAGE, checkout_entry_host, checkout_identity
from .observation import QUOTE_STATES, current_route, read_quote, read_shopify_checkout

UCP_VERSION = "2026-08-25"


CURRENCY_AMOUNT = re.compile(
    r"Total\s*([A-Z]{3})\s*(?:(?:US|CA|NZ|HK|A)?\$|[£€¥])?\s*"
    r"((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,3})?)"
)


async def displayed_total(page: Page) -> tuple[str, Decimal] | None:
    amounts = set()
    for label in await page.get_by_text("Total", exact=True).all():
        if not await label.is_visible():
            continue
        for row in ("..", "../..", "../../.."):
            text = await label.locator(f"xpath={row}").inner_text()
            match = CURRENCY_AMOUNT.fullmatch(" ".join(text.split()))
            if match:
                amounts.add((match[1], Decimal(match[2].replace(",", ""))))
                break
    return next(iter(amounts)) if len(amounts) == 1 else None


async def displayed_items(page: Page) -> list[dict]:
    cart = page.get_by_role("table", name="Shopping cart", exact=True).filter(visible=True)
    items = []
    for row in (await cart.get_by_role("row").all())[:21]:
        cells = await row.get_by_role("cell").all()
        if len(cells) != 4:
            continue
        title = " ".join((await cells[1].inner_text()).split())[:250]
        quantity = (await cells[2].inner_text()).strip()
        if title and re.fullmatch(r"[1-9][0-9]{0,3}", quantity):
            items.append({"title": title, "quantity": int(quantity)})
    return items


async def run_preview(
    page: Page, merchant: str, permalink_endpoint: str, variant_id: str, quantity: int, country: str | None = None,
) -> dict:
    params = {"ucp/version": UCP_VERSION}
    if country:
        params["context/address_country"] = country
    permalink = f"{permalink_endpoint.rstrip('/')}/{variant_id}:{quantity}?{urlencode(params)}"
    try:
        response = await page.goto(permalink, wait_until="domcontentloaded", timeout=30_000)
    except Error:
        return {"status": "navigation_failed", "merchant": merchant}

    try:
        checkout_host, _ = checkout_identity(page.url)
        route = current_route(page)
    except ValueError:
        text = await page.locator("body").inner_text()
        blocked = (response and response.status in {403, 429}) or looks_like_security_verification(text)
        return {"status": "manual_verification" if blocked else "checkout_unavailable", "merchant": merchant}
    if checkout_host != merchant:
        return {"status": "checkout_unavailable", "merchant": merchant}

    checkout, tool_status = await read_shopify_checkout(page)
    unavailable = {"status": "checkout_unavailable", "merchant": merchant}
    if current_route(page) != route:
        return unavailable
    if checkout is not None:
        if not isinstance(checkout.get("status"), str) or checkout["status"] not in QUOTE_STATES:
            return unavailable
        quote = read_quote(checkout)
        if quote is not None:
            if quote.items != {variant_id: quantity}:
                return {"status": "cart_mismatch", "merchant": merchant, "source": "shopify_webmcp"}
            title = checkout["line_items"][0]["item"].get("title")
            return {
                "status": "preview_ready", "merchant": merchant, "source": "shopify_webmcp",
                "checkout_status": checkout["status"],
                "item": {"variant_id": variant_id, "quantity": quantity, "title": title if isinstance(title, str) else None},
                "total": {"currency": quote.currency, "minor_units": quote.total},
            }
        tool_status = "invalid_result"

    total = await displayed_total(page)
    result = {
        "status": "checkout_reached", "merchant": merchant, "source": "page",
        "items": await displayed_items(page), "webmcp_status": tool_status,
    }
    if current_route(page) != route:
        return unavailable
    if total is not None:
        currency, amount = total
        result["total"] = {"currency": currency, "display_amount": str(amount)}
    return result


async def resolve_checkout(page: Page, checkout_url: str, checkout_host: str, storefront_password: str | None) -> dict:
    entry_host = checkout_entry_host(checkout_url)
    try:
        response = await page.goto(checkout_url, wait_until="domcontentloaded", timeout=25_000)
        current = urlsplit(page.url)
        if (storefront_password and current.scheme == "https"
                and current.netloc in {entry_host, checkout_host} and current.path == "/password"):
            field = page.locator("input[name='password']:visible")
            if not await field.count():
                await page.get_by_text("Enter using password", exact=True).click(timeout=5_000)
            await field.fill(storefront_password)
            async with page.expect_navigation(wait_until="domcontentloaded", timeout=10_000):
                await field.press("Enter")
            response = await page.goto(checkout_url, wait_until="domcontentloaded", timeout=20_000)
        text = await page.locator("body").inner_text(timeout=5_000)
        if ((response and response.status in {403, 429}) or looks_like_security_verification(text)
                or urlsplit(page.url).path == "/password"):
            return {"status": "manual_verification"}
        if checkout_identity(page.url)[0] == checkout_host:
            await page.context.storage_state(path=RESOLVED_STORAGE)
            return {"status": "resolved", "checkout_url": page.url}
    except (Error, ValueError):
        pass
    return {"status": "checkout_unavailable"}


async def main(payload: dict) -> dict:
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=["--disable-quic", "--enable-features=WebMCP"])
        page = await browser.new_page(locale="en-US", service_workers="block", accept_downloads=False)
        page.set_default_timeout(5_000)
        try:
            if "checkout_url" in payload:
                return await resolve_checkout(page, **payload)
            return await run_preview(page, **payload)
        finally:
            try:
                await browser.close()
            except Error:
                pass


if __name__ == "__main__":
    try:
        result = asyncio.run(main(json.loads(sys.stdin.readline(8 * 1024))))
    except Exception:
        result = {"status": "preview_failed"}
    print(json.dumps(result), flush=True)
