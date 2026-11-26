"""Quote and submit one approved Shopify test purchase in the same browser."""

import asyncio
import json
import math
import sys
import time
from collections.abc import Awaitable, Callable
from hashlib import sha256
from pathlib import Path

from playwright.async_api import Error, Page, async_playwright

from shopify.runtime import build_sensitive_data, normalize_guest_profile, normalize_profile
from shopify.security import digits, looks_like_security_verification

from .buyer import Guest, approved_groups, delivery_options, select_shipping, shipping_method
from .contract import (
    PURCHASE_QUOTE_PATH, PURCHASE_SELECTION_PATH, RECEIPT_PATH, RECEIPT_TIMEOUT, SANDBOX_TIMEOUT,
    CheckoutGrant, checkout_identity,
    uses_test_data, validate_approval, validate_selections,
)
from .observation import (
    checkout_step, current_route, navigate_shopify_checkout, read_shopify_checkout, total_rows, totals_binding,
)
from .one_page import FORM, blank_card_form, form_matches, opt_out, payment_action, select_card
from .preview import resolve_checkout
from .worker import (
    MANUAL, CheckoutStopped, PreparedCheckout, approved_details, check_snapshot, fill_payment, submit_prepared,
    update_guest, write_result,
)


class ShippingChoiceRequired(CheckoutStopped):
    def __init__(self, options: dict):
        super().__init__("shipping_option_required")
        self.options = options


