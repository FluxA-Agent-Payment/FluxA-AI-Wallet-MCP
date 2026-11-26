"""Run an approved Shopify test checkout in a disposable browser."""

import asyncio
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import Error, Locator, Page, async_playwright

from shopify.runtime import build_sensitive_data, normalize_profile
from shopify.security import looks_like_security_verification

from .buyer import Guest, approved_groups, shipping_matches, shipping_method
from .contract import (
    ORDER_ID, RECEIPT_PATH, RECEIPT_TIMEOUT, RESOLVED_STORAGE,
    CheckoutGrant, checkout_identity, checkout_route, uses_test_data, validate_approval,
)
from .observation import (
    Quote, checkout_step, current_route, navigate_shopify_checkout, read_quote, read_shopify_checkout, read_total,
    total_rows, totals_binding, update_shopify_checkout,
)
from .one_page import FORM, card_matches, form_matches, opt_out, payment_action, select_card, shows_test_gateway

MANUAL = re.compile(r"verify your identity|authenticate your payment|verification code|3[- ]?D Secure", re.I)
DECLINED = re.compile(r"card (?:was |has been )?declined|payment was declined", re.I)


def at_checkout(page: Page, identity: tuple[str, str]) -> bool:
    try:
        return checkout_identity(page.url) == identity
    except ValueError:
        return False


async def shows_decline(page: Page) -> bool:
    alerts = await page.get_by_role("alert").filter(visible=True).all_inner_texts()
    return any(DECLINED.search(alert) for alert in alerts)


async def post_submit(
    page: Page, identity: tuple[str, str], checkout_id: str, approved: Quote, *, watch_for_decline: bool = False,
) -> dict:
    try:
        async with asyncio.timeout(RECEIPT_TIMEOUT):
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
                elif watch_for_decline and at_checkout(page, identity) and await shows_decline(page):
                    if at_checkout(page, identity):
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
    route: tuple[str, str, str | None]
    totals: tuple[tuple[str, int], ...] | None = None
    live_card: bool = False


def check_snapshot(
    page: Page, identity: tuple[str, str], state: dict | None, checkout_id: str | None = None,
    *, items: dict, expires_at: float,
) -> Quote:
    if time.time() >= expires_at:
        raise CheckoutStopped("approval_expired")
    quote = read_quote(state) if state else None
    found_id = state.get("id") if state else None
    if not at_checkout(page, identity) or not quote or not isinstance(found_id, str) or not found_id:
        raise CheckoutStopped("checkout_unavailable")
    if checkout_id is not None and found_id != checkout_id:
        raise CheckoutStopped("checkout_unavailable")
    if quote.items != items:
        raise CheckoutStopped("cart_mismatch")
    return quote


async def approved_checkout(page: Page, grant: CheckoutGrant, identity: tuple[str, str], checkout_id: str | None = None):
    state, _ = await read_shopify_checkout(page)
    return state, check_snapshot(page, identity, state, checkout_id, items=grant.items, expires_at=grant.expires_at)


def approved_details(state: dict, guest: Guest, groups: dict) -> None:
    method = shipping_method(state)
    if not guest.matches(state, method):
        raise CheckoutStopped("identity_incomplete")
    if not shipping_matches(method, groups):
        raise CheckoutStopped("checkout_not_ready")


async def update_guest(
    page: Page, identity: tuple[str, str], state: dict, guest: Guest, groups: list[dict] | None,
    *, items: dict, expires_at: float,
) -> dict:
    route = current_route(page)
    updated = await update_shopify_checkout(page, guest.update(state, groups))
    if updated is None and current_route(page) == route:
        # Shopify can apply an update even when its WebMCP response fails.
        updated, _ = await read_shopify_checkout(page)
    if not updated or current_route(page) != route or checkout_step(updated) != checkout_step(state):
        raise CheckoutStopped("checkout_not_ready")
    check_snapshot(page, identity, updated, state["id"], items=items, expires_at=expires_at)
    method = shipping_method(updated)
    if not guest.contact_matches(updated, method):
        raise CheckoutStopped("identity_incomplete")
    if groups is not None:
        selections = {group["id"]: {key: value for key, value in group.items() if key != "id"} for group in groups}
        if not shipping_matches(method, selections):
            raise CheckoutStopped("checkout_not_ready")
    return updated


