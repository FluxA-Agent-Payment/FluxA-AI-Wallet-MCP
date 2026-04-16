#!/usr/bin/env python3
"""Shared text heuristics for security and checkout states."""

from __future__ import annotations

from typing import Any
import re


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def digits(value: Any) -> str:
    return re.sub(r"\D+", "", str(value or ""))


def money_from_text(text: str) -> float | None:
    patterns = (
        r"(?:US\$|CA\$|CAD\$|USD\$|\$)\s*([0-9]+(?:\.[0-9]{1,2})?)",
        r"total\s+([0-9]+(?:\.[0-9]{1,2})?)",
    )
    for pattern in patterns:
        match = re.search(pattern, text or "", re.I)
        if not match:
            continue
        try:
            return float(match.group(1))
        except ValueError:
            continue
    return None


def looks_like_security_verification(text: str) -> bool:
    return bool(
        re.search(
            r"performing security verification|security service to protect against malicious bots|"
            r"verify you are human|checking your browser|cloudflare|turnstile|captcha|challenge",
            text or "",
            re.I,
        )
    )


def looks_like_checkout_success(text: str, url: str) -> bool:
    haystack = f"{text} {url}".lower()
    return bool(
        re.search(
            r"thank you|receipt|order confirmed|payment successful|gift card will be sent|complete",
            haystack,
        )
    )


def looks_like_checkout_failure(text: str) -> bool:
    return bool(
        re.search(
            r"payment failed|declined|card was declined|authentication failed|could not be completed|invalid postal",
            text or "",
            re.I,
        )
    )
