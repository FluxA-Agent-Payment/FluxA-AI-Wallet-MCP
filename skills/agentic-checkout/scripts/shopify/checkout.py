#!/usr/bin/env python3
"""Checkout normalization and payment handling for supported surfaces."""

from __future__ import annotations

from pathlib import Path
from typing import Any
import asyncio
from urllib.parse import urlparse

from .adapters import shop_pay_card, shopify_checkout_card, stripe_hosted
from .adapters.common import click_first_visible, fill_first_matching, iframe_urls, pause, select_first_matching, visible_button_texts
from .providers import detect_provider
from .results import normalize_checkout_state
from .security import looks_like_security_verification, money_from_text, normalize_text


try:  # pragma: no cover - exercised indirectly
    from playwright.async_api import async_playwright
except Exception as exc:  # pragma: no cover
    async_playwright = None
    PLAYWRIGHT_IMPORT_ERROR = exc
else:  # pragma: no cover
    PLAYWRIGHT_IMPORT_ERROR = None


ADAPTERS = {
    "stripe_hosted": stripe_hosted.run,
    "shopify_checkout_card": shopify_checkout_card.run,
    "shop_pay_card": shop_pay_card.run,
}


async def maybe_click_guest_checkout(page: Any) -> None:
    await click_first_visible(
        page,
        [
            "button:has-text('Continue as guest')",
            "button:has-text('Checkout as guest')",
            "a:has-text('Continue as guest')",
            "button:has-text('Guest checkout')",
        ],
        timeout_ms=2500,
    )


async def fill_contact(page: Any, sensitive_data: dict[str, str], config: Any) -> bool:
    email = sensitive_data.get("guest_email", "")
    if not email:
        return False
    selectors = [
        "input[autocomplete='email']",
        "input[type='email']",
        "input[name='email']",
        "input[name*='email' i]",
        "#email",
    ]
    email_filled, _raw = await fill_first_matching(
        page,
        selectors,
        email,
        lambda raw: normalize_text(raw).lower() == normalize_text(email).lower(),
        config,
        timeout_seconds=8,
    )
    if not email_filled:
        return False

    contact_phone = sensitive_data.get("delivery_phone") or sensitive_data.get("billing_phone")
    if contact_phone:
        await fill_first_matching(
            page,
            [
                "input[autocomplete='tel']",
                "input[name='phone']",
                "input[name*='phone' i]",
            ],
            contact_phone,
            lambda raw: normalize_text(raw) == normalize_text(contact_phone),
            config,
            timeout_seconds=4,
        )
    await pause(config, 0.3)
    return True


def split_full_name(value: str) -> tuple[str, str]:
    parts = normalize_text(value).split(" ", 1)
    if not parts or not parts[0]:
        return "", ""
    if len(parts) == 1:
        return parts[0], parts[0]
    return parts[0], parts[1]


def _resolved_name(sensitive_data: dict[str, str], prefix: str) -> tuple[str, str, str]:
    first_name = normalize_text(sensitive_data.get(f"{prefix}_first_name", ""))
    last_name = normalize_text(sensitive_data.get(f"{prefix}_last_name", ""))
    full_name = normalize_text(sensitive_data.get(f"{prefix}_name", ""))
    if full_name and not (first_name and last_name):
        fallback_first, fallback_last = split_full_name(full_name)
        first_name = first_name or fallback_first
        last_name = last_name or fallback_last
    if not full_name and (first_name or last_name):
        full_name = " ".join(part for part in [first_name, last_name] if part)
    return full_name, first_name, last_name


def _profile_provided(sensitive_data: dict[str, str], prefix: str) -> bool:
    fields = (
        "name",
        "first_name",
        "last_name",
        "address1",
        "address2",
        "city",
        "state",
        "postal",
        "country",
        "phone",
    )
    return any(normalize_text(sensitive_data.get(f"{prefix}_{field}", "")) for field in fields)


def _billing_differs_from_delivery(sensitive_data: dict[str, str]) -> bool:
    if normalize_text(sensitive_data.get("billing_same_as_delivery", "")).lower() in {"1", "true", "yes", "on"}:
        return False
    if not _profile_provided(sensitive_data, "billing"):
        return False
    for field in ("name", "address1", "address2", "city", "state", "postal", "country", "phone"):
        if normalize_text(sensitive_data.get(f"billing_{field}", "")) != normalize_text(
            sensitive_data.get(f"delivery_{field}", "")
        ):
            return True
    return False


def _location_variants(value: str, field: str) -> list[str]:
    normalized = normalize_text(value)
    if not normalized:
        return []
    aliases: dict[str, dict[str, list[str]]] = {
        "country": {
            "china": ["China", "CN", "中国"],
            "united states": ["United States", "US", "USA", "美国"],
        },
        "state": {
            "zhejiang": ["Zhejiang", "浙江", "浙江省"],
            "浙江": ["Zhejiang", "浙江", "浙江省"],
            "浙江省": ["Zhejiang", "浙江", "浙江省"],
            "illinois": ["Illinois", "IL"],
            "il": ["Illinois", "IL"],
        },
        "city": {
            "hangzhou": ["Hangzhou", "杭州", "杭州市"],
            "杭州": ["Hangzhou", "杭州", "杭州市"],
            "杭州市": ["Hangzhou", "杭州", "杭州市"],
            "chicago": ["Chicago"],
        },
    }
    variants = [normalized]
    variants.extend(aliases.get(field, {}).get(normalized.lower(), []))
    deduped: list[str] = []
    seen: set[str] = set()
    for item in variants:
        candidate = normalize_text(item)
        if not candidate:
            continue
        key = candidate.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(candidate)
    return deduped