async def advance_to_payment(page: Page, grant: CheckoutGrant, identity: tuple[str, str], state: dict, guest: Guest):
    checkout_id = state["id"]
    method = shipping_method(state)
    if bool(method) != bool(guest.delivery):
        raise CheckoutStopped("identity_incomplete")
    if bool(method) != bool(grant.shipping_options):
        raise CheckoutStopped("checkout_not_ready")
    step = checkout_step(state)
    current = step[0] if step else None
    if current_route(page) != (*identity, current):
        raise CheckoutStopped("checkout_unavailable")

    groups = approved_groups(method, grant.shipping_options) if current != "information" else None
    if current in {"shipping", "payment"} and groups is None:
        raise CheckoutStopped("checkout_not_ready")
    state = await update_guest(page, identity, state, guest, groups, items=grant.items, expires_at=grant.expires_at)
    if current is None and groups is None:
        groups = approved_groups(shipping_method(state), grant.shipping_options)
        if groups is None:
            raise CheckoutStopped("checkout_not_ready")
        await update_guest(page, identity, state, guest, groups, items=grant.items, expires_at=grant.expires_at)
    while step and step[0] in {"information", "shipping"}:
        current, steps = step
        destination = steps[steps.index(current) + 1]
        if current == "information" and not await opt_out(page, fill=True):
            raise CheckoutStopped("identity_incomplete")
        await navigate_shopify_checkout(page, destination)
        state, _ = await approved_checkout(page, grant, identity, checkout_id)
        step = checkout_step(state)
        if step != (destination, steps) or current_route(page) != (*identity, destination):
            raise CheckoutStopped("checkout_not_ready")
        if destination == "shipping":
            groups = approved_groups(shipping_method(state), grant.shipping_options)
            if groups is None:
                raise CheckoutStopped("checkout_not_ready")
            await update_guest(page, identity, state, guest, groups, items=grant.items, expires_at=grant.expires_at)
    if current_route(page) != (*identity, "payment" if step else None):
        raise CheckoutStopped("checkout_unavailable")


async def prepare_checkout(page: Page, grant: CheckoutGrant, profile: dict, gateway: str):
    """Fill and verify the approved checkout. Return the actionable control without submitting."""
    try:
        validate_approval(grant)
        identity = checkout_identity(grant.checkout_url)
        normalized = normalize_profile(profile, require_postal=False)
        data = build_sensitive_data(normalized)
    except (KeyError, TypeError, ValueError):
        return "checkout_unavailable", None
    if not uses_test_data(gateway, data["guest_email"], data["card_number"]):
        return "test_data_required", None
    if time.time() >= grant.expires_at:
        return "approval_expired", None

    try:
        response = await page.goto(grant.checkout_url, wait_until="domcontentloaded", timeout=25_000)
        if response and response.status in {403, 429}:
            return "manual_verification", None
        current = urlsplit(page.url)
        if current.scheme == "https" and current.netloc == identity[0] and current.path.rstrip("/") == "/password":
            password = profile.get("storefront_password")
            if not password:
                return "manual_verification", None
            field = page.locator("input[name='password']:visible")
            if not await field.count():
                await page.get_by_text("Enter using password", exact=True).click(timeout=5_000)
            await field.fill(password, timeout=5_000)
            async with page.expect_navigation(wait_until="domcontentloaded", timeout=15_000) as navigation:
                await field.press("Enter", timeout=5_000)
            response = await navigation.value
            if response and response.status in {403, 429}:
                return "manual_verification", None
            response = await page.goto(grant.checkout_url, wait_until="domcontentloaded", timeout=25_000)
            if response and response.status in {403, 429}:
                return "manual_verification", None
        text = await page.locator("body").inner_text(timeout=5_000)
        if looks_like_security_verification(text) or MANUAL.search(text):
            return "manual_verification", None
        if not at_checkout(page, identity):
            return "checkout_unavailable", None
    except Error:
        return "checkout_unavailable", None

    try:
        if current_route(page) == (*identity, "review"):
            return "checkout_not_ready", None
        initial, _ = await approved_checkout(page, grant, identity)
        checkout_id = initial["id"]
        step = checkout_step(initial)
        guest = Guest.from_profile(profile, normalized)
        if initial["status"] == "requires_escalation":
            return "checkout_not_ready", None
        await advance_to_payment(page, grant, identity, initial, guest)
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

    return await fill_payment(page, grant, identity, guest, checkout_id, form, data, payment_route, step=step)


