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
            return f"{base} 链接如下，你点击进去继续即可：{link}"
        return base
    if phase == "preview_complete":
        return "这边已经帮你把信息填写到付款前了。请先确认 Delivery 和 Billing 是否正确，确认没问题后再决定是否点击 Pay now。"
    if phase == "payment_details_filled":
        if blocking_fields:
            labels = "、".join(blocking_fields[:3])
            base = f"这边已经帮你进入 checkout，并填好了大部分信息。不过这个商家还要求补充 {labels}，这一步需要你手动完成。"
        else:
            base = "这边已经帮你进入 checkout，但有些 Delivery、Billing 或支付信息还没能稳定补全，所以需要你手动继续一下。"
        return with_link(base)
    if phase in {"unsupported_provider", "needs_manual_verification"}:
        base = "这边已经帮你推进到结账环节了，不过当前页面需要人工继续操作，暂时不能完全自动完成。"
        return with_link(base)
    if phase == "limit_exceeded":
        return "这边先帮你停下来了，因为当前商品金额超过了这次允许的上限。"
    if phase == "execute_fail":
        base = "这边暂时没能帮你完成最终支付提交。你可以先检查 Delivery、Billing 和卡片信息，再继续结账。"
        return with_link(base)
    if phase == "execute_success":
        return "这边已经帮你提交成功了。"
    if phase == "checkout_reached":
        return with_link("这边已经帮你打开结账页了，不过还没能把信息完整填写到可支付状态。")
    if phase == "product_selected":
        return with_link("这边已经打开商品页了，但暂时没能稳定加入购物车。你可以稍后重试，或者把这个链接交给我继续排查。")
    if phase == "candidate_selected":
        return with_link("这边已经打开商家页面了，但暂时还没能确认可直接推进的商品或结账入口。你可以把更具体的商品链接发我，我继续帮你处理。")
    if phase == "no_shopify_candidate":
        return "这边暂时没找到可继续自动结账的商品页面。你可以给我一个更具体的商品链接，我继续帮你推进。"
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