def _address_matches(raw: str, expected: str) -> bool:
    actual = normalize_text(raw).lower()
    target = normalize_text(expected).lower()
    if not target:
        return True
    return actual == target or target in actual or actual in target


DELIVERY_VALIDATION_SNIPPETS = (
    "please use english characters only",
    "enter an address",
    "enter a city",
    "select a state / province",
    "select a province",
    "enter a phone number",
)


BILLING_VALIDATION_SNIPPETS = (
    "please use english characters only",
    "enter an address",
    "enter a city",
    "select a state / province",
    "select a province",
    "enter a phone number",
)


BLOCKING_FIELD_IGNORES = (
    "card number",
    "expiration date",
    "security code",
    "name on card",
    "discount code or gift card",
    "discount code",
    "gift card",
    "company",
    "apartment, suite, etc.",
)


def _preferred_profile_value(sensitive_data: dict[str, str], prefix: str, field: str) -> str:
    ascii_value = normalize_text(sensitive_data.get(f"{prefix}_{field}_ascii", ""))
    primary_value = normalize_text(sensitive_data.get(f"{prefix}_{field}", ""))
    return ascii_value or primary_value


async def _contains_validation_snippet(page: Any, snippets: tuple[str, ...]) -> bool:
    try:
        body = normalize_text(await page.locator("body").inner_text(timeout=4_000)).lower()
    except Exception:
        return False
    return any(snippet in body for snippet in snippets)


async def detect_blocking_fields(page: Any) -> list[str]:
    try:
        values = await page.evaluate(
            """() => {
                const isVisible = (node) => {
                    if (!(node instanceof HTMLElement)) return false;
                    const style = window.getComputedStyle(node);
                    if (style.visibility === 'hidden' || style.display === 'none') return false;
                    const rect = node.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                };
                const seen = new Set();
                const results = [];
                const inputs = Array.from(document.querySelectorAll(
                    "input[aria-invalid='true'], select[aria-invalid='true'], textarea[aria-invalid='true'], " +
                    "[data-invalid='true'] input, [data-invalid='true'] select, [data-invalid='true'] textarea"
                ));
                for (const node of inputs) {
                    if (!isVisible(node)) continue;
                    const id = node.getAttribute('id') || '';
                    const label = node.getAttribute('aria-label')
                        || node.getAttribute('placeholder')
                        || node.getAttribute('name')
                        || (id ? document.querySelector(`label[for="${id}"]`)?.textContent : '')
                        || node.closest('label')?.textContent
                        || node.parentElement?.querySelector('label')?.textContent
                        || '';
                    const normalized = String(label || '').replace(/\\s+/g, ' ').trim();
                    if (!normalized) continue;
                    const key = normalized.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    results.push(normalized);
                }
                return results;
            }"""
        )
    except Exception:
        return []
    blocking_fields: list[str] = []
    for item in values or []:
        label = normalize_text(str(item))
        lowered = label.lower()
        if not label:
            continue
        if any(ignore in lowered for ignore in BLOCKING_FIELD_IGNORES):
            continue
        blocking_fields.append(label)
    return blocking_fields


async def _has_visible_candidate(page: Any, selectors: list[str]) -> bool:
    for selector in selectors:
        try:
            locator = page.locator(selector)
            count = min(await locator.count(), 6)
        except Exception:
            continue
        for index in range(count):
            candidate = locator.nth(index)
            try:
                if not await candidate.is_visible() or not await candidate.is_enabled():
                    continue
                if normalize_text(await candidate.get_attribute("aria-hidden")).lower() == "true":
                    continue
                return True
            except Exception:
                continue
    return False


async def _has_visible_heading(page: Any, title: str) -> bool:
    try:
        locator = page.get_by_role("heading", name=title)
        count = min(await locator.count(), 4)
    except Exception:
        return False
    for index in range(count):
        candidate = locator.nth(index)
        try:
            if await candidate.is_visible():
                return True
        except Exception:
            continue
    return False


async def delivery_step_visible(page: Any) -> bool:
    if await _has_visible_heading(page, "Delivery"):
        return True
    return await _has_visible_candidate(
        page,
        [
            "input[autocomplete='shipping given-name']",
            "input[aria-label='First name']",
            "input[placeholder='First name']",
            "input[name='firstName']",
            "input[name*='first_name' i]",
            "input[aria-label='Address']",
            "input[placeholder='Address']",
            "[role='combobox'][aria-label='Address']",
            "input[aria-label='City']",
            "input[placeholder='City']",
            "input[aria-label='Postal code']",
            "input[placeholder='Postal code']",
            "input[aria-label='Phone']",
            "input[placeholder='Phone']",
        ],
    )


