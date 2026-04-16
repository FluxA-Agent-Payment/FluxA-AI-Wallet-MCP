#!/usr/bin/env python3
"""Shopify native PCI card-field adapter for hosted checkout."""

from __future__ import annotations

from typing import Any, Callable
import asyncio
import sys

from .common import click_first_visible, disable_save_info, ensure_checkbox_state, fill_first_matching, pause
from ..security import digits, looks_like_checkout_failure, looks_like_checkout_success, looks_like_security_verification, normalize_text


SAVE_INFO_PHRASES = [
    "save my information for a faster checkout",
    "save my information",
    "save my info",
]

LEGAL_CONSENT_PHRASES = [
    "i consent to the processing of my sensitive personal information",
    "cross-border transfer of my personal information outside mainland china",
]

RESIDENT_ID_SELECTORS = [
    "input[name='Resident ID number']",
    "input[placeholder*='Resident ID number' i]",
    "input[aria-label*='Resident ID number' i]",
    "input[name*='resident' i]",
    "input[id*='resident' i]",
    "input[placeholder*='ID number' i]",
    "input[aria-label*='ID number' i]",
]


def _select_all_shortcut() -> str:
    return "Meta+A" if sys.platform == "darwin" else "Control+A"


async def _is_pci_interactable(locator: Any) -> bool:
    try:
        if not await locator.is_visible() or not await locator.is_enabled():
            return False
        aria_hidden = normalize_text(await locator.get_attribute("aria-hidden")).lower()
        if aria_hidden == "true":
            return False
        box = await locator.bounding_box()
        if not box or box.get("width", 0) < 20 or box.get("height", 0) < 20:
            return False
        return True
    except Exception:
        return False


async def _fill_in_pci_frame(
    page: Any,
    iframe_selectors: list[str],
    field_selectors: list[str],
    value: str,
    verifier: Callable[[str], bool],
    config: Any,
    timeout_seconds: int = 20,
) -> tuple[bool, str]:
    deadline = asyncio.get_running_loop().time() + max(timeout_seconds, 1)
    last_value = ""
    while asyncio.get_running_loop().time() < deadline:
        for iframe_selector in iframe_selectors:
            frame = page.frame_locator(iframe_selector)
            for field_selector in field_selectors:
                try:
                    locator = frame.locator(field_selector)
                    count = min(await locator.count(), 6)
                except Exception:
                    continue
                for index in range(count):
                    candidate = locator.nth(index)
                    if not await _is_pci_interactable(candidate):
                        continue
                    ok, last_value = await _type_and_verify(candidate, value, verifier, config)
                    if ok:
                        return True, last_value
        await asyncio.sleep(0.25)
    return False, last_value


async def _read_pci_value(
    page: Any,
    iframe_selectors: list[str],
    field_selectors: list[str],
) -> str:
    for iframe_selector in iframe_selectors:
        frame = page.frame_locator(iframe_selector)
        for field_selector in field_selectors:
            try:
                locator = frame.locator(field_selector)
                count = min(await locator.count(), 6)
            except Exception:
                continue
            for index in range(count):
                candidate = locator.nth(index)
                if not await _is_pci_interactable(candidate):
                    continue
                try:
                    value = await candidate.input_value()
                except Exception:
                    value = ""
                if normalize_text(value):
                    return normalize_text(value)
    return ""


async def _type_and_verify(locator: Any, value: str, verifier: Callable[[str], bool], config: Any) -> tuple[bool, str]:
    target = str(value)
    last_value = ""
    for _attempt in range(3):
        try:
            await locator.scroll_into_view_if_needed(timeout=2_000)
        except Exception:
            pass
        try:
            await locator.click(timeout=3_000)
        except Exception:
            pass
        try:
            await locator.press(_select_all_shortcut())
            await locator.press("Backspace")
        except Exception:
            pass
        try:
            await locator.fill("")
        except Exception:
            pass
        try:
            await locator.press_sequentially(target, delay=35)
        except Exception:
            try:
                await locator.type(target, delay=35)
            except Exception:
                try:
                    await locator.fill(target)
                except Exception:
                    pass
        await pause(config, 0.2)
        try:
            last_value = await locator.input_value()
        except Exception:
            last_value = ""
        if verifier(last_value):
            return True, last_value
    return False, last_value


async def _fill_resident_id_number(page: Any, sensitive_data: dict[str, str], config: Any) -> bool | None:
    resident_id_number = normalize_text(sensitive_data.get("resident_id_number", ""))
    if not resident_id_number:
        return None
    filled, _raw = await fill_first_matching(
        page,
        RESIDENT_ID_SELECTORS,
        resident_id_number,
        lambda raw: normalize_text(raw) == resident_id_number,
        config,
        timeout_seconds=12,
    )
    return filled