async def fill_payment(
    page: Page, grant: CheckoutGrant, identity: tuple[str, str], guest: Guest, checkout_id: str,
    form: Locator, data: dict, payment_route: tuple[str, str, str | None] | None,
    *, step=None, quoted: PreparedCheckout | None = None, live_card: bool = False,
):
    approved = Quote(grant.items, grant.currency, grant.total_minor_units)
    first_kind = quoted.kind if quoted else None
    totals = quoted.totals if quoted else None
    for fill in (True, False):
        try:
            state, quote = await approved_checkout(page, grant, identity, checkout_id)
            # A later payment step can expose billing and opt-in fields after the tender mounts.
            if fill and step and quote == approved:
                method = shipping_method(state)
                if not guest.matches(state, method):
                    groups = approved_groups(method, grant.shipping_options)
                    if groups is None or not shipping_matches(method, grant.shipping_options):
                        return "checkout_not_ready", None
                    state = await update_guest(
                        page, identity, state, guest, groups, items=grant.items, expires_at=grant.expires_at,
                    )
                    quote = read_quote(state)
            if totals is not None and totals_binding(total_rows(state)) != totals:
                return "total_mismatch", None
        except CheckoutStopped as exc:
            return str(exc), None
        except (AttributeError, KeyError, TypeError, ValueError):
            return "identity_incomplete", None
        if current_route(page) != payment_route:
            return "checkout_unavailable", None
        if state["status"] != "ready_for_complete" and not (fill and quoted and state["status"] == "incomplete"):
            return "checkout_not_ready", None
        if quote != approved:
            return "total_mismatch", None
        try:
            approved_details(state, guest, grant.shipping_options)
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
            if first_kind is not None and kind != first_kind:
                return "checkout_not_ready", None
            first_kind = kind
        except Error:
            return "unsupported_checkout", None
        except (AttributeError, TypeError, ValueError):
            return "checkout_not_ready", None
        try:
            if live_card and await shows_test_gateway(page):
                return "payment_method_unavailable", None
            if not await card_matches(form, data, fill=fill, checkout_origin=f"https://{identity[0]}" if live_card else None):
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
            PreparedCheckout(button, kind, checkout_id, guest, payment_route, totals, live_card))


def left_payment(url: str, route: tuple[str, str, str | None]) -> bool:
    try:
        return checkout_route(url) != route
    except ValueError:
        return True


def check_review(state: dict) -> None:
    interactive = [message for message in state.get("messages", [])
                   if isinstance(message, dict) and str(message.get("severity", "")).startswith("requires_buyer_")]
    if any(message.get("severity") != "requires_buyer_review"
           or message.get("code") != "buyer_review_required" for message in interactive):
        raise CheckoutStopped("manual_verification")
    if state["status"] != "ready_for_complete" and not (state["status"] == "requires_escalation" and interactive):
        raise CheckoutStopped("checkout_not_ready")


async def reviewed_payment(page: Page, quote: Quote) -> Locator:
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


async def check_payment_snapshot(
    page: Page, grant: CheckoutGrant, identity: tuple[str, str], approved: Quote,
    prepared: PreparedCheckout, *, review: bool,
) -> None:
    route = (*identity, "review") if review else prepared.route
    state, quote = await approved_checkout(page, grant, identity, prepared.checkout_id)
    if quote != approved or (prepared.totals is not None and totals_binding(total_rows(state)) != prepared.totals):
        raise CheckoutStopped("total_mismatch")
    approved_details(state, prepared.guest, grant.shipping_options)
    step = checkout_step(state)
    if current_route(page) != route or (step and step[0] != route[2]):
        raise CheckoutStopped("checkout_not_ready")
    if prepared.live_card and await shows_test_gateway(page):
        raise CheckoutStopped("payment_method_unavailable")
    if review:
        check_review(state)
    elif (state["status"] != "ready_for_complete"
          or step and (("review" in step[1]) != (prepared.kind == "review"))):
        raise CheckoutStopped("checkout_not_ready")