async def fill_delivery(page: Any, sensitive_data: dict[str, str], config: Any) -> bool | None:
    visible = await delivery_step_visible(page)
    if not visible:
        return None
    if not _profile_provided(sensitive_data, "delivery"):
        return False

    _delivery_name, first_name, last_name = _resolved_name(sensitive_data, "delivery")
    delivery_country = normalize_text(sensitive_data.get("delivery_country"))
    delivery_address1 = _preferred_profile_value(sensitive_data, "delivery", "address1")
    delivery_city = _preferred_profile_value(sensitive_data, "delivery", "city")
    delivery_state = _preferred_profile_value(sensitive_data, "delivery", "state")
    if delivery_country:
        selected_country = await select_first_matching(
            page,
            [
                "select[autocomplete='shipping country-name']",
                "select[name*='shipping' i][name*='country' i]",
                "select[aria-label='Country/Region']",
                "[role='combobox'][aria-label='Country/Region']",
                "select[autocomplete='country-name']",
                "select[name*='country' i]",
                "select[id*='country' i]",
            ],
            _location_variants(delivery_country, "country"),
            timeout_seconds=6,
        )
        if not selected_country:
            await fill_first_matching(
                page,
                [
                    "input[autocomplete='shipping country-name']",
                    "input[name*='shipping' i][name*='country' i]",
                    "input[aria-label='Country/Region']",
                    "input[autocomplete='country-name']",
                    "input[name*='country' i]",
                ],
                delivery_country,
                lambda raw: normalize_text(raw).lower()
                in {item.lower() for item in _location_variants(delivery_country, "country")},
                config,
                timeout_seconds=6,
                commit_autocomplete=True,
            )
        await pause(config, 0.6)

    if first_name:
        await fill_first_matching(
            page,
            [
                "input[autocomplete='shipping given-name']",
                "input[name*='shipping' i][name*='first' i]",
                "input[id*='shipping' i][id*='first' i]",
                "input[aria-label='First name']",
                "input[placeholder='First name']",
                "input[autocomplete='given-name']",
                "input[name*='first_name' i]",
                "input[name*='first-name' i]",
                "input[name='firstName']",
                "input[id*='first_name' i]",
            ],
            first_name,
            lambda raw: normalize_text(raw).lower() == first_name.lower(),
            config,
            timeout_seconds=5,
        )
    if last_name:
        await fill_first_matching(
            page,
            [
                "input[autocomplete='shipping family-name']",
                "input[name*='shipping' i][name*='last' i]",
                "input[id*='shipping' i][id*='last' i]",
                "input[aria-label='Last name']",
                "input[placeholder='Last name']",
                "input[autocomplete='family-name']",
                "input[name*='last_name' i]",
                "input[name*='last-name' i]",
                "input[name='lastName']",
                "input[id*='last_name' i]",
            ],
            last_name,
            lambda raw: normalize_text(raw).lower() == last_name.lower(),
            config,
            timeout_seconds=5,
        )

    if delivery_address1:
        await fill_first_matching(
            page,
            [
                "input[autocomplete='shipping address-line1']",
                "input[autocomplete='shipping street-address']",
                "input[name*='shipping' i][name*='address1' i]",
                "input[id*='shipping' i][id*='address1' i]",
                "input[aria-label='Address']",
                "input[placeholder='Address']",
                "[role='combobox'][aria-label='Address']",
                "input[autocomplete='address-line1']",
                "input[autocomplete='street-address']",
                "input[name*='address1' i]",
                "input[name*='address_1' i]",
                "input[id*='address1' i]",
            ],
            delivery_address1,
            lambda raw: _address_matches(raw, delivery_address1),
            config,
            timeout_seconds=5,
            commit_autocomplete=True,
        )
    if sensitive_data.get("delivery_address2"):
        await fill_first_matching(
            page,
            [
                "input[autocomplete='shipping address-line2']",
                "input[name*='shipping' i][name*='address2' i]",
                "input[id*='shipping' i][id*='address2' i]",
                "input[aria-label*='Apartment' i]",
                "input[placeholder*='Apartment' i]",
                "input[autocomplete='address-line2']",
                "input[name*='address2' i]",
                "input[name*='address_2' i]",
                "input[id*='address2' i]",
            ],
            sensitive_data["delivery_address2"],
            lambda raw: normalize_text(raw).lower() == normalize_text(sensitive_data["delivery_address2"]).lower(),
            config,
            timeout_seconds=4,
        )
    if delivery_city:
        await fill_first_matching(
            page,
            [
                "input[autocomplete='shipping address-level2']",
                "input[name*='shipping' i][name*='city' i]",
                "input[id*='shipping' i][id*='city' i]",
                "input[aria-label='City']",
                "input[placeholder='City']",
                "input[autocomplete='address-level2']",
                "input[name*='city' i]",
                "input[id*='city' i]",
            ],
            delivery_city,
            lambda raw: normalize_text(raw).lower() in {item.lower() for item in _location_variants(delivery_city, "city")},
            config,
            timeout_seconds=5,
        )

    if delivery_state:
        filled_state, _raw = await fill_first_matching(
            page,
            [
                "input[autocomplete='shipping address-level1']",
                "input[name*='shipping' i][name*='province' i]",
                "input[name*='shipping' i][name*='state' i]",
                "input[aria-label='Province']",
                "input[aria-label='State']",
                "[role='combobox'][aria-label='Province']",
                "[role='combobox'][aria-label='State']",
                "input[autocomplete='address-level1']",
                "input[name*='province' i]",
                "input[name*='state' i]",
                "input[id*='province' i]",
                "input[id*='state' i]",
            ],
            delivery_state,
            lambda raw: normalize_text(raw).lower() in {item.lower() for item in _location_variants(delivery_state, "state")},
            config,
            timeout_seconds=4,
            commit_autocomplete=True,
        )
        if not filled_state:
            await select_first_matching(
                page,
                [
                    "select[autocomplete='shipping address-level1']",
                    "select[name*='shipping' i][name*='province' i]",
                    "select[name*='shipping' i][name*='state' i]",
                    "select[aria-label='Province']",
                    "select[aria-label='State']",
                    "select[autocomplete='address-level1']",
                    "select[name*='province' i]",
                    "select[name*='state' i]",
                    "select[id*='province' i]",
                    "select[id*='state' i]",
                ],
                _location_variants(delivery_state, "state"),
                timeout_seconds=4,
            )

    if sensitive_data.get("delivery_postal"):
        await fill_first_matching(
            page,
            [
                "input[autocomplete='shipping postal-code']",
                "input[name*='shipping' i][name*='postal' i]",
                "input[name*='shipping' i][name*='zip' i]",
                "input[aria-label='Postal code']",
                "input[placeholder='Postal code']",
                "input[autocomplete='postal-code']",
                "input[name*='postal' i]",
                "input[name*='zip' i]",
                "input[aria-label*='ZIP' i]",
                "input[aria-label*='Postal' i]",
            ],
            sensitive_data["delivery_postal"],
            lambda raw: normalize_text(raw).replace(" ", "").upper()
            == normalize_text(sensitive_data["delivery_postal"]).replace(" ", "").upper(),
            config,
            timeout_seconds=5,
        )

    if sensitive_data.get("delivery_phone"):
        await fill_first_matching(
            page,
            [
                "input[autocomplete='shipping tel']",
                "input[name*='shipping' i][name*='phone' i]",
                "input[aria-label='Phone']",
                "input[placeholder='Phone']",
                "input[autocomplete='tel']",
                "input[name*='phone' i]",
                "input[id*='phone' i]",
            ],
            sensitive_data["delivery_phone"],
            lambda raw: normalize_text(raw) == normalize_text(sensitive_data["delivery_phone"]),
            config,
            timeout_seconds=4,
        )

    await pause(config, 0.3)
    return await verify_delivery(page, sensitive_data)


