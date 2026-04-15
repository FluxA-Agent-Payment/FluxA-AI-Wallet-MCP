#!/usr/bin/env python3
"""Stripe checkout adapter for hosted and embedded checkout surfaces."""

from __future__ import annotations

from typing import Any
import asyncio
import re
import sys

from .common import click_first_visible, disable_save_info, ensure_checkbox_state, fill_first_matching, pause
from ..security import digits, looks_like_checkout_failure, looks_like_checkout_success, looks_like_security_verification, normalize_text


SAVE_INFO_PHRASES = [
    "save my information for faster checkout",
    "save my info for a faster checkout",
    "secure, fast checkout with link",
    "link",
]

LEGAL_CONSENT_PHRASES = [
    "i consent to the processing of my sensitive personal information",
    "cross-border transfer of my personal information outside mainland china",
]

STRIPE_FRAME_SELECTORS = [
    "iframe[name^='__privateStripeFrame']",
    "iframe[src*='stripe' i]",
    "iframe[src*='hooks.stripe.com' i]",
]


def _select_all_shortcut() -> str:
    return "Meta+A" if sys.platform == "darwin" else "Control+A"


async def _find_embedded_checkout_dialog(page: Any) -> Any | None:
    dialogs = page.locator("[role='dialog']")
    try:
        count = min(await dialogs.count(), 10)
    except Exception:
        return None

    for index in range(count):
        dialog = dialogs.nth(index)
        try:
            if not await dialog.is_visible(timeout=0):
                continue
        except Exception:
            continue

        has_email = False
        has_frame = False
        has_pay_button = False
        try:
            has_email = (await dialog.locator("input[type='email'], input[autocomplete='email'], input[name='email']").count()) > 0
        except Exception:
            pass
        try:
            has_frame = (await dialog.locator(", ".join(STRIPE_FRAME_SELECTORS)).count()) > 0
        except Exception:
            pass
        try:
            has_pay_button = (await dialog.get_by_role("button", name=re.compile(r"^pay$", re.I)).count()) > 0
        except Exception:
            pass

        try:
            text = normalize_text(await dialog.inner_text())
        except Exception:
            text = ""

        if (has_email or has_frame) and has_pay_button:
            return dialog
        if re.search(r"you.?ll be charged", text, re.I) and re.search(r"payment secured by", text, re.I):
            return dialog
    return None


async def _find_hosted_checkout_container(page: Any) -> Any | None:
    try:
        body = page.locator("body")
        body_text = normalize_text(await body.inner_text())
    except Exception:
        body = page.locator("body")
        body_text = ""

    has_email = False
    has_frame = False
    has_pay_button = False
    try:
        has_email = (
            await page.locator(
                "#GuestEmail, input[type='email'], input[autocomplete='email'], input[name='email'], input[name*='email' i]"
            ).count()
        ) > 0
    except Exception:
        pass
    try:
        has_frame = (await page.locator(", ".join(STRIPE_FRAME_SELECTORS)).count()) > 0
    except Exception:
        pass
    try:
        has_pay_button = (await page.get_by_role("button", name=re.compile(r"^pay now$", re.I)).count()) > 0
    except Exception:
        pass

    if has_email and has_frame and has_pay_button:
        return body
    if has_frame and re.search(r"email address", body_text, re.I) and re.search(r"pay now", body_text, re.I):
        return body
    return None


async def _get_candidate_frames(page: Any) -> list[Any]:
    try:
        frames = list(page.frames)
    except Exception:
        return [page]
    stripe_frames = [frame for frame in frames if "stripe.com" in str(getattr(frame, "url", "") or "").lower()]
    return stripe_frames or frames


async def _type_in_frame_locator(locator: Any, value: str, expected_digits: int | None = None) -> bool:
    try:
        count = min(await locator.count(), 10)
    except Exception:
        return False

    for index in range(count):
        candidate = locator.nth(index)
        try:
            if not await candidate.is_visible(timeout=0):
                continue
        except Exception:
            continue
        try:
            editable = await candidate.is_editable(timeout=0)
        except Exception:
            editable = True
        if not editable:
            continue

        try:
            await candidate.scroll_into_view_if_needed(timeout=2_000)
        except Exception:
            pass
        try:
            await candidate.click(timeout=2_000)
        except Exception:
            pass
        try:
            await candidate.press(_select_all_shortcut())
            await candidate.press("Backspace")
        except Exception:
            pass
        try:
            await candidate.fill("")
        except Exception:
            pass
        try:
            await candidate.type(str(value), delay=25)
        except Exception:
            try:
                await candidate.fill(str(value))
            except Exception:
                pass
        try:
            await candidate.evaluate("(node) => { if (typeof node.blur === 'function') node.blur(); }")
        except Exception:
            pass

        try:
            current_value = str(await candidate.input_value()).strip()
        except Exception:
            current_value = ""

        if expected_digits is not None:
            if len(digits(current_value)) >= expected_digits:
                return True
            continue
        if current_value:
            return True
    return False