async def _ensure_legal_consent_state(page: Any, config: Any) -> bool | None:
    should_check = bool(getattr(config, "confirm_legal_consent", False))
    consent_text = "I consent to the processing of my sensitive personal information"
    try:
        await page.locator(f"text={consent_text}").first.wait_for(
            state="visible",
            timeout=6_000 if should_check else 2_000,
        )
    except Exception:
        pass

    deadline = asyncio.get_running_loop().time() + (8 if should_check else 3)
    last_value: bool | None = None
    while asyncio.get_running_loop().time() < deadline:
        last_value = await ensure_checkbox_state(
            page,
            LEGAL_CONSENT_PHRASES,
            config,
            should_check=should_check,
        )
        if last_value is not None:
            return last_value
        await asyncio.sleep(0.4)

    try:
        consent_label = page.locator(f"label:has-text('{consent_text}')").first
        if await consent_label.count():
            try:
                await consent_label.scroll_into_view_if_needed(timeout=2_000)
            except Exception:
                pass
            checkbox = consent_label.locator("input[type='checkbox'], [role='checkbox']").first
            if await checkbox.count():
                try:
                    checked = await checkbox.is_checked()
                except Exception:
                    checked = normalize_text(await checkbox.get_attribute("aria-checked")).lower() == "true"
                if should_check and not checked:
                    try:
                        await consent_label.click(timeout=2_000)
                    except Exception:
                        try:
                            await checkbox.click(timeout=2_000, force=True)
                        except Exception:
                            pass
                    await pause(config, 0.2)
                    try:
                        checked = await checkbox.is_checked()
                    except Exception:
                        checked = normalize_text(await checkbox.get_attribute("aria-checked")).lower() == "true"
                return checked
    except Exception:
        pass
    return last_value


async def _wait_for_post_submit_outcome(page: Any, config: Any) -> dict[str, str]:
    timeout_seconds = min(max(int(getattr(config, "manual_verification_timeout_seconds", 20) or 20), 8), 30)
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    last_body = ""
    while asyncio.get_running_loop().time() < deadline:
        await pause(config, 0.75)
        try:
            last_body = normalize_text(await page.locator("body").inner_text(timeout=4_000))
        except Exception:
            last_body = normalize_text(last_body)

        if looks_like_security_verification(last_body):
            return {
                "status": "needs_manual_verification",
                "hint": "Shopify checkout requires manual verification after submit.",
            }
        if looks_like_checkout_success(last_body, page.url):
            return {
                "status": "execute_success",
                "hint": "Shopify checkout reached a success state.",
            }
        if looks_like_checkout_failure(last_body):
            return {
                "status": "execute_fail",
                "hint": "Shopify checkout displayed a failure state after submit.",
            }

    return {
        "status": "unknown",
        "hint": "Shopify checkout submit was clicked but no terminal state was detected within the post-submit wait window.",
    }