async def prepare_quote(
    page: Page, payload: dict, expires_at: float, request_shipping: Callable[[dict], Awaitable[dict]],
) -> tuple[dict, CheckoutGrant, PreparedCheckout]:
    profile, items = payload["profile"], payload["items"]
    requested = payload.get("shipping_options")
    validate_selections(items, {} if requested is None else requested)
    if "payment" in profile:
        raise CheckoutStopped("checkout_unavailable")
    guest = Guest.from_profile(profile, normalize_guest_profile(profile))
    if not guest.email:
        raise CheckoutStopped("identity_incomplete")

    entry_url = payload["checkout_url"]
    resolved = await resolve_checkout(
        page, entry_url, payload["checkout_host"], profile.get("storefront_password"), export_storage=False,
    )
    if resolved["status"] != "resolved":
        raise CheckoutStopped(resolved["status"])
    checkout_url = resolved["checkout_url"]
    identity = checkout_identity(checkout_url)
    try:
        incoming_identity = checkout_identity(entry_url)
    except ValueError:
        # A cart link receives its checkout token from Shopify's redirect.
        incoming_identity = identity
    if identity != incoming_identity:
        raise CheckoutStopped("checkout_unavailable")
    text = await page.locator("body").inner_text()
    if looks_like_security_verification(text) or MANUAL.search(text):
        raise CheckoutStopped("manual_verification")

    scope = {"items": items, "expires_at": expires_at}
    checkout_id = None

    async def snapshot():
        state, _ = await read_shopify_checkout(page)
        return state, check_snapshot(page, identity, state, checkout_id, **scope)

    async def navigate(step):
        current, steps = step
        destination = steps[steps.index(current) + 1]
        await navigate_shopify_checkout(page, destination)
        state, _ = await snapshot()
        if checkout_step(state) != (destination, steps) or current_route(page) != (*identity, destination):
            raise CheckoutStopped("checkout_not_ready")
        return state

    state, _ = await snapshot()
    checkout_id = state["id"]
    step = checkout_step(state)
    route = step[0] if step else None
    if current_route(page) != (*identity, route) or route == "review":
        raise CheckoutStopped("checkout_not_ready")
    method = shipping_method(state)
    if bool(method) != bool(guest.delivery):
        raise CheckoutStopped("identity_incomplete")
    if not guest.contact_matches(state, method):
        state = await update_guest(page, identity, state, guest, None, **scope)
    if route == "information":
        if not await opt_out(page, fill=True):
            raise CheckoutStopped("identity_incomplete")
        state = await navigate(step)

    method = shipping_method(state)
    options = delivery_options(method)
    shipping = select_shipping(method, requested, options)
    if shipping is None:
        shipping_route, shipping_step = current_route(page), checkout_step(state)
        requested = await request_shipping(options)
        validate_selections(items, requested)
        state, _ = await snapshot()
        method = shipping_method(state)
        if (current_route(page) != shipping_route or checkout_step(state) != shipping_step
                or not guest.contact_matches(state, method)):
            raise CheckoutStopped("checkout_not_ready")
        options = delivery_options(method)
        shipping = select_shipping(method, requested, options)
        if shipping is None:
            raise ShippingChoiceRequired(options)
    validate_selections(items, shipping)
    groups = approved_groups(method, shipping)
    if groups is None:
        raise ShippingChoiceRequired(options)
    state = await update_guest(page, identity, state, guest, groups, **scope)
    step = checkout_step(state)
    if step and step[0] == "shipping":
        state = await navigate(step)
    step = checkout_step(state)
    payment_route = (*identity, "payment" if step else None)
    if current_route(page) != payment_route or (step and step[0] != "payment"):
        raise CheckoutStopped("checkout_not_ready")

    form = page.locator(FORM).filter(visible=True)
    try:
        await form.wait_for()
        if not await select_card(form) or not await blank_card_form(form):
            raise CheckoutStopped("payment_method_unavailable")
    except Error as exc:
        raise CheckoutStopped("unsupported_checkout") from exc

    state, _ = await snapshot()
    if not guest.matches(state, shipping_method(state)):
        state = await update_guest(page, identity, state, guest, groups, **scope)
    if not await form_matches(form, delivery=bool(guest.delivery), same_address=guest.same_as_delivery, fill=True):
        raise CheckoutStopped("identity_incomplete")
    state, observed = await snapshot()
    approved_details(state, guest, shipping)
    step = checkout_step(state)
    if (current_route(page) != payment_route or (step and step[0] != "payment")
            or state["status"] not in {"incomplete", "ready_for_complete"}
            or any(field.get("required") and field.get("value") in (None, "") for field in state.get("declared_fields", []))
            or any(message.get("severity", "").startswith("requires_buyer_") or message.get("severity") == "unrecoverable"
                   or (state["status"] == "incomplete" and message.get("type") == "error"
                       and message.get("path") != "$.payment")
                   for message in state.get("messages", []))):
        raise CheckoutStopped("checkout_not_ready")
    grant = CheckoutGrant(checkout_url, items, observed.total, observed.currency, expires_at, shipping)
    validate_approval(grant)
    action = await payment_action(form, observed.currency, observed.total)
    if action is None:
        raise CheckoutStopped("unsupported_checkout")
    kind, button = action
    if step and (("review" in step[1]) != (kind == "review")):
        raise CheckoutStopped("checkout_not_ready")
    rows = total_rows(state)
    prepared = PreparedCheckout(button, kind, checkout_id, guest, payment_route, totals_binding(rows))
    quote = {
        "currency": observed.currency, "minor_units": observed.total, "totals": rows,
        "shipping_options": shipping, "expires_at": expires_at,
    }
    if any(options.values()):
        quote["delivery_options"] = options
    return {
        "status": "quoted", "checkout_digest": sha256(identity[1].encode()).hexdigest(),
        "checkout_id_digest": sha256(checkout_id.encode()).hexdigest(), "quote": quote,
    }, grant, prepared


