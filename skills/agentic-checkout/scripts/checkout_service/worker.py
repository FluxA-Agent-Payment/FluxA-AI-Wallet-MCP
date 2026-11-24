"""Run an approved Shopify test checkout in a disposable browser."""

import asyncio
import json
import re
import sys
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

from playwright.async_api import Error, Locator, Page, async_playwright

from shopify.runtime import build_sensitive_data, normalize_profile
from shopify.security import looks_like_security_verification

from .buyer import Guest, selected_groups, shipping_method
from .contract import ORDER_ID, CheckoutGrant, checkout_identity, checkout_route, uses_test_data, validate_approval
from .observation import (
    Quote, checkout_step, current_route, navigate_shopify_checkout, read_quote, read_shopify_checkout, read_total,
    update_shopify_checkout,
)
from .one_page import FORM, card_matches, form_matches, opt_out, payment_action, select_card

MANUAL = re.compile(r"verify your identity|authenticate your payment|verification code|3[- ]?D Secure", re.I)
DECLINED = re.compile(r"card (?:was |has been )?declined|payment was declined", re.I)


def at_checkout(page: Page, identity: tuple[str, str]) -> bool:
    try:
        return checkout_identity(page.url) == identity
    except ValueError:
        return False


async def post_submit(page: Page, identity: tuple[str, str], checkout_id: str, approved: Quote) -> dict:
    try:
        async with asyncio.timeout(25):
            while True:
                if current_route(page) == (*identity, "thank-you"):
                    state, _ = await read_shopify_checkout(page)
                    order = state.get("order") if state else None
                    order_id = order.get("id") if isinstance(order, dict) else None
                    if state and state.get("status") == "completed":
                        if (
                            state.get("id") == checkout_id
                            and read_total(state) == (approved.currency, approved.total)
                            and isinstance(order_id, str) and ORDER_ID.fullmatch(order_id)
                        ):
                            return {"status": "submitted", "order_id": order_id}
                        return {"status": "reconciliation_required"}
                elif at_checkout(page, identity):
                    alerts = await page.get_by_role("alert").filter(visible=True).all_inner_texts()
                    if any(DECLINED.search(alert) for alert in alerts):
                        return {"status": "payment_failed"}
                await asyncio.sleep(0.3)
    except (Error, TimeoutError):
        return {"status": "reconciliation_required"}


class CheckoutStopped(Exception):
    """A pre-submit condition that has a public checkout result."""


@dataclass(frozen=True, repr=False)
class PreparedCheckout:
    button: Locator
    kind: str
    checkout_id: str
    guest: Guest
    groups: dict


async def approved_checkout(page: Page, grant: CheckoutGrant, identity: tuple[str, str], checkout_id: str | None = None):
    state, _ = await read_shopify_checkout(page)
    quote = read_quote(state) if state else None
    found_id = state.get("id") if state else None
    if not at_checkout(page, identity) or not quote or not isinstance(found_id, str) or not found_id:
        raise CheckoutStopped("checkout_unavailable")
    if checkout_id is not None and found_id != checkout_id:
        raise CheckoutStopped("checkout_unavailable")
    if quote.items != grant.items:
        raise CheckoutStopped("cart_mismatch")
    if time.time() >= grant.expires_at:
        raise CheckoutStopped("approval_expired")
    return state, quote


def approved_details(state: dict, guest: Guest, groups: dict) -> dict:
    method = shipping_method(state)
    if not guest.matches(state, method):
        raise CheckoutStopped("identity_incomplete")
    current_groups = selected_groups(method)
    if any(current_groups.get(key) != group for key, group in groups.items()):
        raise CheckoutStopped("checkout_not_ready")
    return current_groups


async def advance_to_payment(page: Page, grant: CheckoutGrant, identity: tuple[str, str], checkout_id: str):
    state, _ = await approved_checkout(page, grant, identity, checkout_id)
    step = checkout_step(state)
    while step and step[0] in {"information", "shipping"}:
        current, steps = step
        destination = steps[steps.index(current) + 1]
        if current_route(page) != (*identity, current):
            raise CheckoutStopped("checkout_unavailable")
        if current == "information" and not await opt_out(page, fill=True):
            raise CheckoutStopped("identity_incomplete")
        await navigate_shopify_checkout(page, destination)
        state, _ = await approved_checkout(page, grant, identity, checkout_id)
        step = checkout_step(state)
        if step != (destination, steps) or current_route(page) != (*identity, destination):
            raise CheckoutStopped("checkout_not_ready")
    if current_route(page) != (*identity, "payment" if step else None):
        raise CheckoutStopped("checkout_unavailable")