async def ensure_different_billing_address(page: Any, sensitive_data: dict[str, str], config: Any) -> None:
    if not _billing_differs_from_delivery(sensitive_data):
        if normalize_text(sensitive_data.get("billing_same_as_delivery", "")).lower() in {"1", "true", "yes", "on"}:
            await click_first_visible(
                page,
                [
                    "label:has-text('Use shipping address as billing address')",
                    "label:has-text('Use delivery address as billing address')",
                ],
                timeout_ms=2_500,
            )
            await pause(config, 0.3)
        return
    if await _has_visible_candidate(
        page,
        [
            "input[autocomplete='billing address-line1']",
            "input[name*='billing' i][name*='address1' i]",
            "input[name*='billing' i][name*='city' i]",
        ],
    ):
        return
    await click_first_visible(
        page,
        [
            "label:has-text('Use a different billing address')",
            "label:has-text('Different billing address')",
            "label:has-text('Billing address is different')",
            "button:has-text('Use a different billing address')",
            "button:has-text('Different billing address')",
        ],
        timeout_ms=3_500,
    )
    await pause(config, 0.4)


async def fill_billing_identity(page: Any, sensitive_data: dict[str, str], config: Any) -> None:
    await ensure_different_billing_address(page, sensitive_data, config)
    billing_name, first_name, last_name = _resolved_name(sensitive_data, "billing")
    if not billing_name:
        _billing_name, first_name, last_name = _resolved_name({"billing_name": sensitive_data.get("card_name", "")}, "billing")
    if normalize_text(sensitive_data.get("billing_same_as_delivery", "")).lower() in {"1", "true", "yes", "on"}:
        return
    billing_address1 = _preferred_profile_value(sensitive_data, "billing", "address1")
    billing_city = _preferred_profile_value(sensitive_data, "billing", "city")
    billing_state = _preferred_profile_value(sensitive_data, "billing", "state")
    country_value = normalize_text(sensitive_data.get("billing_country") or sensitive_data.get("card_country"))
    if country_value:
        selected_country = await select_first_matching(
            page,
            [
                "select[autocomplete='billing country-name']",
                "select[name*='billing' i][name*='country' i]",
                "select[autocomplete='country-name']",
                "select[name*='country' i]",
                "select[id*='country' i]",
            ],
            _location_variants(country_value, "country"),
            timeout_seconds=6,
        )
        if not selected_country:
            await fill_first_matching(
                page,
                [
                    "input[autocomplete='billing country-name']",
                    "input[name*='billing' i][name*='country' i]",
                    "input[aria-label='Country/Region']",
                    "input[autocomplete='country-name']",
                    "input[name*='country' i]",
                ],
                country_value,
                lambda raw: normalize_text(raw).lower()
                in {item.lower() for item in _location_variants(country_value, "country")},
                config,
                timeout_seconds=6,
                commit_autocomplete=True,
            )
        await pause(config, 0.6)
    if first_name:
        await fill_first_matching(
            page,
            [
                "input[autocomplete='billing given-name']",
                "input[name*='billing' i][name*='first' i]",
                "input[id*='billing' i][id*='first' i]",
                "input[autocomplete='given-name']",
                "input[name*='first_name' i]",
                "input[name*='first-name' i]",
                "input[name='firstName']",
                "input[id*='first_name' i]",
            ],
            first_name,
            lambda raw: normalize_text(raw).lower() == first_name.lower(),
            config,
            timeout_seconds=5,
        )
    if last_name:
        await fill_first_matching(
            page,
            [
                "input[autocomplete='billing family-name']",
                "input[name*='billing' i][name*='last' i]",
                "input[id*='billing' i][id*='last' i]",
                "input[autocomplete='family-name']",
                "input[name*='last_name' i]",
                "input[name*='last-name' i]",
                "input[name='lastName']",
                "input[id*='last_name' i]",
            ],
            last_name,
            lambda raw: normalize_text(raw).lower() == last_name.lower(),
            config,
            timeout_seconds=5,
        )

    if billing_address1:
        await fill_first_matching(
            page,
            [
                "input[autocomplete='billing address-line1']",
                "input[autocomplete='billing street-address']",
                "input[name*='billing' i][name*='address1' i]",
                "input[id*='billing' i][id*='address1' i]",
                "input[autocomplete='address-line1']",
                "input[autocomplete='street-address']",
                "input[name*='address1' i]",
                "input[name*='address_1' i]",
                "input[id*='address1' i]",
            ],
            billing_address1,
            lambda raw: _address_matches(raw, billing_address1),
            config,
            timeout_seconds=5,
            commit_autocomplete=True,
        )
    if sensitive_data.get("billing_address2"):
        await fill_first_matching(
            page,
            [
                "input[autocomplete='billing address-line2']",
                "input[name*='billing' i][name*='address2' i]",
                "input[id*='billing' i][id*='address2' i]",
                "input[autocomplete='address-line2']",
                "input[name*='address2' i]",
                "input[name*='address_2' i]",
                "input[id*='address2' i]",
            ],
            sensitive_data["billing_address2"],
            lambda raw: normalize_text(raw).lower() == normalize_text(sensitive_data["billing_address2"]).lower(),
            config,
            timeout_seconds=4,
        )

    if billing_city:
        await fill_first_matching(
            page,
            [
                "input[autocomplete='billing address-level2']",
                "input[name*='billing' i][name*='city' i]",
                "input[id*='billing' i][id*='city' i]",
                "input[autocomplete='address-level2']",
                "input[name*='city' i]",
                "input[id*='city' i]",
            ],
            billing_city,
            lambda raw: normalize_text(raw).lower() in {item.lower() for item in _location_variants(billing_city, "city")},
            config,
            timeout_seconds=5,
        )

    state_value = normalize_text(billing_state)
    if state_value:
        filled_state, _raw = await fill_first_matching(
            page,
            [
                "input[autocomplete='billing address-level1']",
                "input[name*='billing' i][name*='province' i]",
                "input[name*='billing' i][name*='state' i]",
                "input[autocomplete='address-level1']",
                "input[name*='province' i]",
                "input[name*='state' i]",
                "input[id*='province' i]",
                "input[id*='state' i]",
            ],
            state_value,
            lambda raw: normalize_text(raw).lower() in {item.lower() for item in _location_variants(state_value, "state")},
            config,
            timeout_seconds=4,
            commit_autocomplete=True,
        )
        if not filled_state:
            await select_first_matching(
                page,
                [
                    "select[autocomplete='billing address-level1']",
                    "select[name*='billing' i][name*='province' i]",
                    "select[name*='billing' i][name*='state' i]",
                    "select[autocomplete='address-level1']",
                    "select[name*='province' i]",
                    "select[name*='state' i]",
                    "select[id*='province' i]",
                    "select[id*='state' i]",
                ],
                _location_variants(state_value, "state"),
                timeout_seconds=4,
            )

    if sensitive_data.get("billing_postal"):
        await fill_first_matching(
            page,
            [
                "input[autocomplete='billing postal-code']",
                "input[name*='billing' i][name*='postal' i]",
                "input[name*='billing' i][name*='zip' i]",
                "input[autocomplete='postal-code']",
                "input[name*='postal' i]",
                "input[name*='zip' i]",
                "input[aria-label*='ZIP' i]",
                "input[aria-label*='Postal' i]",
            ],
            sensitive_data["billing_postal"],
            lambda raw: normalize_text(raw).replace(" ", "").upper()
            == normalize_text(sensitive_data["billing_postal"]).replace(" ", "").upper(),
            config,
            timeout_seconds=4,
        )

    if sensitive_data.get("billing_phone"):
        await fill_first_matching(
            page,
            [
                "input[autocomplete='billing tel']",
                "input[name*='billing' i][name*='phone' i]",
                "input[autocomplete='tel']",
                "input[name*='phone' i]",
                "input[id*='phone' i]",
            ],
            sensitive_data["billing_phone"],
            lambda raw: normalize_text(raw) == normalize_text(sensitive_data["billing_phone"]),
            config,
            timeout_seconds=4,
        )


