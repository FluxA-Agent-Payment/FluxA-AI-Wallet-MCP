"""Discover products and read anonymous cart and checkout quotes through Shop MCP."""

import json
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from pydantic import AfterValidator, AliasPath, BaseModel, ConfigDict, Field, computed_field, field_validator

from .contract import VARIANT_ID

SHOP_MCP_URL = "https://mcp.shop.com/"
MCP_VERSION = "2026-07-28"
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_SAFE_AMOUNT = 2**53 - 1

Country = Annotated[str, Field(pattern=r"^[A-Z]{2}$")]
Currency = Annotated[str, Field(pattern=r"^[A-Z]{3}$")]
Merchant = Annotated[str, Field(pattern=r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$")]
VariantGID = Annotated[str, Field(
    max_length=512, pattern=rf"^gid://shopify/ProductVariant/{VARIANT_ID.pattern}(?:\?[^\s#]+)?$",
)]
ProviderRef = Annotated[str, Field(min_length=1, max_length=2048)]
IdempotencyKey = Annotated[UUID, Field(strict=False)]


class ShopRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class CatalogSearchRequest(ShopRequest):
    query: str = Field(max_length=256, pattern=r"\S")
    country: Country
    currency: Currency
    limit: int = Field(default=10, ge=1, le=50)
    cursor: str | None = Field(default=None, min_length=1, max_length=2048)


class CartItemRequest(ShopRequest):
    variant_id: VariantGID
    quantity: int = Field(ge=1, le=100)


class CreateCartRequest(ShopRequest):
    merchant: Merchant
    items: list[CartItemRequest] = Field(min_length=1, max_length=50)
    country: Country
    currency: Currency
    idempotency_key: IdempotencyKey


class CreateCheckoutQuoteRequest(ShopRequest):
    merchant: Merchant
    cart_ref: ProviderRef = Field(repr=False)
    idempotency_key: IdempotencyKey


class ReadCheckoutQuoteRequest(ShopRequest):
    merchant: Merchant
    checkout_ref: ProviderRef = Field(repr=False)


def require_https(url: str) -> str:
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
            or any(character.isspace() or ord(character) < 32 for character in url)):
        raise ValueError("Shopify returned an invalid HTTPS URL.")
    return url


class ShopResponse(BaseModel):
    model_config = ConfigDict(strict=True)


class CartItem(ShopResponse):
    variant_id: VariantGID = Field(validation_alias=AliasPath("item", "id"))
    quantity: int = Field(ge=1)
    title: str = Field(validation_alias=AliasPath("item", "title"))


class Total(ShopResponse):
    type: str
    amount: int = Field(ge=-MAX_SAFE_AMOUNT, le=MAX_SAFE_AMOUNT)
    display_text: str | None = None


class PolicyLink(ShopResponse):
    type: str
    url: Annotated[str, AfterValidator(require_https)]
    title: str | None = None


class Message(ShopResponse):
    type: str
    code: str | None = None
    content: str
    severity: str | None = None
    path: str | None = None


class CartSummary(ShopResponse):
    merchant: Merchant
    currency: Currency
    items: list[CartItem] = Field(validation_alias="line_items")
    totals: list[Total]
    messages: list[Message] = Field(default_factory=list)
    links: list[PolicyLink] = Field(default_factory=list)
    expires_at: str | None = None

    @field_validator("totals")
    @classmethod
    def require_total(cls, totals: list[Total]) -> list[Total]:
        amounts = [total.amount for total in totals if total.type == "total"]
        if len(amounts) != 1 or amounts[0] < 0:
            raise ValueError("Shopify did not return a grand total.")
        return totals


class CartSnapshot(CartSummary):
    cart_ref: ProviderRef = Field(validation_alias="id", repr=False)


class CheckoutQuote(CartSummary):
    checkout_ref: ProviderRef = Field(validation_alias="id", repr=False)
    status: Literal["incomplete", "requires_escalation", "ready_for_complete",
                    "complete_in_progress", "completed", "canceled"]
    continue_url: Annotated[str, AfterValidator(require_https)] | None = Field(default=None, repr=False)

    @computed_field
    @property
    def amount_provisional(self) -> bool:
        return self.status not in {"ready_for_complete", "complete_in_progress", "completed"}


def shop_call(tool: str, arguments: dict) -> dict:
    params = {
        "name": tool,
        "arguments": arguments,
        "_meta": {
            "io.modelcontextprotocol/protocolVersion": MCP_VERSION,
            "io.modelcontextprotocol/clientInfo": {"name": "FluxA Shopify Checkout", "version": "0.1.0"},
            "io.modelcontextprotocol/clientCapabilities": {},
        },
    }
    headers = {
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_VERSION,
        "Mcp-Method": "tools/call",
        "Mcp-Name": tool,
    }
    with httpx.stream("POST", SHOP_MCP_URL, headers=headers, timeout=8.0,
                      json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": params}) as response:
        response.raise_for_status()
        body = bytearray()
        for chunk in response.iter_bytes():
            if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                raise ValueError("Shopify response exceeds its size limit.")
            body.extend(chunk)

    reply = json.loads(body)
    result = reply.get("result") if isinstance(reply, dict) and reply.get("id") == 1 else None
    document = result.get("structuredContent") if isinstance(result, dict) and not result.get("isError") else None
    if not isinstance(document, dict):
        raise ValueError("Shopify did not return a result.")
    return document


def search_catalog(search: CatalogSearchRequest) -> dict:
    pagination: dict[str, int | str] = {"limit": search.limit}
    if search.cursor is not None:
        pagination["cursor"] = search.cursor
    document = shop_call("search_catalog", {"catalog": {
        "query": search.query,
        "context": {"address_country": search.country, "currency": search.currency},
        "pagination": pagination,
    }})
    if not isinstance(document.get("products"), list):
        raise ValueError("Shopify did not return a catalog result.")
    return {key: document[key] for key in ("products", "messages", "pagination") if key in document}


def create_cart(request: CreateCartRequest) -> dict:
    cart = shop_call("create_cart", {
        "shop": request.merchant,
        "cart": {
            "line_items": [{"item": {"id": item.variant_id}, "quantity": item.quantity} for item in request.items],
            "context": {"address_country": request.country, "currency": request.currency},
        },
        "meta": {"idempotency-key": str(request.idempotency_key)},
    })
    return CartSnapshot.model_validate({**cart, "merchant": request.merchant}).model_dump(exclude_none=True)


def checkout_quote(checkout: dict, merchant: str) -> CheckoutQuote:
    return CheckoutQuote.model_validate({**checkout, "merchant": merchant})


def create_checkout_quote(request: CreateCheckoutQuoteRequest) -> dict:
    checkout = shop_call("create_checkout", {
        "shop": request.merchant,
        "checkout": {"cart_id": request.cart_ref, "line_items": []},
        "meta": {"idempotency-key": str(request.idempotency_key)},
    })
    return checkout_quote(checkout, request.merchant).model_dump(exclude_none=True)


def get_checkout_quote(request: ReadCheckoutQuoteRequest) -> dict:
    checkout = shop_call("get_checkout", {"shop": request.merchant, "id": request.checkout_ref})
    quote = checkout_quote(checkout, request.merchant)
    if quote.checkout_ref != request.checkout_ref:
        raise ValueError("Shopify returned a different checkout.")
    return quote.model_dump(exclude_none=True)