async def _type_in_stripe_frames(
    page: Any,
    selectors: list[str],
    value: str,
    timeout_ms: int = 20_000,
    expected_digits: int | None = None,
) -> bool:
    deadline = asyncio.get_running_loop().time() + max(timeout_ms / 1000, 1)
    while asyncio.get_running_loop().time() < deadline:
        for frame in await _get_candidate_frames(page):
            for selector in selectors:
                try:
                    locator = frame.locator(selector)
                except Exception:
                    continue
                if await _type_in_frame_locator(locator, value, expected_digits=expected_digits):
                    return True
        await asyncio.sleep(0.25)
    return False


async def _type_by_role_in_stripe_frames(page: Any, role: str, name: str, value: str, timeout_ms: int = 8_000) -> bool:
    deadline = asyncio.get_running_loop().time() + max(timeout_ms / 1000, 1)
    pattern = re.compile(name, re.I)
    while asyncio.get_running_loop().time() < deadline:
        for frame in await _get_candidate_frames(page):
            try:
                locator = frame.get_by_role(role, name=pattern)
            except Exception:
                continue
            if await _type_in_frame_locator(locator, value):
                return True
        await asyncio.sleep(0.25)
    return False


async def _click_embedded_modal_submit(page: Any) -> bool:
    dialog = await _find_embedded_checkout_dialog(page)
    if dialog is None:
        return False
    try:
        if await click_first_visible(dialog, ["button:has-text('Pay')"], timeout_ms=2_000):
            return True
    except Exception:
        pass
    try:
        buttons = dialog.locator("button")
        count = min(await buttons.count(), 10)
    except Exception:
        return False
    for index in range(count):
        button = buttons.nth(index)
        try:
            text = normalize_text(await button.inner_text())
        except Exception:
            continue
        if re.fullmatch(r"pay", text, re.I):
            try:
                await button.click(timeout=2_000)
                return True
            except Exception:
                continue
    return False


async def _click_hosted_page_submit(page: Any) -> bool:
    hosted_surface = await _find_hosted_checkout_container(page)
    if hosted_surface is None:
        return False
    if await click_first_visible(page, ["button:has-text('Pay now')", "#stripe-payment-element--submit button"], timeout_ms=2_000):
        return True
    return False


async def _click_submit(page: Any) -> bool:
    if await _click_embedded_modal_submit(page):
        return True
    if await _click_hosted_page_submit(page):
        return True
    if await click_first_visible(page, ["button[type='submit']"], timeout_ms=2_000):
        return True
    if await click_first_visible(page, ["button:has-text('Pay')", "button:has-text('Subscribe')", "button:has-text('Purchase')"], timeout_ms=2_000):
        return True
    return False


async def _detect_outcome(page: Any) -> tuple[str, str]:
    body = normalize_text(await page.locator("body").inner_text(timeout=4_000))
    url = str(page.url or "")

    if looks_like_security_verification(body) or re.search(r"3d secure|authentication|verify|one[- ]time|otp", body, re.I):
        return "needs_3ds", "3DS or issuer verification is required."
    if re.search(r"processing|authorizing|confirming your payment|please wait", body, re.I):
        return "processing", "Stripe is processing the submission."
    if re.search(r"card was declined|declined|payment failed|insufficient|expired card|incomplete", body, re.I):
        return "fail", "Stripe reported a payment failure."
    if looks_like_checkout_success(body, url) or re.search(r"thank you|receipt|payment successful", body, re.I):
        return "success", "Stripe reached a success state."
    if looks_like_checkout_failure(body):
        return "fail", "Stripe displayed a failure state."

    lowered_url = url.lower()
    if any(marker in lowered_url for marker in ("success", "receipt")):
        return "success", "Stripe success URL matched."
    if any(marker in lowered_url for marker in ("fail", "error")):
        return "fail", "Stripe failure URL matched."
    return "unknown", "No terminal Stripe outcome was detected."


async def _wait_for_outcome_after_submit(page: Any, timeout_seconds: int = 30) -> tuple[str, str]:
    deadline = asyncio.get_running_loop().time() + max(timeout_seconds, 1)
    last_status = "unknown"
    last_hint = "No terminal Stripe outcome was detected."
    while asyncio.get_running_loop().time() < deadline:
        status, hint = await _detect_outcome(page)
        last_status, last_hint = status, hint
        if status in {"success", "fail", "needs_3ds"}:
            return status, hint
        await asyncio.sleep(1.0)
    if last_status == "processing":
        return "processing", "Stripe submission is still processing."
    return last_status, last_hint