async def continue_to_payment_if_needed(page: Any) -> None:
    await click_first_visible(
        page,
        [
            "button:has-text('Continue to payment')",
            "button:has-text('Continue')",
            "button:has-text('Go to payment')",
        ],
        timeout_ms=2500,
    )


async def fill_checkout_identity(page: Any, sensitive_data: dict[str, str], config: Any) -> tuple[bool, bool | None, bool | None]:
    contact_filled = await fill_contact(page, sensitive_data, config)
    delivery_filled = await fill_delivery(page, sensitive_data, config)
    await continue_to_payment_if_needed(page)
    await pause(config, 0.8)
    await fill_billing_identity(page, sensitive_data, config)
    billing_filled = await verify_billing_identity(page, sensitive_data)
    await pause(config, 0.3)
    return contact_filled, delivery_filled, billing_filled


def needs_identity_retry(delivery_filled: bool | None, billing_filled: bool | None) -> bool:
    return delivery_filled is False or billing_filled is False


async def _read_first_visible_value(page: Any, selectors: list[str]) -> str:
    for selector in selectors:
        try:
            locator = page.locator(selector)
            count = min(await locator.count(), 4)
        except Exception:
            continue
        for index in range(count):
            candidate = locator.nth(index)
            try:
                if not await candidate.is_visible():
                    continue
                if normalize_text(await candidate.get_attribute("aria-hidden")).lower() == "true":
                    continue
                tag = await candidate.evaluate("(el) => el.tagName.toLowerCase()")
                if tag == "select":
                    try:
                        selected = candidate.locator("option:checked").first
                        text = normalize_text(await selected.inner_text())
                        if text:
                            return text
                    except Exception:
                        pass
                value = normalize_text(await candidate.input_value())
                if value:
                    return value
                text_value = normalize_text(await candidate.text_content())
                if text_value:
                    return text_value
            except Exception:
                continue
    return ""


def _matches_expected(raw: str, expected: str) -> bool:
    lhs = normalize_text(raw).lower()
    rhs = normalize_text(expected).lower()
    if not rhs:
        return True
    return lhs == rhs or lhs.endswith(rhs) or rhs.endswith(lhs) or rhs in lhs or lhs in rhs


