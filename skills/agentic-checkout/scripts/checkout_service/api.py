"""Internal HTTP API and E2B dispatch for authorized Shopify test purchases."""

import hmac
import json
import re
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import asdict, replace
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from e2b import Sandbox
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from httpx import HTTPError, ReadTimeout, TimeoutException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from .attempts import UNKNOWN, Attempts, checkout_digest, order_binding
from .catalog import (
    CatalogSearchRequest, CreateCartRequest, CreateCheckoutQuoteRequest, ReadCheckoutQuoteRequest,
    create_cart, create_checkout_quote, get_checkout_quote, search_catalog,
)
from .contract import (
    ORDER_ID, PCI_HOST, RECEIPT_PATH, RECEIPT_TIMEOUT, SANDBOX_TIMEOUT, TEST_CARDS, VARIANT_ID, WORKER_TIMEOUT,
    CheckoutGrant, PreviewStore, TestStore, checkout_entry_host, checkout_identity,
    is_hostname, uses_test_data, validate_approval,
)
from .reconciliation import read_order_receipt, verify_signature
from .template import SOURCE_MARKER, WORKER_ENV, source_digest

WORKER_COMMAND = "/usr/bin/python3 -m checkout_service."
RESULTS = frozenset({
    "test_data_required", "approval_expired", "manual_verification", "unsupported_checkout",
    "identity_incomplete", "total_mismatch", "payment_fields_incomplete", "checkout_unavailable",
    "checkout_not_ready", "cart_mismatch", "payment_method_unavailable", "payment_failed", UNKNOWN,
})
ADDRESS_FIELDS = ("name", "first_name", "last_name", "company", "address1", "address2", "city", "state", "postal", "country", "phone")
CARD_FIELDS = ("card_number", "exp", "cvc", "name", "postal", "country")
PROVIDER_TIMEOUT = 10
SANDBOX_STARTUP_BUDGET = 45
WEBHOOK_MAX_BYTES = 1024 * 1024


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    merchant: str = Field(max_length=253)
    variant_id: str = Field(pattern=f"^{VARIANT_ID.pattern}$")
    quantity: int = Field(default=1, ge=1, le=100)
    country: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")


class PreviewItem(BaseModel):
    model_config = ConfigDict(strict=True)

    title: str
    quantity: int = Field(ge=1)


class PreviewDisplayTotal(BaseModel):
    model_config = ConfigDict(strict=True)

    currency: str = Field(pattern=r"^[A-Z]{3}$")
    display_amount: str = Field(pattern=r"^[0-9]+(?:\.[0-9]+)?$")


def close_sandbox(sandbox):
    try:
        sandbox.kill(request_timeout=5)
    except Exception:
        # E2B still enforces the kill deadline.
        pass


def open_sandbox(template, digest, hosts, lease=None, *, expires_at=None):
    budget = SANDBOX_STARTUP_BUDGET
    if expires_at is not None:
        budget = min(budget, expires_at - time.time())
    deadline = time.monotonic() + budget
    key = lease or uuid4().hex
    network = {
        "allow_public_traffic": False,
        "deny_out": lambda network: [network.all_traffic],
        "allow_out": list(dict.fromkeys(hosts)),
    }
    for first_request in (True, False):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("E2B sandbox startup exceeded its deadline.")
        # The pinned SDK transport combines its read and write timeouts.
        timeout = min(12, remaining / 2) if first_request else remaining / 2
        try:
            sandbox = Sandbox.create(
                template, timeout=SANDBOX_TIMEOUT, request_timeout=timeout, idempotency_key=key,
                lifecycle={"on_timeout": "kill"}, network=network,
            )
            break
        except ReadTimeout:
            if not first_request:
                raise
    try:
        if sandbox.files.read(SOURCE_MARKER, request_timeout=5).strip() != digest:
            raise ValueError("Incompatible Shopify checkout template.")
    except Exception:
        close_sandbox(sandbox)
        raise
    return sandbox