async def prepare_checkout(page: Page, grant: CheckoutGrant, profile: dict, gateway: str):
    """Fill and verify the approved checkout. Return the actionable control without submitting."""
    try:
        validate_approval(grant)
        identity = checkout_identity(grant.checkout_url)
        data = build_sensitive_data(normalize_profile(profile, require_postal=False))
    except (KeyError, TypeError, ValueError):
        return "checkout_unavailable", None
    if not uses_test_data(gateway, data["guest_email"], data["card_number"]):
        return "test_data_required", None
    if time.time() >= grant.expires_at:
        return "approval_expired", None

    try:
        await page.goto(grant.checkout_url, wait_until="domcontentloaded", timeout=25_000)
        current = urlsplit(page.url)
        if current.scheme == "https" and current.netloc == identity[0] and current.path.rstrip("/") == "/password":
            password = profile.get("storefront_password")
            if not password:
                return "manual_verification", None
            field = page.locator("input[name='password']:visible")
            if not await field.count():
                await page.get_by_text("Enter using password", exact=True).click(timeout=5_000)
            await field.fill(password, timeout=5_000)
            async with page.expect_navigation(wait_until="domcontentloaded", timeout=15_000):
                await field.press("Enter", timeout=5_000)
            await page.goto(grant.checkout_url, wait_until="domcontentloaded", timeout=25_000)
        if not at_checkout(page, identity):
            return "checkout_unavailable", None
        text = await page.locator("body").inner_text(timeout=5_000)
        if looks_like_security_verification(text) or MANUAL.search(text):
            return "manual_verification", None
    except Error:
        return "checkout_unavailable", None

    approved = Quote(grant.items, grant.currency, grant.total_minor_units)
    try:
        if current_route(page) == (*identity, "review"):
            return "checkout_not_ready", None
        initial, _ = await approved_checkout(page, grant, identity)
        checkout_id = initial["id"]
        step = checkout_step(initial)
        guest = Guest.from_profile(profile, data)
        method = shipping_method(initial)
        groups = selected_groups(method)
        update = guest.update(initial, method)
        if initial["status"] == "requires_escalation" or not await update_shopify_checkout(page, update):
            return "checkout_not_ready", None
        await advance_to_payment(page, grant, identity, checkout_id)
    except CheckoutStopped as exc:
        return str(exc), None
    except (AttributeError, Error, KeyError, TypeError, ValueError):
        return "identity_incomplete", None

    form = page.locator(FORM).filter(visible=True)
    payment_route = current_route(page)
    try:
        await form.wait_for(timeout=5_000)
        if not await select_card(form):
            return "payment_method_unavailable", None
    except Error:
        return "unsupported_checkout", None

    for fill in (True, False):
        try:
            state, quote = await approved_checkout(page, grant, identity, checkout_id)
            # A later payment step can expose billing and opt-in fields after the tender mounts.
            if fill and step and quote == approved:
                method = shipping_method(state)
                if not guest.matches(state, method):
                    if not await update_shopify_checkout(page, guest.update(state, method)):
                        return "checkout_not_ready", None
                    state, quote = await approved_checkout(page, grant, identity, checkout_id)
        except CheckoutStopped as exc:
            return str(exc), None
        except (AttributeError, KeyError, TypeError, ValueError):
            return "identity_incomplete", None
        if current_route(page) != payment_route:
            return "checkout_unavailable", None
        if state["status"] != "ready_for_complete":
            return "checkout_not_ready", None
        if quote != approved:
            return "total_mismatch", None
        try:
            groups = approved_details(state, guest, groups)
        except CheckoutStopped as exc:
            return str(exc), None
        except (AttributeError, KeyError, TypeError, ValueError):
            return "identity_incomplete", None
        try:
            if not await form_matches(form, delivery=bool(guest.delivery), same_address=guest.same_as_delivery, fill=fill):
                return "identity_incomplete", None
        except Error:
            return "identity_incomplete", None
        try:
            action = await payment_action(form, approved.currency, approved.total)
            if action is None:
                return "unsupported_checkout", None
            kind, button = action
            payment_step = checkout_step(state)
            if payment_step and (("review" in payment_step[1]) != (kind == "review")):
                return "checkout_not_ready", None
            if not fill and kind != first_kind:
                return "checkout_not_ready", None
            first_kind = kind
        except Error:
            return "unsupported_checkout", None
        except (AttributeError, TypeError, ValueError):
            return "checkout_not_ready", None
        try:
            if not await card_matches(form, data, fill=fill):
                return "payment_fields_incomplete", None
        except Error:
            return "payment_fields_incomplete", None
        try:
            if fill:
                await button.click(trial=True, timeout=5_000)
        except Error:
            return "unsupported_checkout", None
    if current_route(page) != payment_route:
        return "checkout_unavailable", None
    if time.time() >= grant.expires_at:
        return "approval_expired", None
    return ("review_ready" if kind == "review" else "ready",
            PreparedCheckout(button, kind, checkout_id, guest, groups))