async def verify_delivery(page: Any, sensitive_data: dict[str, str]) -> bool | None:
    checks: list[tuple[str, list[str]]] = []
    _delivery_name, first_name, last_name = _resolved_name(sensitive_data, "delivery")
    if first_name:
        checks.append(
            (
                first_name,
                [
                    "input[autocomplete='shipping given-name']",
                    "input[name*='shipping' i][name*='first' i]",
                    "input[aria-label='First name']",
                    "input[autocomplete='given-name']",
                    "input[name*='first_name' i]",
                    "input[name='firstName']",
                ],
            )
        )
    if last_name:
        checks.append(
            (
                last_name,
                [
                    "input[autocomplete='shipping family-name']",
                    "input[name*='shipping' i][name*='last' i]",
                    "input[aria-label='Last name']",
                    "input[autocomplete='family-name']",
                    "input[name*='last_name' i]",
                    "input[name='lastName']",
                ],
            )
        )
    if sensitive_data.get("delivery_address1"):
        checks.append(
            (
                _preferred_profile_value(sensitive_data, "delivery", "address1"),
                [
                    "input[autocomplete='shipping address-line1']",
                    "input[autocomplete='shipping street-address']",
                    "input[name*='shipping' i][name*='address1' i]",
                    "input[aria-label='Address']",
                    "[role='combobox'][aria-label='Address']",
                    "input[autocomplete='address-line1']",
                    "input[autocomplete='street-address']",
                    "input[name*='address1' i]",
                ],
            )
        )
    if sensitive_data.get("delivery_city"):
        checks.append(
            (
                _location_variants(_preferred_profile_value(sensitive_data, "delivery", "city"), "city")[0],
                [
                    "input[autocomplete='shipping address-level2']",
                    "input[name*='shipping' i][name*='city' i]",
                    "input[aria-label='City']",
                    "input[autocomplete='address-level2']",
                    "input[name*='city' i]",
                ],
            )
        )
    if sensitive_data.get("delivery_state"):
        checks.append(
            (
                _location_variants(_preferred_profile_value(sensitive_data, "delivery", "state"), "state")[0],
                [
                    "input[autocomplete='shipping address-level1']",
                    "select[autocomplete='shipping address-level1']",
                    "input[name*='shipping' i][name*='state' i]",
                    "select[name*='shipping' i][name*='state' i]",
                    "input[name*='shipping' i][name*='province' i]",
                    "select[name*='shipping' i][name*='province' i]",
                    "input[aria-label='Province']",
                    "select[aria-label='Province']",
                    "input[aria-label='State']",
                    "select[aria-label='State']",
                    "input[autocomplete='address-level1']",
                    "select[autocomplete='address-level1']",
                    "input[name*='state' i]",
                    "select[name*='state' i]",
                    "input[name*='province' i]",
                    "select[name*='province' i]",
                ],
            )
        )
    if sensitive_data.get("delivery_postal"):
        checks.append(
            (
                sensitive_data["delivery_postal"],
                [
                    "input[autocomplete='shipping postal-code']",
                    "input[name*='shipping' i][name*='postal' i]",
                    "input[name*='shipping' i][name*='zip' i]",
                    "input[aria-label='Postal code']",
                    "input[autocomplete='postal-code']",
                    "input[name*='postal' i]",
                    "input[name*='zip' i]",
                ],
            )
        )

    if not checks:
        return None

    for expected, selectors in checks:
        actual = await _read_first_visible_value(page, selectors)
        if not _matches_expected(actual, expected):
            return False
    if await _contains_validation_snippet(page, DELIVERY_VALIDATION_SNIPPETS):
        return False
    return True


async def verify_billing_identity(page: Any, sensitive_data: dict[str, str]) -> bool | None:
    if normalize_text(sensitive_data.get("billing_same_as_delivery", "")).lower() in {"1", "true", "yes", "on"}:
        return True
    checks: list[tuple[str, list[str]]] = []
    _billing_name, first_name, last_name = _resolved_name(sensitive_data, "billing")
    if not first_name and not last_name and sensitive_data.get("card_name"):
        _card_name, first_name, last_name = _resolved_name({"billing_name": sensitive_data.get("card_name", "")}, "billing")
    if first_name:
        checks.append(
            (
                first_name,
                [
                    "input[autocomplete='billing given-name']",
                    "input[name*='billing' i][name*='first' i]",
                    "input[autocomplete='given-name']",
                    "input[name*='first_name' i]",
                    "input[name='firstName']",
                ],
            )
        )
    if last_name:
        checks.append(
            (
                last_name,
                [
                    "input[autocomplete='billing family-name']",
                    "input[name*='billing' i][name*='last' i]",
                    "input[autocomplete='family-name']",
                    "input[name*='last_name' i]",
                    "input[name='lastName']",
                ],
            )
        )
    if sensitive_data.get("billing_address1"):
        checks.append(
            (
                _preferred_profile_value(sensitive_data, "billing", "address1"),
                [
                    "input[autocomplete='billing address-line1']",
                    "input[autocomplete='billing street-address']",
                    "input[name*='billing' i][name*='address1' i]",
                    "input[autocomplete='address-line1']",
                    "input[autocomplete='street-address']",
                    "input[name*='address1' i]",
                ],
            )
        )
    if sensitive_data.get("billing_city"):
        checks.append(
            (
                _location_variants(_preferred_profile_value(sensitive_data, "billing", "city"), "city")[0],
                [
                    "input[autocomplete='billing address-level2']",
                    "input[name*='billing' i][name*='city' i]",
                    "input[autocomplete='address-level2']",
                    "input[name*='city' i]",
                ],
            )
        )
    if sensitive_data.get("billing_state"):
        checks.append(
            (
                _location_variants(_preferred_profile_value(sensitive_data, "billing", "state"), "state")[0],
                [
                    "input[autocomplete='billing address-level1']",
                    "select[autocomplete='billing address-level1']",
                    "input[name*='billing' i][name*='state' i]",
                    "select[name*='billing' i][name*='state' i]",
                    "input[name*='billing' i][name*='province' i]",
                    "select[name*='billing' i][name*='province' i]",
                    "input[autocomplete='address-level1']",
                    "select[autocomplete='address-level1']",
                    "input[name*='state' i]",
                    "select[name*='state' i]",
                    "input[name*='province' i]",
                    "select[name*='province' i]",
                ],
            )
        )
    if sensitive_data.get("billing_postal"):
        checks.append(
            (
                sensitive_data["billing_postal"],
                [
                    "input[autocomplete='billing postal-code']",
                    "input[name*='billing' i][name*='postal' i]",
                    "input[name*='billing' i][name*='zip' i]",
                    "input[autocomplete='postal-code']",
                    "input[name*='postal' i]",
                    "input[name*='zip' i]",
                ],
            )
        )

    if not checks:
        return None

    for expected, selectors in checks:
        actual = await _read_first_visible_value(page, selectors)
        if not _matches_expected(actual, expected):
            return False
    if await _contains_validation_snippet(page, BILLING_VALIDATION_SNIPPETS):
        return False
    return True


