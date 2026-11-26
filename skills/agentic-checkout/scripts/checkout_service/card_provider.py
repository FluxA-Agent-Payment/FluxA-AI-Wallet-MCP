"""Connect checkout to an operator-provided buyer profile and browser card service."""

import json
import re
from uuid import UUID

import httpx

MAX_RESPONSE_BYTES = 64 * 1024
PROFILE_FIELDS = {"buyer_id", "email", "delivery", "billing"}
BROWSER_CARD_FIELDS = {"card_number", "exp", "cvc", "name"}


class CardProviderError(ValueError):
    pass


class CardProvider:
    def __init__(self, origin: str, token: str):
        try:
            url = httpx.URL(origin)
        except httpx.InvalidURL:
            raise ValueError("Configure a valid checkout card provider origin.") from None
        loopback = url.scheme == "http" and url.host in {"127.0.0.1", "::1"}
        if (not url.host or not re.fullmatch(r"https?://[^/?#@\\\s]+/?", origin)
                or (url.scheme != "https" and not loopback)):
            raise ValueError("Configure the checkout card provider with an HTTPS origin.")
        if not re.fullmatch(r"[A-Za-z0-9._~+/-]+=*", token):
            raise ValueError("Configure a checkout card provider bearer token.")
        self._origin = str(url).rstrip("/")
        self._headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Accept-Encoding": "identity",
            "Cache-Control": "no-store",
        }

    def _request(self, path: str, request: dict, *, idempotency_key: str | None = None) -> dict:
        headers = dict(self._headers)
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key
        try:
            with httpx.stream(
                "POST", self._origin + path, json=request, headers=headers,
                timeout=5.0, trust_env=False, follow_redirects=False,
            ) as response:
                content_encoding = response.headers.get("Content-Encoding", "identity").lower()
                if response.status_code != 200 or content_encoding != "identity":
                    raise CardProviderError("The checkout card provider request failed.")
                content = bytearray()
                for chunk in response.iter_raw():
                    if len(content) + len(chunk) > MAX_RESPONSE_BYTES:
                        raise CardProviderError("The checkout card provider response is too large.")
                    content.extend(chunk)
            result = json.loads(content)
        except (httpx.HTTPError, UnicodeError, json.JSONDecodeError, RecursionError):
            raise CardProviderError("The checkout card provider response is unavailable.") from None
        if (not isinstance(result, dict)
                or json.dumps(result.get("binding"), sort_keys=True) != json.dumps(request, sort_keys=True)):
            raise CardProviderError("The checkout card provider response did not match the request.")
        return result

    def profile(self, purchase_id: UUID, merchant: str, country: str) -> dict:
        result = self._request("/v1/checkout/profiles", {
            "purchase_id": str(purchase_id), "merchant": merchant, "country": country,
        })
        profile = result.get("profile")
        if (not isinstance(profile, dict) or profile.keys() != PROFILE_FIELDS
                or not all(isinstance(profile[key], str) and profile[key].strip() for key in ("buyer_id", "email"))
                or not all(isinstance(profile[key], dict) for key in ("delivery", "billing"))):
            raise CardProviderError("The checkout card provider returned an invalid buyer profile.")
        return profile

    def card(self, request: dict) -> dict | None:
        result = self._request("/v1/checkout/card-claims", request, idempotency_key=request["quote_id"])
        if result.get("decision") == "denied":
            return None
        card = result.get("card")
        if (result.get("decision") != "approved" or result.get("credential_type") != "browser_card"
                or not isinstance(card, dict) or card.keys() != BROWSER_CARD_FIELDS
                or not all(isinstance(value, str) and value.strip() for value in card.values())):
            raise CardProviderError("The checkout card provider returned an invalid browser card decision.")
        return card