async def run(page: Any, config: Any, sensitive_data: dict[str, str]) -> dict[str, Any]:
    number_iframes = [
        "iframe[name^='card-fields-number']",
        "iframe[title*='Card number' i]",
        "iframe[src*='checkout.pci.shopifyinc.com'][src*='number-']",
    ]
    number_fields = [
        "input[aria-label='Card number']",
        "input[name='number']",
        "input[autocomplete='cc-number']",
    ]
    expiry_iframes = [
        "iframe[name^='card-fields-expiry']",
        "iframe[title*='Expiration date' i]",
        "iframe[src*='checkout.pci.shopifyinc.com'][src*='expiry-']",
    ]
    expiry_fields = [
        "input[aria-label*='Expiration date' i]",
        "input[autocomplete='cc-exp']",
        "input[name='expiry']",
    ]
    cvc_iframes = [
        "iframe[name^='card-fields-verification_value']",
        "iframe[title*='Security code' i]",
        "iframe[src*='checkout.pci.shopifyinc.com'][src*='verification_value-']",
    ]
    cvc_fields = [
        "input[aria-label='Security code']",
        "input[aria-label*='CVC' i]",
        "input[autocomplete='cc-csc']",
    ]
    name_iframes = [
        "iframe[name^='card-fields-name']",
        "iframe[title*='Name on card' i]",
        "iframe[src*='checkout.pci.shopifyinc.com'][src*='name-']",
    ]
    name_fields = [
        "input[aria-label='Name on card']",
        "input[autocomplete='cc-name']",
        "input[name='name']",
    ]
    result: dict[str, Any] = {
        "provider": "shopify_checkout_card",
        "postalFilled": False,
        "residentIdFilled": None,
        "saveInfoUnchecked": None,
        "legalConsentChecked": None,
        "paymentFieldVerification": {
            "cardNumberFilled": False,
            "expiryFilled": False,
            "cvcFilled": False,
            "nameFilled": False,
            "cardLast4": digits(sensitive_data["card_number"])[-4:],
        },
        "outcome": {"status": "unknown", "hint": None},
    }

    card_digits_target = len(digits(sensitive_data["card_number"]))
    card_ok, _ = await _fill_in_pci_frame(
        page,
        number_iframes,
        number_fields,
        sensitive_data["card_number"],
        lambda raw: len(digits(raw)) == card_digits_target,
        config,
        timeout_seconds=25,
    )
    if not card_ok:
        result["outcome"] = {"status": "execute_fail", "hint": "Shopify PCI card number input was not confirmed filled."}
        return result

    exp_digits = digits(sensitive_data["card_exp"])
    exp_ok, _ = await _fill_in_pci_frame(
        page,
        expiry_iframes,
        expiry_fields,
        sensitive_data["card_exp"],
        lambda raw: digits(raw).endswith(exp_digits),
        config,
        timeout_seconds=20,
    )
    if not exp_ok:
        result["outcome"] = {"status": "execute_fail", "hint": "Shopify PCI expiration input was not confirmed filled."}
        return result

    cvc_digits_target = len(digits(sensitive_data["card_cvc"]))
    cvc_ok, _ = await _fill_in_pci_frame(
        page,
        cvc_iframes,
        cvc_fields,
        sensitive_data["card_cvc"],
        lambda raw: len(digits(raw)) == cvc_digits_target,
        config,
        timeout_seconds=20,
    )
    if not cvc_ok:
        result["outcome"] = {"status": "execute_fail", "hint": "Shopify PCI security code input was not confirmed filled."}
        return result

    if sensitive_data.get("card_name"):
        name_ok, _ = await _fill_in_pci_frame(
            page,
            name_iframes,
            name_fields,
            sensitive_data["card_name"],
            lambda raw: normalize_text(raw).lower() == normalize_text(sensitive_data["card_name"]).lower(),
            config,
            timeout_seconds=10,
        )
        if not name_ok:
            result["outcome"] = {"status": "execute_fail", "hint": "Shopify PCI name on card input was not confirmed filled."}
            return result

    postal_ok, _ = await fill_first_matching(
        page,
        [
            "input[autocomplete='postal-code']",
            "input[autocomplete='billing postal-code']",
            "input[name*='postal' i]",
            "input[name*='zip' i]",
            "input[aria-label*='ZIP' i]",
            "input[aria-label*='Postal' i]",
        ],
        sensitive_data["card_postal"],
        lambda raw: normalize_text(raw).replace(" ", "").upper()
        == normalize_text(sensitive_data["card_postal"]).replace(" ", "").upper(),
        config,
        timeout_seconds=10,
    )
    result["postalFilled"] = postal_ok
    number_value = await _read_pci_value(page, number_iframes, number_fields)
    expiry_value = await _read_pci_value(page, expiry_iframes, expiry_fields)
    cvc_value = await _read_pci_value(page, cvc_iframes, cvc_fields)
    name_value = await _read_pci_value(page, name_iframes, name_fields)
    result["paymentFieldVerification"] = {
        "cardNumberFilled": len(digits(number_value)) == card_digits_target,
        "expiryFilled": digits(expiry_value).endswith(exp_digits),
        "cvcFilled": len(digits(cvc_value)) == cvc_digits_target,
        "nameFilled": normalize_text(name_value).lower() == normalize_text(sensitive_data.get("card_name", "")).lower()
        if sensitive_data.get("card_name")
        else True,
        "cardLast4": digits(number_value or sensitive_data["card_number"])[-4:],
    }

    result["saveInfoUnchecked"] = await disable_save_info(page, SAVE_INFO_PHRASES, config)
    result["residentIdFilled"] = await _fill_resident_id_number(page, sensitive_data, config)
    result["legalConsentChecked"] = await _ensure_legal_consent_state(page, config)

    if config.mode != "execute":
        result["outcome"] = {
            "status": "preview_complete",
            "hint": "Shopify checkout payment details filled in preview mode.",
        }
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
            "[role='button']:has-text('Pay now')",
            "input[type='submit']",
        ],
        timeout_ms=5_000,
    )
    if not clicked:
        result["outcome"] = {"status": "execute_fail", "hint": "Shopify PCI submit button was not clicked."}
        return result

    result["outcome"] = await _wait_for_post_submit_outcome(page, config)
    return result
