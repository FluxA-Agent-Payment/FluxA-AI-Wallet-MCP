#!/usr/bin/env python3
"""Structured result helpers for the checkout handoff flow."""

from __future__ import annotations

from typing import Any


FINAL_PHASES = {
    "no_shopify_candidate",
    "candidate_selected",
    "product_selected",
    "checkout_reached",
    "payment_details_filled",
    "preview_complete",
    "execute_success",
    "execute_fail",
    "unsupported_provider",
    "needs_manual_verification",
    "limit_exceeded",
    "timeout",
    "config_error",
    "exception",
}


def default_payload() -> dict[str, Any]:
    return {
        "entryUrl": None,
        "candidateChosen": None,
        "storeDomain": None,
        "productUrl": None,
        "checkoutUrl": None,
        "selectionLabel": None,
        "provider": None,
        "displayedTotal": None,
        "giftCardDenomination": None,
        "contactFilled": False,
        "deliveryFilled": None,
        "billingIdentityFilled": None,
        "postalFilled": False,
        "residentIdFilled": None,
        "blockingFields": [],
        "legalConsentChecked": None,
        "saveInfoUnchecked": None,
        "handoffRequired": False,
        "handoffReason": None,
        "filledCheckoutScreenshot": None,
        "userMessage": None,
        "hint": "",
        "outcome": {"status": "unknown", "hint": None},
    }


def _build_user_message(data: dict[str, Any], phase: str) -> str:
    link = data.get("checkoutUrl") or data.get("productUrl") or data.get("entryUrl") or data.get("candidateChosen")
    blocking_fields = [str(item).strip() for item in (data.get("blockingFields") or []) if str(item).strip()]
    def with_link(base: str) -> str:
        if link:
            return f"{base} You can continue from this link: {link}"
        return base
    if phase == "preview_complete":
        return "I have filled in the checkout information up to the point right before payment. Please confirm that the Delivery and Billing information is correct before deciding whether to click Pay now."
    if phase == "payment_details_filled":
        if blocking_fields:
            labels = ", ".join(blocking_fields[:3])
            base = f"I have already entered checkout and filled most of the information. However, this merchant still requires {labels}, so this step needs to be completed manually."
        else:
            base = "I have already entered checkout, but some Delivery, Billing, or payment details could not be filled reliably, so you need to continue manually from here."
        return with_link(base)
    if phase in {"unsupported_provider", "needs_manual_verification"}:
        base = "I have already progressed the flow to checkout, but the current page requires manual action and cannot be completed fully automatically right now."
        return with_link(base)
    if phase == "limit_exceeded":
        return "I stopped here because the current item total exceeds the allowed limit for this run."
    if phase == "execute_fail":
        base = "I could not complete the final payment submission yet. Please check the Delivery, Billing, and card information before continuing the checkout."
        return with_link(base)
    if phase == "execute_success":
        return "The checkout submission completed successfully."
    if phase == "checkout_reached":
        return with_link("I have opened the checkout page, but the information has not yet been filled completely to a payable state.")
    if phase == "product_selected":
        return with_link("I have opened the product page, but I could not add the item to the cart reliably yet. You can try again later, or send me this link so I can continue investigating.")
    if phase == "candidate_selected":
        return with_link("I have opened the merchant page, but I could not yet identify a product or checkout entry that can be advanced directly. Send me a more specific product link and I can continue from there.")
    if phase == "no_shopify_candidate":
        return "I could not find a product page that can continue through automated checkout yet. Give me a more specific product link and I can keep moving this forward."
    return ""