async def run(page: Any, config: Any, sensitive_data: dict[str, str]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "provider": "stripe_hosted",
        "postalFilled": False,
        "saveInfoUnchecked": None,
        "legalConsentChecked": None,
        "outcome": {"status": "unknown", "hint": None},
    }

    card_digits_target = len(digits(sensitive_data["card_number"]))
    card_ok = await _type_in_stripe_frames(
        page,
        [
            "input[autocomplete='cc-number']",
            "input[name='cardnumber']",
            "input[aria-label*='Card number' i]",
            "input[placeholder*='1234']",
            "input[placeholder*='4242']",
        ],
        sensitive_data["card_number"],
        timeout_ms=25_000,
        expected_digits=card_digits_target,
    )
    if not card_ok:
        result["outcome"] = {"status": "execute_fail", "hint": "Stripe card number input was not confirmed filled."}
        return result

    exp_digits_target = len(digits(sensitive_data["card_exp"]))
    exp_ok = await _type_in_stripe_frames(
        page,
        [
            "input[autocomplete='cc-exp']",
            "input[name='exp-date']",
            "input[aria-label*='Expiration' i]",
            "input[placeholder*='MM / YY' i]",
            "input[placeholder*='MM/YY' i]",
            "input[placeholder*='MM' i]",
        ],
        sensitive_data["card_exp"],
        timeout_ms=15_000,
        expected_digits=exp_digits_target,
    )

    cvc_digits_target = len(digits(sensitive_data["card_cvc"]))
    cvc_ok = await _type_in_stripe_frames(
        page,
        [
            "input[autocomplete='cc-csc']",
            "input[name='cvc']",
            "input[aria-label*='CVC' i]",
            "input[aria-label*='Security' i]",
            "input[placeholder*='CVC' i]",
        ],
        sensitive_data["card_cvc"],
        timeout_ms=15_000,
        expected_digits=cvc_digits_target,
    )
    if not exp_ok or not cvc_ok:
        try:
            await page.keyboard.press("Tab")
            if not exp_ok:
                await page.keyboard.type(str(sensitive_data["card_exp"]), delay=25)
            await page.keyboard.press("Tab")
            if not cvc_ok:
                await page.keyboard.type(str(sensitive_data["card_cvc"]), delay=25)
        except Exception:
            pass

    if not exp_ok:
        result["outcome"] = {"status": "execute_fail", "hint": "Stripe expiration input was not confirmed filled."}
        return result
    if not cvc_ok:
        result["outcome"] = {"status": "execute_fail", "hint": "Stripe CVC input was not confirmed filled."}
        return result

    postal_ok, _ = await fill_first_matching(
        page,
        [
            "input[autocomplete='postal-code']",
            "input[name='postal']",
            "input[name*='postal' i]",
            "input[name*='zip' i]",
            "input[aria-label*='ZIP' i]",
            "input[aria-label*='Postal' i]",
            "input[placeholder*='12345']",
        ],
        sensitive_data["card_postal"],
        lambda raw: normalize_text(raw).replace(" ", "").upper()
        == normalize_text(sensitive_data["card_postal"]).replace(" ", "").upper(),
        config,
        timeout_seconds=8,
    )
    if not postal_ok:
        postal_ok = await _type_in_stripe_frames(
            page,
            [
                "input[name='postal']",
                "input[name*='postal' i]",
                "input[name*='zip' i]",
                "input[autocomplete='postal-code']",
                "input[aria-label*='ZIP' i]",
                "input[aria-label*='Postal' i]",
                "input[placeholder*='12345']",
            ],
            sensitive_data["card_postal"],
            timeout_ms=12_000,
        )
    if not postal_ok:
        postal_ok = await _type_by_role_in_stripe_frames(page, "textbox", r"zip code|postal code", sensitive_data["card_postal"], timeout_ms=8_000)
    result["postalFilled"] = postal_ok

    result["saveInfoUnchecked"] = await disable_save_info(page, SAVE_INFO_PHRASES, config)
    result["legalConsentChecked"] = await ensure_checkbox_state(
        page,
        LEGAL_CONSENT_PHRASES,
        config,
        should_check=bool(getattr(config, "confirm_legal_consent", False)),
    )

    if config.mode != "execute":
        result["outcome"] = {"status": "preview_complete", "hint": "Stripe payment details filled in preview mode."}
        return result

    if result["legalConsentChecked"] is False:
        result["outcome"] = {
            "status": "execute_fail",
            "hint": "A required legal consent checkbox is visible but was not approved for automatic selection.",
        }
        return result

    clicked = await _click_submit(page)
    if not clicked:
        result["outcome"] = {"status": "execute_fail", "hint": "Stripe submit button was not clicked."}
        return result

    await pause(config, 1.0)
    status, hint = await _wait_for_outcome_after_submit(page, timeout_seconds=30)
    if status == "success":
        result["outcome"] = {"status": "execute_success", "hint": hint}
    elif status == "fail":
        result["outcome"] = {"status": "execute_fail", "hint": hint}
    elif status == "needs_3ds":
        result["outcome"] = {"status": "needs_3ds", "hint": hint}
    elif status == "processing":
        result["outcome"] = {"status": "unknown", "hint": hint}
    else:
        result["outcome"] = {"status": "unknown", "hint": hint}
    return result
