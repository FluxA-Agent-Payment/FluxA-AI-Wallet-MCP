#!/usr/bin/env python3
"""Shop Pay card adapter for Shopify."""

from __future__ import annotations

from typing import Any

from .common import click_first_visible, disable_save_info, ensure_checkbox_state, fill_first_matching, pause
from ..security import digits, looks_like_checkout_failure, looks_like_checkout_success, looks_like_security_verification, normalize_text


SAVE_INFO_PHRASES = [
    "save my information",
    "save my info",
    "save your information",
]

LEGAL_CONSENT_PHRASES = [
    "i consent to the processing of my sensitive personal information",
    "cross-border transfer of my personal information outside mainland china",
]


async def run(page: Any, config: Any, sensitive_data: dict[str, str]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "provider": "shop_pay_card",
        "postalFilled": False,
        "saveInfoUnchecked": None,
        "legalConsentChecked": None,
        "outcome": {"status": "unknown", "hint": None},
    }

    if sensitive_data.get("card_name"):
        await fill_first_matching(
            page,
            [
                "input[autocomplete='cc-name']",
                "input[name*='name' i]",
                "input[aria-label*='Name on card' i]",
            ],
            sensitive_data["card_name"],
            lambda raw: normalize_text(raw).lower() == normalize_text(sensitive_data["card_name"]).lower(),
            config,
            timeout_seconds=5,
        )

    card_digits_target = len(digits(sensitive_data["card_number"]))
    card_ok, _ = await fill_first_matching(
        page,
        [
            "input[autocomplete='cc-number']",
            "input[name='number']",
            "input[name='cardnumber']",
            "input[aria-label*='Card number' i]",
            "input[placeholder*='1234']",
        ],
        sensitive_data["card_number"],
        lambda raw: len(digits(raw)) == card_digits_target,
        config,
        timeout_seconds=25,
    )
    if not card_ok:
        result["outcome"] = {"status": "execute_fail", "hint": "Shop Pay card number input was not confirmed filled."}
        return result

    exp_digits = digits(sensitive_data["card_exp"])
    exp_ok, _ = await fill_first_matching(
        page,
        [
            "input[autocomplete='cc-exp']",
            "input[name='expiry']",
            "input[name='exp-date']",
            "input[aria-label*='Expiration' i]",
            "input[placeholder*='MM / YY' i]",
        ],
        sensitive_data["card_exp"],
        lambda raw: digits(raw).endswith(exp_digits),
        config,
    )
    if not exp_ok:
        result["outcome"] = {"status": "execute_fail", "hint": "Shop Pay expiration input was not confirmed filled."}
        return result

    cvc_digits_target = len(digits(sensitive_data["card_cvc"]))
    cvc_ok, _ = await fill_first_matching(
        page,
        [
            "input[autocomplete='cc-csc']",
            "input[name='verification_value']",
            "input[name='cvc']",
            "input[aria-label*='Security' i]",
            "input[aria-label*='CVC' i]",
        ],
        sensitive_data["card_cvc"],
        lambda raw: len(digits(raw)) == cvc_digits_target,
        config,
    )
    if not cvc_ok:
        result["outcome"] = {"status": "execute_fail", "hint": "Shop Pay CVC input was not confirmed filled."}
        return result

    postal_ok, _ = await fill_first_matching(
        page,
        [
            "input[autocomplete='postal-code']",
            "input[name*='postal' i]",
            "input[name*='zip' i]",
            "input[aria-label*='ZIP' i]",
            "input[aria-label*='Postal' i]",
        ],
        sensitive_data["card_postal"],
        lambda raw: normalize_text(raw).replace(" ", "").upper()
        == normalize_text(sensitive_data["card_postal"]).replace(" ", "").upper(),
        config,
    )
    result["postalFilled"] = postal_ok

    result["saveInfoUnchecked"] = await disable_save_info(page, SAVE_INFO_PHRASES, config)
    result["legalConsentChecked"] = await ensure_checkbox_state(
        page,
        LEGAL_CONSENT_PHRASES,
        config,
        should_check=bool(getattr(config, "confirm_legal_consent", False)),
    )

    if config.mode != "execute":
        result["outcome"] = {"status": "preview_complete", "hint": "Shop Pay payment details filled in preview mode."}
        return result

    if result["legalConsentChecked"] is False:
        result["outcome"] = {
            "status": "execute_fail",
            "hint": "A required legal consent checkbox is visible but was not approved for automatic selection.",
        }
        return result

    clicked = await click_first_visible(
        page,
        [
            "button:has-text('Pay now')",
            "button:has-text('Complete order')",
            "button:has-text('Pay')",
            "button:has-text('Review order')",
            "input[type='submit']",
        ],
        timeout_ms=5000,
    )
    if not clicked:
        result["outcome"] = {"status": "execute_fail", "hint": "Shop Pay submit button was not clicked."}
        return result

    await pause(config, 1.0)
    body = normalize_text(await page.locator("body").inner_text(timeout=4000))
    if looks_like_security_verification(body):
        result["outcome"] = {"status": "needs_manual_verification", "hint": "Shop Pay requires manual verification after submit."}
    elif looks_like_checkout_success(body, page.url):
        result["outcome"] = {"status": "execute_success", "hint": "Shop Pay checkout reached a success state."}
    elif looks_like_checkout_failure(body):
        result["outcome"] = {"status": "execute_fail", "hint": "Shop Pay checkout displayed a failure state after submit."}
    else:
        result["outcome"] = {"status": "unknown", "hint": "Shop Pay submit was clicked but no terminal state was detected."}
    return result