def start_worker(sandbox, module, timeout):
    return sandbox.commands.run(
        WORKER_COMMAND + module, cwd="/opt/checkout", user="pwuser",
        envs=WORKER_ENV, background=True, stdin=True, timeout=timeout,
    )


def run_preview_worker(sandbox, payload, timeout):
    worker = start_worker(sandbox, "preview", timeout)
    worker.send_stdin(json.dumps(payload) + "\n", request_timeout=8)
    return json.loads(worker.wait().stdout)


def clean_preview(result, request):
    if not isinstance(result, dict):
        return {"status": "worker_unavailable"}
    status = result.get("status")
    if status == "preview_failed":
        return {"status": status}
    if result.get("merchant") != request.merchant:
        return {"status": "worker_unavailable"}
    base = {"status": status, "merchant": request.merchant}
    if status in ("navigation_failed", "manual_verification", "checkout_unavailable", "cart_mismatch"):
        return base
    if status == "preview_ready":
        item, total = result.get("item"), result.get("total")
        if (result.get("source") == "shopify_webmcp" and isinstance(result.get("checkout_status"), str)
                and isinstance(item, dict) and item.get("variant_id") == request.variant_id
                and type(item.get("quantity")) is int and item["quantity"] == request.quantity
                and (item.get("title") is None or isinstance(item["title"], str))
                and isinstance(total, dict) and type(total.get("minor_units")) is int and total["minor_units"] >= 0
                and isinstance(total.get("currency"), str) and re.fullmatch(r"[A-Z]{3}", total["currency"])):
            return {**base, "source": "shopify_webmcp", "checkout_status": result["checkout_status"],
                    "item": {"variant_id": request.variant_id, "quantity": request.quantity, "title": item.get("title")},
                    "total": {"currency": total["currency"], "minor_units": total["minor_units"]}}
    if status == "checkout_reached" and result.get("source") == "page":
        items, webmcp = result.get("items"), result.get("webmcp_status")
        if isinstance(items, list) and len(items) <= 21 and isinstance(webmcp, str):
            try:
                output = {**base, "source": "page", "webmcp_status": webmcp,
                          "items": [PreviewItem.model_validate(item).model_dump() for item in items]}
                if "total" in result:
                    output["total"] = PreviewDisplayTotal.model_validate(result["total"]).model_dump()
                return output
            except ValidationError:
                pass
    return {"status": "worker_unavailable"}


def clean_worker_result(result):
    if isinstance(result, dict):
        status = result.get("status")
        order_id = result.get("order_id")
        if status == "submitted" and isinstance(order_id, str) and ORDER_ID.fullmatch(order_id):
            return {"status": status, "order_id": order_id}
        if isinstance(status, str) and status in RESULTS:
            return {"status": status}
    return {"status": UNKNOWN}


def recover_result(sandbox):
    try:
        return clean_worker_result(json.loads(sandbox.files.read(RECEIPT_PATH, request_timeout=3)))
    except Exception:
        return None