async def save_checkout_screenshot(page: Any, traces_dir: Path, run_id: str, stem: str) -> str | None:
    screenshot_dir = traces_dir.parent / "screenshots" / run_id
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    path = screenshot_dir / f"{stem}.png"
    try:
        await page.screenshot(path=str(path), full_page=True)
    except Exception:
        return None
    return str(path)


def _looks_like_checkout_url(value: str | None) -> bool:
    lowered = normalize_text(value).lower()
    return bool(
        lowered
        and (
            "/checkouts/" in lowered
            or lowered.rstrip("/").endswith("/checkout")
            or "checkout.shopify.com" in lowered
            or "pay.shopify.com" in lowered
        )
    )


async def _select_handoff_page(browser_connection: Any, checkout_url: str) -> tuple[Any, Any]:
    best_context = None
    best_page = None
    best_score = -1
    for context in list(getattr(browser_connection, "contexts", [])):
        for page in list(getattr(context, "pages", [])):
            try:
                url = page.url
            except Exception:
                url = ""
            score = 0
            if checkout_url and url == checkout_url:
                score += 100
            if _looks_like_checkout_url(url):
                score += 50
            if url and url != "about:blank":
                score += 10
            if score > best_score:
                best_score = score
                best_context = context
                best_page = page

    if best_context is None:
        contexts = list(getattr(browser_connection, "contexts", []))
        if not contexts:
            raise RuntimeError("Browser Use handoff did not expose any Playwright browser context.")
        best_context = contexts[0]

    if best_page is None:
        pages = list(getattr(best_context, "pages", []))
        if pages:
            best_page = pages[0]
        else:
            best_page = await best_context.new_page()
    return best_context, best_page


def describe_surface(iframe_values: list[str], button_values: list[str]) -> str:
    iframe_hosts = []
    for value in iframe_values[:4]:
        host = urlparse(value).netloc or value
        if host and host not in iframe_hosts:
            iframe_hosts.append(host)
    buttons = [normalize_text(value) for value in button_values[:6] if normalize_text(value)]
    parts = []
    if iframe_hosts:
        parts.append(f"iframe_hosts={','.join(iframe_hosts)}")
    if buttons:
        parts.append(f"buttons={' | '.join(buttons)}")
    return "; ".join(parts)