async def click_approved(
    page: Page, grant: CheckoutGrant, identity: tuple[str, str], approved: Quote,
    prepared: PreparedCheckout, button: Locator, *, review: bool,
) -> bool:
    try:
        handle = await button.element_handle(timeout=1_000)
        watch_for_decline = (review or prepared.kind == "pay") and not await shows_decline(page)
    except Error as exc:
        raise CheckoutStopped("unsupported_checkout") from exc
    await check_payment_snapshot(page, grant, identity, approved, prepared, review=review)
    timeout = min(1_000, int((grant.expires_at - time.time()) * 1_000))
    if timeout <= 0:
        raise CheckoutStopped("approval_expired")
    # A pinned handle avoids resolving the submit control again in a replacement document.
    await handle.click(timeout=timeout, no_wait_after=True)
    return watch_for_decline


async def run_checkout(page: Page, grant: CheckoutGrant, profile: dict, gateway: str) -> dict:
    status, prepared = await prepare_checkout(page, grant, profile, gateway)
    if prepared is None:
        return {"status": status}
    return await submit_prepared(page, grant, prepared)


async def submit_prepared(page: Page, grant: CheckoutGrant, prepared: PreparedCheckout) -> dict:
    identity = checkout_identity(grant.checkout_url)
    approved = Quote(grant.items, grant.currency, grant.total_minor_units)
    try:
        watch_for_decline = await click_approved(page, grant, identity, approved, prepared, prepared.button, review=False)
    except CheckoutStopped as exc:
        return {"status": str(exc)}
    except Error:
        return await post_submit(page, identity, prepared.checkout_id, approved)
    except (AttributeError, KeyError, TypeError, ValueError):
        return {"status": "checkout_not_ready"}

    if prepared.kind == "review":
        try:
            await page.wait_for_url(lambda url: left_payment(url, prepared.route), timeout=10_000)
        except Error:
            return await post_submit(page, identity, prepared.checkout_id, approved)
        route = current_route(page)
        if route != (*identity, "review"):
            if route == (*identity, "thank-you"):
                return await post_submit(page, identity, prepared.checkout_id, approved)
            return {"status": "reconciliation_required"}
        try:
            await check_payment_snapshot(page, grant, identity, approved, prepared, review=True)
            button = await reviewed_payment(page, approved)
        except CheckoutStopped as exc:
            return {"status": str(exc)}
        except (AttributeError, Error, KeyError, TypeError, ValueError):
            return {"status": "checkout_not_ready"}
        try:
            watch_for_decline = await click_approved(page, grant, identity, approved, prepared, button, review=True)
        except CheckoutStopped as exc:
            return {"status": str(exc)}
        except Error:
            return await post_submit(page, identity, prepared.checkout_id, approved)
        except (AttributeError, KeyError, TypeError, ValueError):
            return {"status": "checkout_not_ready"}
    return await post_submit(page, identity, prepared.checkout_id, approved, watch_for_decline=watch_for_decline)


async def main(payload: dict) -> dict:
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=["--disable-quic", "--enable-features=WebMCP"])
        storage = Path(RESOLVED_STORAGE)
        try:
            page = await browser.new_page(
                locale="en-US", service_workers="block", accept_downloads=False,
                storage_state=storage if storage.is_file() else None,
            )
            storage.unlink(missing_ok=True)
            page.set_default_timeout(5_000)
            return await run_checkout(page, CheckoutGrant(**payload["grant"]), payload["profile"], payload["gateway"])
        finally:
            try:
                await browser.close()
            except Error:
                pass


def write_result(path: str, outcome: dict) -> None:
    receipt = Path(path)
    pending = receipt.with_name(f".{receipt.name}.{os.getpid()}")
    pending.write_text(json.dumps(outcome), encoding="utf-8")
    pending.replace(receipt)


if __name__ == "__main__":
    try:
        outcome = asyncio.run(main(json.loads(sys.stdin.readline(64 * 1024))))
    except Exception:
        outcome = {"status": "reconciliation_required"}
    try:
        write_result(RECEIPT_PATH, outcome)
    except OSError:
        pass
    print(json.dumps(outcome), flush=True)