def create_app(
    *,
    authorize: Callable[[UUID], CheckoutGrant | None],
    credentials: Callable[[UUID], dict],
    card: Callable[[UUID], dict],
    test_stores: dict[str, TestStore],
    bearer_token: str,
    database: Path,
    template: str,
    preview_stores: dict[str, PreviewStore] | None = None,
    order_webhooks: dict[str, tuple[str, str]] | None = None,
) -> FastAPI:
    """Connect the API to the purchase approval, profile, vault and Shopify receipt ports."""
    template_name, _, build_id = template.rpartition(":")
    if not template_name or not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", build_id):
        raise ValueError("Pin the E2B template by build UUID.")
    preview_stores = dict(preview_stores or {})
    test_stores = dict(test_stores)
    order_webhooks = dict(order_webhooks or {})
    if len(bearer_token) < 32 or not (test_stores or preview_stores):
        raise ValueError("Configure a service token and at least one checkout or preview store.")
    for host, store in list(test_stores.items()):
        checkout_host = store.checkout_host or host
        if (store.gateway not in TEST_CARDS or not all(map(is_hostname, (host, checkout_host, *store.network_hosts)))
                or test_stores.get(checkout_host, store) != store):
            raise ValueError("Provide exact trusted hostnames and a supported test gateway.")
        test_stores[checkout_host] = store
    for host, store in preview_stores.items():
        endpoint = urlsplit(store.permalink_endpoint)
        if (
            not all(map(is_hostname, (host, *store.network_hosts)))
            or endpoint.scheme != "https" or endpoint.netloc != host
            or endpoint.query or endpoint.fragment or not re.fullmatch(r"/[a-zA-Z0-9/_-]+", endpoint.path)
        ):
            raise ValueError("Provide the store's advertised HTTPS checkout permalink endpoint.")
    for shop, (checkout_host, secret) in order_webhooks.items():
        if not is_hostname(shop) or not shop.endswith(".myshopify.com") or checkout_host not in test_stores or not secret:
            raise ValueError("Configure a Shopify webhook shop, test checkout host and app client secret.")

    attempts = Attempts(database)
    digest = source_digest()
    providers = ThreadPoolExecutor(max_workers=8, thread_name_prefix="checkout-provider")

    @asynccontextmanager
    async def lifespan(_):
        yield
        providers.shutdown(wait=False, cancel_futures=True)

    def read_provider(callback, approval_id):
        future = providers.submit(callback, approval_id)
        try:
            return future.result(timeout=PROVIDER_TIMEOUT)
        finally:
            future.cancel()

    def load_profile(approval_id):
        contact = credentials(approval_id)
        payment = card(approval_id)
        return {
            "email": contact["email"],
            "delivery": {key: value for key, value in contact.get("delivery", {}).items() if key in ADDRESS_FIELDS},
            "billing": {key: value for key, value in contact.get("billing", {}).items()
                        if key in ADDRESS_FIELDS or key == "same_as_delivery"},
            "storefront_password": contact.get("storefront_password"),
            "payment": {key: value for key, value in payment.items() if key in CARD_FIELDS},
        }

    bearer = HTTPBearer(auto_error=False)

    def require_service(auth: HTTPAuthorizationCredentials | None = Depends(bearer)) -> None:
        if auth is None or not hmac.compare_digest(auth.credentials.encode(), bearer_token.encode()):
            raise HTTPException(status_code=401, detail="Service authentication required.")

    app = FastAPI(title="FluxA Shopify Checkout", lifespan=lifespan)

    @app.exception_handler(sqlite3.OperationalError)
    async def database_unavailable(_request, _error):
        return JSONResponse({"detail": "Checkout receipt storage is temporarily unavailable."}, status_code=503)

    @app.post("/catalog/search", dependencies=[Depends(require_service)])
    def catalog_search(request: CatalogSearchRequest) -> dict:
        try:
            return search_catalog(request)
        except TimeoutException:
            raise HTTPException(status_code=504, detail="Shopify catalog search timed out.") from None
        except (HTTPError, ValueError):
            raise HTTPException(status_code=502, detail="Shopify catalog search is unavailable.") from None

    def native_result(operation, request) -> JSONResponse:
        try:
            result = operation(request)
        except TimeoutException:
            raise HTTPException(status_code=504, detail="Shopify cart or quote request timed out.") from None
        except (HTTPError, ValueError):
            raise HTTPException(status_code=502, detail="Shopify did not return a usable cart or quote.") from None
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @app.post("/native/carts", dependencies=[Depends(require_service)])
    def native_cart(request: CreateCartRequest) -> JSONResponse:
        return native_result(create_cart, request)

    @app.post("/native/checkout-quotes", dependencies=[Depends(require_service)])
    def native_checkout_quote(request: CreateCheckoutQuoteRequest) -> JSONResponse:
        return native_result(create_checkout_quote, request)

    @app.post("/native/checkout-quotes/read", dependencies=[Depends(require_service)])
    def native_checkout_quote_read(request: ReadCheckoutQuoteRequest) -> JSONResponse:
        return native_result(get_checkout_quote, request)

    @app.post("/checkout-previews", dependencies=[Depends(require_service)])
    def preview(request: PreviewRequest) -> dict:
        store = preview_stores.get(request.merchant)
        if store is None:
            raise HTTPException(status_code=422, detail="This Shopify store is outside the configured preview scope.")
        try:
            sandbox = open_sandbox(template, digest, (request.merchant, *store.network_hosts))
        except Exception:
            return {"status": "browser_unavailable"}
        try:
            payload = {**request.model_dump(), "permalink_endpoint": store.permalink_endpoint}
            return clean_preview(run_preview_worker(sandbox, payload, WORKER_TIMEOUT), request)
        except Exception:
            return {"status": "worker_unavailable"}
        finally:
            close_sandbox(sandbox)

    def read_attempt(approval: str, response: Response) -> dict:
        row = attempts.get(approval)
        if row is None:
            raise HTTPException(status_code=404, detail="Checkout attempt not found.")
        result = json.loads(row["result"]) if row["result"] else None
        if result and result["status"] != UNKNOWN:
            return result
        if row["sandbox_id"]:
            try:
                sandbox = Sandbox.connect(row["sandbox_id"], request_timeout=3)
            except Exception:
                sandbox = None
            if sandbox:
                recovered = recover_result(sandbox)
                if recovered:
                    attempts.finish(approval, row["lease"], recovered)
                    close_sandbox(sandbox)
                    return json.loads(attempts.get(approval)["result"])
        if result:
            return result
        if time.time() < row["expires_at"]:
            response.status_code = 202
            return {"status": "processing"}
        return {"status": UNKNOWN if row["sandbox_id"] or row["lease"] is None else "browser_unavailable"}

    @app.get("/checkouts/{approval_id}", dependencies=[Depends(require_service)])
    def get_attempt(approval_id: UUID, response: Response) -> dict:
        return read_attempt(str(approval_id), response)

    @app.post("/checkouts/{approval_id}", dependencies=[Depends(require_service)])
    def checkout(approval_id: UUID, response: Response) -> dict:
        if not test_stores:
            raise HTTPException(status_code=403, detail="Test order submission is disabled.")
        approval = str(approval_id)
        reservation = attempts.reserve(approval)
        if reservation is None:
            return read_attempt(approval, response)
        lease, deadline = reservation

        def finish(result):
            attempts.finish(approval, lease, result)
            row = attempts.get(approval)
            if row and row["result"]:
                return json.loads(row["result"])
            response.status_code = 202
            return {"status": "processing"}

        try:
            grant = read_provider(authorize, approval_id)
        except Exception:
            attempts.abandon(approval, lease)
            raise HTTPException(status_code=503, detail="Purchase approval is unavailable.") from None
        if not grant or type(grant.expires_at) not in (int, float) or not time.time() < grant.expires_at < float("inf"):
            attempts.abandon(approval, lease)
            raise HTTPException(status_code=403, detail="A current purchase approval is required.")
        try:
            entry_host = checkout_entry_host(grant.checkout_url)
            validate_approval(grant)
        except (ValueError, TypeError, AttributeError):
            attempts.abandon(approval, lease)
            raise HTTPException(status_code=422, detail="The approved checkout URL, cart or total is invalid.") from None
        store = test_stores.get(entry_host)
        if store is None:
            attempts.abandon(approval, lease)
            raise HTTPException(status_code=422, detail="This Shopify test store is outside the configured scope.")
        grant = replace(grant, expires_at=min(grant.expires_at, deadline))
        try:
            profile = read_provider(load_profile, approval_id)
            if not uses_test_data(store.gateway, profile["email"], profile["payment"]["card_number"]):
                return finish({"status": "test_data_required"})
        except Exception:
            return finish({"status": "credentials_unavailable"})
        if time.time() >= grant.expires_at:
            return finish({"status": "approval_expired"})

        checkout_host = store.checkout_host or entry_host
        hosts = (entry_host, checkout_host, PCI_HOST, *store.network_hosts)
        try:
            sandbox = open_sandbox(template, digest, hosts, lease, expires_at=grant.expires_at)
        except Exception:
            return finish({"status": "browser_unavailable"})
        cleanup = True
        try:
            try:
                host, token = checkout_identity(grant.checkout_url)
            except ValueError:
                try:
                    route = run_preview_worker(sandbox, {
                        "checkout_url": grant.checkout_url, "checkout_host": checkout_host,
                        "storefront_password": profile["storefront_password"],
                    }, min(45, max(1, int(grant.expires_at - time.time()))))
                    if route.get("status") == "preview_failed":
                        return finish({"status": "browser_unavailable"})
                    if route.get("status") != "resolved":
                        status = "manual_verification" if route.get("status") == "manual_verification" else "checkout_unavailable"
                        return finish({"status": status})
                    grant = replace(grant, checkout_url=route["checkout_url"])
                    host, token = checkout_identity(grant.checkout_url)
                except Exception:
                    return finish({"status": "browser_unavailable"})
            if host != checkout_host:
                return finish({"status": "checkout_unavailable"})

            now = time.time()
            budget = min(WORKER_TIMEOUT, int(deadline - now - 5))
            if grant.expires_at <= now:
                return finish({"status": "approval_expired"})
            if budget <= RECEIPT_TIMEOUT + 5:
                return finish({"status": "browser_unavailable"})
            grant = replace(grant, expires_at=min(grant.expires_at, now + budget - RECEIPT_TIMEOUT - 5))
            try:
                payload = json.dumps({"grant": asdict(grant), "gateway": store.gateway, "profile": profile}, allow_nan=False) + "\n"
            except (TypeError, ValueError):
                return finish({"status": "credentials_unavailable"})
            if len(payload) > 64 * 1024:
                return finish({"status": "test_data_required"})

            try:
                worker = start_worker(sandbox, "worker", budget)
            except Exception:
                return finish({"status": "browser_unavailable"})

            binding = order_binding(host, grant.items, grant.total_minor_units, grant.currency)
            try:
                claimed = attempts.dispatch(approval, lease, checkout_digest(token), sandbox.sandbox_id,
                                            binding, grant.expires_at)
            except sqlite3.IntegrityError:
                attempts.abandon(approval, lease)
                raise HTTPException(status_code=409, detail="This Shopify checkout already has a submission attempt.") from None
            if not claimed:
                if time.time() >= grant.expires_at:
                    return finish({"status": "approval_expired"})
                attempts.abandon(approval, lease)
                raise HTTPException(status_code=409, detail="This approval no longer owns the checkout.")

            # The command can submit as soon as it receives stdin. Keep its sandbox
            # available unless the result reaches SQLite or its kill deadline expires.
            cleanup = False
            try:
                worker.send_stdin(payload, request_timeout=8)
                result = clean_worker_result(json.loads(worker.wait().stdout))
                received = True
            except Exception:
                result = recover_result(sandbox)
                received = result is not None
            outcome = finish(result or {"status": UNKNOWN})
            cleanup = received or outcome["status"] == "submitted"
            return outcome
        finally:
            if cleanup:
                close_sandbox(sandbox)

    @app.post("/webhooks/shopify/orders")
    async def shopify_order(request: Request):
        shop = request.headers.get("x-shopify-shop-domain")
        if shop not in order_webhooks or request.headers.get("x-shopify-topic") != "orders/create":
            raise HTTPException(status_code=404)
        host, secret = order_webhooks[shop]
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > WEBHOOK_MAX_BYTES:
                raise HTTPException(status_code=413)
            body.extend(chunk)
        raw = bytes(body)
        if not verify_signature(raw, request.headers.get("x-shopify-hmac-sha256", ""), secret):
            raise HTTPException(status_code=401)
        receipt = read_order_receipt(raw)
        if receipt:
            binding = order_binding(host, receipt.items, receipt.total_minor_units, receipt.currency)
            await run_in_threadpool(attempts.record_order, checkout_digest(receipt.checkout_token), binding, receipt.order_id)
        return Response(status_code=204)

    return app