async def run_purchase(
    page: Page, payload: dict, publish_quote: Callable[[dict], None], read_next: Callable[[], Awaitable[dict | None]],
    *, publish_selection: Callable[[dict], None],
) -> dict | None:
    publish_result = publish_quote

    async def request_shipping(options: dict) -> dict:
        nonlocal publish_result
        publish_quote({
            "status": "requires_action", "reason": "shipping_option_required", "delivery_options": options,
            "selection_expires_at": expires_at,
        })
        publish_result = publish_selection
        selection = await read_next()
        if selection is None:
            raise CheckoutStopped("approval_expired")
        if not isinstance(selection, dict) or selection.keys() != {"shipping_options"}:
            raise ShippingChoiceRequired(options)
        return selection["shipping_options"]

    try:
        hard_deadline = payload["expires_at"]
        if type(hard_deadline) not in (int, float) or not math.isfinite(hard_deadline):
            raise ValueError("Invalid checkout deadline.")
        expires_at = min(hard_deadline, time.time() + SANDBOX_TIMEOUT) - RECEIPT_TIMEOUT - 5
        if expires_at <= time.time():
            raise CheckoutStopped("approval_expired")
        async with asyncio.timeout(expires_at - time.time()):
            result, grant, quoted = await prepare_quote(page, payload, expires_at, request_shipping)
    except ShippingChoiceRequired as exc:
        publish_result({"status": "requires_action", "reason": str(exc), "delivery_options": exc.options})
        return None
    except CheckoutStopped as exc:
        publish_result({"status": str(exc)})
        return None
    except TimeoutError:
        publish_result({"status": "approval_expired"})
        return None
    except (AttributeError, Error, KeyError, TypeError, ValueError):
        publish_result({"status": "checkout_unavailable"})
        return None

    publish_result(result)
    try:
        async with asyncio.timeout(expires_at - time.time()):
            approval = await read_next()
        if approval is None or time.time() >= expires_at:
            return {"status": "approval_expired"}
        payment = {key: approval["payment"][key] for key in ("card_number", "exp", "cvc", "name")}
        data = build_sensitive_data(normalize_profile({**payload["profile"], "payment": payment}, require_postal=False))
        if (not uses_test_data(approval["gateway"], quoted.guest.email, data["card_number"])
                or len(digits(data["card_exp"])) != 4 or len(digits(data["card_cvc"])) not in (3, 4)
                or not data["card_name"]):
            return {"status": "test_data_required"}
    except TimeoutError:
        return {"status": "approval_expired"}
    except (AttributeError, KeyError, TypeError, ValueError):
        return {"status": "test_data_required"}

    identity = checkout_identity(grant.checkout_url)
    form = page.locator(FORM).filter(visible=True)
    try:
        async with asyncio.timeout(expires_at - time.time()):
            text = await page.locator("body").inner_text()
            if looks_like_security_verification(text) or MANUAL.search(text):
                return {"status": "manual_verification"}
            status, prepared = await fill_payment(
                page, grant, identity, quoted.guest, quoted.checkout_id, form, data, quoted.route, quoted=quoted,
            )
    except TimeoutError:
        return {"status": "approval_expired"}
    except Error:
        return {"status": "checkout_unavailable"}
    return await submit_prepared(page, grant, prepared) if prepared else {"status": status}


async def read_message(stream: asyncio.StreamReader) -> dict | None:
    line = await stream.readline()
    return json.loads(line) if line else None


async def main() -> None:
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=64 * 1024)
    transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    try:
        payload = await read_message(reader)
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(args=["--disable-quic", "--enable-features=WebMCP"])
            try:
                page = await browser.new_page(locale="en-US", service_workers="block", accept_downloads=False)
                page.set_default_timeout(5_000)
                receipt = await run_purchase(
                    page, payload, lambda result: write_result(PURCHASE_QUOTE_PATH, result), lambda: read_message(reader),
                    publish_selection=lambda result: write_result(PURCHASE_SELECTION_PATH, result),
                )
                if receipt is not None:
                    write_result(RECEIPT_PATH, receipt)
            finally:
                try:
                    await browser.close()
                except Error:
                    pass
    finally:
        transport.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        quote = Path(PURCHASE_QUOTE_PATH)
        if not quote.is_file():
            write_result(PURCHASE_QUOTE_PATH, {"status": "checkout_unavailable"})
        elif (json.loads(quote.read_bytes())["status"] == "requires_action"
              and not Path(PURCHASE_SELECTION_PATH).is_file()):
            write_result(PURCHASE_SELECTION_PATH, {"status": "checkout_unavailable"})
        elif not Path(RECEIPT_PATH).is_file():
            write_result(RECEIPT_PATH, {"status": "reconciliation_required"})