def normalize_checkout_state(
    mode: str,
    payload: dict[str, Any] | None = None,
    max_total_usd: float | None = None,
) -> dict[str, Any]:
    data = default_payload()
    if payload:
        data.update(payload)
        if payload.get("outcome"):
            data["outcome"] = {"status": "unknown", "hint": None, **payload["outcome"]}
    if not data.get("selectionLabel") and data.get("giftCardDenomination"):
        data["selectionLabel"] = data["giftCardDenomination"]
    if not data.get("entryUrl"):
        data["entryUrl"] = data.get("checkoutUrl") or data.get("productUrl") or data.get("candidateChosen")

    displayed_total = data.get("displayedTotal")
    provider = data.get("provider") or "unknown"
    contact_filled = bool(data.get("contactFilled"))
    delivery_filled = data.get("deliveryFilled")
    billing_identity_filled = data.get("billingIdentityFilled")
    postal_filled = bool(data.get("postalFilled"))
    blocking_fields = [str(item).strip() for item in (data.get("blockingFields") or []) if str(item).strip()]
    legal_consent_checked = data.get("legalConsentChecked")
    if legal_consent_checked is False and "Sensitive personal information consent" not in blocking_fields:
        blocking_fields.append("Sensitive personal information consent")
        data["blockingFields"] = blocking_fields
    save_info_unchecked = data.get("saveInfoUnchecked")
    outcome_status = str(data.get("outcome", {}).get("status") or "unknown")
    hint = str(data.get("hint") or data.get("outcome", {}).get("hint") or "").strip()

    if not data.get("checkoutUrl"):
        if data.get("productUrl"):
            phase = "product_selected"
        elif data.get("candidateChosen"):
            phase = "candidate_selected"
        else:
            phase = "no_shopify_candidate"
        if outcome_status == "unknown":
            outcome_status = phase
    elif max_total_usd is not None and displayed_total is not None and displayed_total > max_total_usd:
        phase = "limit_exceeded"
        outcome_status = "limit_exceeded"
    elif outcome_status in {"needs_manual_verification", "needs_3ds"}:
        phase = "needs_manual_verification"
    elif blocking_fields:
        phase = "execute_fail" if mode == "execute" else "payment_details_filled"
        outcome_status = phase
    elif provider in {"unsupported", "unknown"}:
        phase = "unsupported_provider"
        if outcome_status == "unknown":
            outcome_status = "unsupported_provider" if provider == "unsupported" else "unknown"
    elif mode == "execute":
        if outcome_status == "execute_success":
            phase = "execute_success"
        elif (
            not contact_filled
            or delivery_filled is False
            or billing_identity_filled is False
            or not postal_filled
            or legal_consent_checked is False
            or save_info_unchecked is False
        ):
            phase = "execute_fail"
            if outcome_status == "unknown":
                outcome_status = "execute_fail"
        else:
            phase = "execute_fail" if outcome_status == "execute_fail" else "payment_details_filled"
    else:
        if (
            contact_filled
            and delivery_filled is not False
            and billing_identity_filled is not False
            and postal_filled
            and legal_consent_checked is not False
            and save_info_unchecked is not False
        ):
            phase = "preview_complete"
            outcome_status = "preview_complete"
        elif contact_filled or delivery_filled or billing_identity_filled or postal_filled:
            phase = "payment_details_filled"
        else:
            phase = "checkout_reached"

    if not hint:
        hint = {
            "preview_complete": "Checkout is filled and ready for manual confirmation.",
            "payment_details_filled": "Some payment details were filled, but required validation is incomplete.",
            "checkout_reached": "Reached checkout but payment details were not filled yet.",
            "product_selected": "Reached a product page but not checkout yet.",
            "candidate_selected": "Selected an entry page but did not confirm a supported checkout path yet.",
            "no_shopify_candidate": "No supported entry page was selected.",
            "unsupported_provider": "Detected a checkout surface outside the currently implemented adapters. Hand off to a human operator.",
            "limit_exceeded": "Checkout total exceeded the configured safety limit.",
            "needs_manual_verification": "Manual verification or issuer authentication is required. Hand off to a human operator.",
            "execute_success": "Payment submission reached a success state.",
            "execute_fail": "Payment submission failed or could not be safely completed.",
        }.get(phase, "Checkout run completed.")

    handoff_required = False
    handoff_reason = None
    if phase == "unsupported_provider":
        handoff_required = True
        handoff_reason = "unsupported_provider"
    elif phase == "needs_manual_verification":
        handoff_required = True
        handoff_reason = "3ds_authentication" if outcome_status == "needs_3ds" else "manual_verification"
    elif phase in {"payment_details_filled", "checkout_reached", "execute_fail"} and data.get("checkoutUrl"):
        handoff_required = True
        handoff_reason = "manual_checkout_completion"

    data["phase"] = phase
    data["hint"] = hint
    data["handoffRequired"] = handoff_required
    data["handoffReason"] = handoff_reason
    data["userMessage"] = _build_user_message(data, phase)
    data["outcome"] = {"status": outcome_status, "hint": data.get("outcome", {}).get("hint") or hint}
    return data
