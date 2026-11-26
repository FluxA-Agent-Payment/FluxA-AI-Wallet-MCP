"""Read and validate the native Shopify checkout snapshot."""

import asyncio
import re
from dataclasses import dataclass

from playwright.async_api import Error, Page

from .contract import CHECKOUT_STEPS, VARIANT_ID, checkout_route

QUOTE_STATES = frozenset({"incomplete", "requires_escalation", "ready_for_complete"})
VARIANT_PREFIX = "gid://shopify/ProductVariant/"
TOOL_CALL = """async (doc, {name, args}) => {
    const context = doc.modelContext;
    const tool = (await context?.getTools())?.find(candidate =>
        candidate.name === name && candidate.window === window && candidate.origin === location.origin
    );
    const raw = tool ? await context.executeTool(tool, args) : null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
}"""


@dataclass(frozen=True)
class Quote:
    items: dict[str, int]
    currency: str
    total: int


def read_total(checkout: dict) -> tuple[str, int] | None:
    currency = checkout.get("currency")
    totals = checkout.get("totals")
    if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency) or not isinstance(totals, list):
        return None
    amounts = [row.get("amount") for row in totals if isinstance(row, dict) and row.get("type") == "total"]
    if len(amounts) == 1 and type(amounts[0]) is int and 0 <= amounts[0] <= 10**12:
        return currency, amounts[0]
    return None


def total_rows(checkout: dict) -> list[dict]:
    rows = []
    for row in checkout["totals"]:
        kind, amount = row["type"], row["amount"]
        if (not isinstance(kind, str) or not re.fullmatch(r"[a-z][a-z0-9_.-]{0,47}", kind)
                or type(amount) is not int or abs(amount) > 10**12):
            raise ValueError("Invalid Shopify checkout total.")
        result = {"type": kind, "amount": amount}
        display = row.get("display_text")
        if isinstance(display, str) and display.strip():
            result["display_text"] = " ".join(display.split())[:250]
        rows.append(result)
    return rows


def totals_binding(rows: list[dict]) -> tuple[tuple[str, int], ...]:
    return tuple(sorted((row["type"], row["amount"]) for row in rows))


def read_quote(checkout: dict) -> Quote | None:
    if not isinstance(checkout.get("status"), str) or checkout["status"] not in QUOTE_STATES:
        return None
    total = read_total(checkout)
    lines = checkout.get("line_items")
    if not total or not isinstance(lines, list) or not lines:
        return None
    items = {}
    for line in lines:
        product = line.get("item") if isinstance(line, dict) else None
        identity = product.get("id") if isinstance(product, dict) else None
        quantity = line.get("quantity") if isinstance(line, dict) else None
        if not isinstance(identity, str) or not identity.startswith(VARIANT_PREFIX) or type(quantity) is not int or quantity < 1:
            return None
        variant = identity.removeprefix(VARIANT_PREFIX)
        if not VARIANT_ID.fullmatch(variant) or variant in items:
            return None
        items[variant] = quantity
    return Quote(items, *total)


def current_route(page: Page) -> tuple[str, str, str | None] | None:
    try:
        return checkout_route(page.url)
    except ValueError:
        return None


def checkout_step(checkout: dict) -> tuple[str, list[str]] | None:
    step = checkout.get("webmcp", {}).get("step")
    if step is None:
        return None
    current, steps = step.get("current"), step.get("all")
    if (not isinstance(steps, list) or "payment" not in steps or current not in steps
            or steps != [known for known in CHECKOUT_STEPS if known in steps]):
        raise ValueError("Unsupported Shopify checkout steps.")
    return current, steps


async def read_shopify_checkout(page: Page) -> tuple[dict | None, str]:
    status = "unavailable"
    route = current_route(page)
    if route is None:
        return None, status
    try:
        async with asyncio.timeout(12):
            await page.wait_for_function(
                """async () => (await document.modelContext?.getTools())?.some(
                    tool => tool.name === 'get_checkout' && tool.window === window
                        && tool.origin === location.origin
                )""",
                timeout=5_000,
            )
            document = await page.evaluate_handle("document")
            while current_route(page) == route:
                raw = await document.evaluate(TOOL_CALL, {"name": "get_checkout", "args": {}})
                if current_route(page) != route:
                    break
                checkout = raw
                if isinstance(checkout, dict):
                    if isinstance(checkout.get("ucp"), dict) and checkout["ucp"].get("status") == "success":
                        return checkout, "available"
                    error = checkout.get("error")
                    code = error.get("code") if isinstance(error, dict) else error
                    message = error.get("message") if isinstance(error, dict) else None
                    if (
                        code == "internal_error" and isinstance(message, str)
                        and message.startswith("Checkout is initializing.")
                    ):
                        status = "initializing"
                    elif isinstance(code, str) and re.fullmatch(r"[a-z_]{1,48}", code):
                        return None, code
                    else:
                        return None, "unavailable"
                elif checkout is not None or status != "initializing":
                    return None, "unavailable"
                await asyncio.sleep(0.25)
    except (Error, TimeoutError, ValueError):
        pass
    return None, status if current_route(page) == route else "checkout_changed"


async def change_shopify_checkout(page: Page, name: str, args: dict, timeout: int) -> dict | None:
    route = current_route(page)
    if route is None or route[2] == "thank-you":
        return None
    try:
        async with asyncio.timeout(timeout):
            document = await page.evaluate_handle("document")
            state = await document.evaluate(TOOL_CALL, {"name": name, "args": args})
    except (Error, TimeoutError, ValueError):
        return None
    current = current_route(page)
    if (
        current is not None and current[:2] == route[:2] and current[2] != "thank-you"
        and isinstance(state, dict) and isinstance(state.get("ucp"), dict)
        and state["ucp"].get("status") == "success"
    ):
        return state
    return None


async def update_shopify_checkout(page: Page, checkout: dict) -> dict | None:
    return await change_shopify_checkout(page, "update_checkout", {"checkout": checkout}, 32)


async def navigate_shopify_checkout(page: Page, destination: str) -> None:
    await change_shopify_checkout(page, "navigate_checkout", {"destination": destination}, 16)
