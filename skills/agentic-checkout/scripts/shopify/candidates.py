#!/usr/bin/env python3
"""Candidate scoring helpers for Shopify gift card discovery."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse
import json
import re


GIFT_CARD_PATTERNS = (
    "gift card",
    "gift-card",
    "giftcard",
    "egift",
    "e-gift",
    "digital gift",
    "gift certificate",
)

NEGATIVE_HOSTS = {
    "apps.shopify.com",
    "help.shopify.com",
    "shopify.com",
    "www.shopify.com",
}

NEGATIVE_TITLE_PATTERNS = (
    "shopify app store",
    "shopify help center",
    "shopify help",
    "shopify blog",
)


@dataclass
class RankedCandidate:
    title: str
    url: str
    snippet: str
    score: int
    reasons: list[str]
    store_domain: str
    looks_like_shopify: bool
    looks_like_product: bool
    looks_like_collection: bool
    looks_like_gift_card: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "url": self.url,
            "snippet": self.snippet,
            "score": self.score,
            "reasons": self.reasons,
            "store_domain": self.store_domain,
            "looks_like_shopify": self.looks_like_shopify,
            "looks_like_product": self.looks_like_product,
            "looks_like_collection": self.looks_like_collection,
            "looks_like_gift_card": self.looks_like_gift_card,
        }


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _query_terms(query: str) -> list[str]:
    return [
        token
        for token in re.findall(r"[a-zA-Z0-9]+", str(query or "").lower())
        if len(token) > 2 and token not in {"shopify", "gift", "card"}
    ]


def _looks_like_gift_card(text: str) -> bool:
    lowered = normalize_text(text).lower()
    return any(pattern in lowered for pattern in GIFT_CARD_PATTERNS)


def _is_shopify_store(host: str) -> bool:
    host = host.lower()
    if host.endswith(".myshopify.com"):
        return True
    if host in NEGATIVE_HOSTS:
        return False
    return "shopify" in host and not host.startswith("apps.")


def normalize_candidates(raw_candidates: Any) -> list[dict[str, str]]:
    if raw_candidates is None:
        return []
    if isinstance(raw_candidates, str):
        try:
            raw_candidates = json.loads(raw_candidates)
        except json.JSONDecodeError:
            raw_candidates = [raw_candidates]
    normalized: list[dict[str, str]] = []
    for item in raw_candidates:
        if isinstance(item, str):
            url = normalize_text(item)
            if url:
                normalized.append({"title": "", "url": url, "snippet": ""})
            continue
        if isinstance(item, dict):
            url = normalize_text(item.get("url"))
            if not url:
                continue
            normalized.append(
                {
                    "title": normalize_text(item.get("title")),
                    "url": url,
                    "snippet": normalize_text(item.get("snippet") or item.get("content")),
                }
            )
    return normalized


def score_candidate(candidate: dict[str, str], query: str = "") -> RankedCandidate:
    url = normalize_text(candidate.get("url"))
    title = normalize_text(candidate.get("title"))
    snippet = normalize_text(candidate.get("snippet"))
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    path = parsed.path.lower()
    haystack = f"{title} {snippet} {path}".lower()
    score = 0
    reasons: list[str] = []

    looks_like_shopify = _is_shopify_store(host)
    looks_like_product = "/products/" in path
    looks_like_collection = "/collections/" in path
    looks_like_gift_card = _looks_like_gift_card(haystack)

    if parsed.scheme not in {"http", "https"} or not host:
        reasons.append("discard:invalid_url")
        return RankedCandidate(
            title=title,
            url=url,
            snippet=snippet,
            score=-10_000,
            reasons=reasons,
            store_domain=host,
            looks_like_shopify=False,
            looks_like_product=False,
            looks_like_collection=False,
            looks_like_gift_card=False,
        )

    if host in NEGATIVE_HOSTS:
        score -= 120
        reasons.append("negative:shopify_docs_or_apps")
    elif host.endswith(".myshopify.com"):
        score += 80
        reasons.append("positive:myshopify_store")
    elif looks_like_shopify:
        score += 25
        reasons.append("positive:shopify_domain")

    if looks_like_product:
        score += 70
        reasons.append("positive:direct_product_page")
    elif looks_like_collection:
        score += 30
        reasons.append("positive:collection_page")
    elif path in {"", "/"}:
        score += 10
        reasons.append("positive:store_homepage")

    if looks_like_gift_card:
        score += 45
        reasons.append("positive:gift_card_match")

    if any(pattern in f"{title} {snippet}".lower() for pattern in NEGATIVE_TITLE_PATTERNS):
        score -= 100
        reasons.append("negative:title_is_docs_or_blog")

    if "from $" in snippet.lower() or "$" in snippet:
        score += 10
        reasons.append("positive:visible_price_snippet")

    if "add to cart" in snippet.lower() or "buy it now" in snippet.lower():
        score += 8
        reasons.append("positive:buying_intent_snippet")

    for term in _query_terms(query):
        if term in haystack:
            score += 3
            reasons.append(f"positive:query_term:{term}")

    if not looks_like_shopify:
        score -= 50
        reasons.append("negative:not_shopify_store")
    if not looks_like_gift_card:
        score -= 30
        reasons.append("negative:not_gift_card_like")

    return RankedCandidate(
        title=title,
        url=url,
        snippet=snippet,
        score=score,
        reasons=reasons,
        store_domain=host,
        looks_like_shopify=looks_like_shopify,
        looks_like_product=looks_like_product,
        looks_like_collection=looks_like_collection,
        looks_like_gift_card=looks_like_gift_card,
    )


def rank_candidates(raw_candidates: Any, query: str = "", limit: int = 3) -> list[dict[str, Any]]:
    normalized = normalize_candidates(raw_candidates)
    ranked = [score_candidate(candidate, query=query) for candidate in normalized]
    deduped: list[RankedCandidate] = []
    seen_urls: set[str] = set()
    for candidate in sorted(ranked, key=lambda item: item.score, reverse=True):
        if candidate.url in seen_urls:
            continue
        if candidate.score < 0:
            continue
        deduped.append(candidate)
        seen_urls.add(candidate.url)
        if len(deduped) >= max(limit, 1):
            break
    return [candidate.to_dict() for candidate in deduped]