async def run_checkout_flow(
    config: Any,
    navigation_payload: dict[str, Any],
    sensitive_data: dict[str, str],
    user_data_dir: Path | None,
    run_id: str,
    traces_dir: Path,
    videos_dir: Path | None,
    runtime: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if async_playwright is None:
        raise RuntimeError(f"Playwright is required for checkout execution: {PLAYWRIGHT_IMPORT_ERROR}")

    payload = {
        "entryUrl": navigation_payload.get("entryUrl") or navigation_payload.get("candidateChosen"),
        "candidateChosen": navigation_payload.get("candidateChosen"),
        "storeDomain": navigation_payload.get("storeDomain"),
        "productUrl": navigation_payload.get("productUrl"),
        "checkoutUrl": navigation_payload.get("checkoutUrl"),
        "provider": navigation_payload.get("provider"),
        "displayedTotal": navigation_payload.get("displayedTotal"),
        "giftCardDenomination": navigation_payload.get("giftCardDenomination"),
        "contactFilled": False,
        "deliveryFilled": None,
        "billingIdentityFilled": None,
        "postalFilled": False,
        "residentIdFilled": None,
        "paymentFieldVerification": None,
        "legalConsentChecked": None,
        "saveInfoUnchecked": None,
        "filledCheckoutScreenshot": None,
        "hint": navigation_payload.get("hint", ""),
        "outcome": {"status": navigation_payload.get("outcome", {}).get("status", "unknown"), "hint": navigation_payload.get("hint", "")},
    }
    checkout_url = payload.get("checkoutUrl")
    if not checkout_url:
        return normalize_checkout_state(config.mode, payload, max_total_usd=config.max_total_usd)

    playwright = None
    browser_connection = None
    context = None
    page = None
    browser_use_handoff = False
    created_runtime = runtime is None
    trace_path = Path(runtime["trace_path"]) if runtime and runtime.get("trace_path") else traces_dir / f"checkout-{run_id}.zip"
    trace_started_here = False
    trace_started_before = bool(runtime and runtime.get("trace_started"))

    try:
        if runtime is not None and runtime.get("handoff") == "browser_use_cdp":
            browser_use_handoff = True
            playwright = await async_playwright().start()  # pragma: no cover - runtime integration
            browser_connection = await playwright.chromium.connect_over_cdp(runtime["cdp_url"], timeout=45_000)
            context, page = await _select_handoff_page(browser_connection, checkout_url)
            if config.record_trace:
                try:
                    await context.tracing.start(screenshots=True, snapshots=True, sources=False)
                    trace_started_here = True
                except Exception:
                    pass
        elif runtime is not None:
            playwright = runtime.get("playwright")
            context = runtime["context"]
            page = runtime["page"]
        else:
            playwright = await async_playwright().start()  # pragma: no cover - runtime integration
            context = await playwright.chromium.launch_persistent_context(
                user_data_dir=str(user_data_dir or config.out_dir / "shopify-profile"),
                headless=not config.headed,
                channel=config.browser_channel,
                ignore_https_errors=True,
                record_video_dir=str(videos_dir) if videos_dir else None,
            )
            page = context.pages[0] if context.pages else await context.new_page()
            if config.record_trace:
                await context.tracing.start(screenshots=True, snapshots=True, sources=False)
                trace_started_here = True

        try:
            if "/checkouts/" not in (page.url or "") and page.url != checkout_url:
                await page.goto(checkout_url, wait_until="domcontentloaded", timeout=45_000)
            if "/checkouts/" in (page.url or "") or "/checkout" in (page.url or ""):
                payload["checkoutUrl"] = page.url
            await maybe_click_guest_checkout(page)
            await pause(config, 0.5)

            body = normalize_text(await page.locator("body").inner_text(timeout=4_000))
            if looks_like_security_verification(body):
                payload["outcome"] = {"status": "needs_manual_verification", "hint": "Checkout requires CAPTCHA, Cloudflare, or another manual verification step."}
                return normalize_checkout_state(config.mode, payload, max_total_usd=config.max_total_usd)

            contact_filled = False
            delivery_filled: bool | None = None
            billing_filled: bool | None = None
            for attempt in range(2):
                contact_filled, delivery_filled, billing_filled = await fill_checkout_identity(page, sensitive_data, config)
                if not needs_identity_retry(delivery_filled, billing_filled):
                    break
                if attempt == 0:
                    await pause(config, 1.0)
            payload["contactFilled"] = contact_filled
            payload["deliveryFilled"] = delivery_filled
            payload["billingIdentityFilled"] = billing_filled

            body = normalize_text(await page.locator("body").inner_text(timeout=4_000))
            payload["displayedTotal"] = money_from_text(body)

            frame_values = await iframe_urls(page)
            button_values = await visible_button_texts(page)
            provider_info = detect_provider(
                page.url,
                html=await page.content(),
                iframe_urls=frame_values,
                button_texts=button_values,
            )
            payload["provider"] = provider_info["provider"]
            surface_summary = describe_surface(frame_values, button_values)
            if provider_info["hints"]:
                payload["hint"] = "; ".join(provider_info["hints"])
            if surface_summary:
                payload["hint"] = "; ".join(item for item in [payload["hint"], surface_summary] if item)

            if payload["provider"] not in ADAPTERS:
                payload["outcome"] = {
                    "status": "unsupported_provider" if payload["provider"] == "unsupported" else "unknown",
                    "hint": payload["hint"] or "This store is using a checkout flow that FluxA Agentic Checkout cannot complete automatically yet.",
                }
                return normalize_checkout_state(config.mode, payload, max_total_usd=config.max_total_usd)

            adapter_result = await ADAPTERS[payload["provider"]](page, config, sensitive_data)
            blocking_fields = await detect_blocking_fields(page)
            payload.update(
                {
                    "provider": adapter_result.get("provider", payload["provider"]),
                    "postalFilled": adapter_result.get("postalFilled", False),
                    "residentIdFilled": adapter_result.get("residentIdFilled"),
                    "paymentFieldVerification": adapter_result.get("paymentFieldVerification"),
                    "legalConsentChecked": adapter_result.get("legalConsentChecked"),
                    "blockingFields": blocking_fields,
                    "saveInfoUnchecked": adapter_result.get("saveInfoUnchecked"),
                    "outcome": adapter_result.get("outcome", {"status": "unknown", "hint": None}),
                }
            )
            payload["filledCheckoutScreenshot"] = await save_checkout_screenshot(page, traces_dir, run_id, "02-filled-checkout")
            return normalize_checkout_state(config.mode, payload, max_total_usd=config.max_total_usd)
        finally:
            if context is not None and config.record_trace and (trace_started_here or trace_started_before):
                try:
                    await context.tracing.stop(path=str(trace_path))
                except Exception:
                    pass
            if browser_use_handoff and browser_connection is not None:
                try:
                    await asyncio.wait_for(browser_connection.close(), timeout=10)
                except Exception:
                    pass
            elif context is not None:
                try:
                    await asyncio.wait_for(context.close(), timeout=10)
                except Exception:
                    pass
            if (created_runtime or browser_use_handoff) and playwright is not None:
                try:
                    await asyncio.wait_for(playwright.stop(), timeout=5)
                except Exception:
                    pass
    finally:
        if runtime is not None and browser_use_handoff and runtime.get("browser_session") is not None:
            stop = getattr(runtime["browser_session"], "stop", None)
            if callable(stop):
                try:
                    await asyncio.wait_for(stop(), timeout=5)
                except Exception:
                    pass
        elif runtime is not None and runtime.get("playwright") is not None:
            try:
                await asyncio.wait_for(runtime["playwright"].stop(), timeout=5)
            except Exception:
                pass