def review_or_receipt(url: str, identity: tuple[str, str]) -> bool:
    try:
        route = checkout_route(url)
    except ValueError:
        return False
    return route[:2] == identity and route[2] in {"review", "thank-you"}


async def reviewed_payment(
    page: Page, grant: CheckoutGrant, identity: tuple[str, str], prepared: PreparedCheckout,
) -> Locator:
    state, quote = await approved_checkout(page, grant, identity, prepared.checkout_id)
    if quote != Quote(grant.items, grant.currency, grant.total_minor_units):
        raise CheckoutStopped("total_mismatch")
    approved_details(state, prepared.guest, prepared.groups)
    step = checkout_step(state)
    if current_route(page) != (*identity, "review") or (step and step[0] != "review"):
        raise CheckoutStopped("checkout_not_ready")
    interactive = [message for message in state.get("messages", [])
                   if isinstance(message, dict) and str(message.get("severity", "")).startswith("requires_buyer_")]
    if any(message.get("severity") != "requires_buyer_review"
           or message.get("code") != "buyer_review_required" for message in interactive):
        raise CheckoutStopped("manual_verification")
    if state["status"] != "ready_for_complete" and not (state["status"] == "requires_escalation" and interactive):
        raise CheckoutStopped("checkout_not_ready")
    text = await page.locator("body").inner_text(timeout=5_000)
    if looks_like_security_verification(text) or MANUAL.search(text):
        raise CheckoutStopped("manual_verification")
    form = page.locator(FORM).filter(visible=True)
    if not await form_matches(form, delivery=False, same_address=False, fill=False):
        raise CheckoutStopped("manual_verification")
    action = await payment_action(form, quote.currency, quote.total)
    if not action or action[0] != "pay":
        raise CheckoutStopped("unsupported_checkout")
    return action[1]


async def run_checkout(page: Page, grant: CheckoutGrant, profile: dict, gateway: str) -> dict:
    status, prepared = await prepare_checkout(page, grant, profile, gateway)
    if prepared is None:
        return {"status": status}
    identity = checkout_identity(grant.checkout_url)
    approved = Quote(grant.items, grant.currency, grant.total_minor_units)
    button = prepared.button
    if prepared.kind == "review":
        try:
            await button.click(timeout=5_000)
            await page.wait_for_url(lambda url: review_or_receipt(url, identity), timeout=10_000)
        except Error:
            return await post_submit(page, identity, prepared.checkout_id, approved)
        if current_route(page) == (*identity, "thank-you"):
            return await post_submit(page, identity, prepared.checkout_id, approved)
        try:
            button = await reviewed_payment(page, grant, identity, prepared)
        except CheckoutStopped as exc:
            return {"status": str(exc)}
        except (AttributeError, Error, KeyError, TypeError, ValueError):
            return {"status": "checkout_not_ready"}
    if time.time() >= grant.expires_at:
        return {"status": "approval_expired"}
    try:
        await button.click(timeout=5_000)
        return await post_submit(page, identity, prepared.checkout_id, approved)
    except Exception:
        # A lost browser response may follow a successful click.
        return {"status": "reconciliation_required"}


async def main(payload: dict) -> dict:
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=["--disable-quic", "--enable-features=WebMCP"])
        page = await browser.new_page(locale="en-US", service_workers="block", accept_downloads=False)
        page.set_default_timeout(5_000)
        try:
            return await run_checkout(page, CheckoutGrant(**payload["grant"]), payload["profile"], payload["gateway"])
        finally:
            try:
                await browser.close()
            except Error:
                pass


if __name__ == "__main__":
    try:
        outcome = asyncio.run(main(json.loads(sys.stdin.readline(64 * 1024))))
    except Exception:
        outcome = {"status": "reconciliation_required"}
    print(json.dumps(outcome), flush=True)
