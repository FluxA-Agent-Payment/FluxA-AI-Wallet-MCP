"""Internal HTTP API and E2B dispatch for authorized Shopify test purchases."""

import hashlib
import hmac
import json
import re
import sqlite3
import time
from contextlib import closing
from dataclasses import asdict, replace
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit
from uuid import UUID

from e2b import Sandbox
from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field

from .contract import (
    ATTEMPT_TIMEOUT, ORDER_ID, PCI_HOST, SANDBOX_TIMEOUT, TEST_CARDS, WORKER_TIMEOUT,
    CheckoutGrant, PreviewStore, TestStore, checkout_identity, is_hostname, uses_test_data, validate_approval,
)
from .template import WORKER_ENV

WORKER_COMMAND = "/usr/bin/python3 -m checkout_service."
RESULTS = frozenset({
    "submitted", "test_data_required", "approval_expired", "manual_verification",
    "unsupported_checkout", "identity_incomplete", "total_mismatch", "payment_fields_incomplete",
    "checkout_unavailable", "checkout_not_ready", "cart_mismatch", "payment_method_unavailable",
    "payment_failed", "reconciliation_required",
})
ADDRESS_FIELDS = ("name", "first_name", "last_name", "company", "address1", "address2", "city", "state", "postal", "country", "phone")
CARD_FIELDS = ("card_number", "exp", "cvc", "name", "postal", "country")


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    merchant: str = Field(max_length=253)
    variant_id: str = Field(pattern=r"^[1-9][0-9]{0,19}$")
    quantity: int = Field(default=1, ge=1, le=100)
    country: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")


def run_browser_worker(
    template: str, module: str, network_hosts: tuple[str, ...], payload: str, *, attempt: str | None = None,
) -> dict:
    try:
        sandbox = Sandbox.create(
            template, timeout=SANDBOX_TIMEOUT, request_timeout=12, idempotency_key=attempt,
            lifecycle={"on_timeout": "kill"},
            network={
                "allow_public_traffic": False,
                "deny_out": lambda network: [network.all_traffic],
                "allow_out": list(dict.fromkeys(network_hosts)),
            },
        )
    except Exception:
        return {"status": "browser_unavailable"}
    try:
        worker = sandbox.commands.run(
            WORKER_COMMAND + module, cwd="/opt/checkout", user="pwuser",
            envs=WORKER_ENV, background=True, stdin=True, timeout=WORKER_TIMEOUT,
        )
        worker.send_stdin(payload, request_timeout=8)
        result = json.loads(worker.wait().stdout)
        if isinstance(result, dict):
            return result
        return {"status": "worker_unavailable"}
    except Exception:
        return {"status": "worker_unavailable"}
    finally:
        try:
            sandbox.kill(request_timeout=5)
        except Exception:
            # Explicit kill on timeout remains active if the control request fails.
            pass


def run_in_e2b(template: str, host: str, store: TestStore, grant: CheckoutGrant, profile: dict, attempt: str) -> dict:
    if not uses_test_data(store.gateway, profile["email"], profile["payment"]["card_number"]):
        return {"status": "test_data_required"}
    payload = json.dumps({"grant": asdict(grant), "gateway": store.gateway, "profile": profile}) + "\n"
    if len(payload) > 64 * 1024:
        return {"status": "test_data_required"}
    result = run_browser_worker(template, "worker", (host, PCI_HOST, *store.network_hosts), payload, attempt=attempt)
    status = result.get("status")
    if status == "submitted":
        order_id = result.get("order_id")
        if isinstance(order_id, str) and ORDER_ID.fullmatch(order_id):
            return {"status": status, "order_id": order_id}
    elif isinstance(status, str) and (status in RESULTS or status == "browser_unavailable"):
        return {"status": status}
    return {"status": "reconciliation_required"}


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
) -> FastAPI:
    """Connect the API to the purchase approval, customer profile and card vault ports."""
    template_name, _, build_id = template.rpartition(":")
    if not template_name or not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", build_id):
        raise ValueError("Pin the E2B template by build UUID.")
    preview_stores = dict(preview_stores or {})
    if len(bearer_token) < 32 or not (test_stores or preview_stores):
        raise ValueError("Configure a service token and at least one checkout or preview store.")
    for host, store in test_stores.items():
        domains = (host, *store.network_hosts)
        if store.gateway not in TEST_CARDS or not all(map(is_hostname, domains)):
            raise ValueError("Provide exact trusted hostnames and a supported test gateway.")
    for host, preview_store in preview_stores.items():
        endpoint = urlsplit(preview_store.permalink_endpoint)
        if (
            not all(map(is_hostname, (host, *preview_store.network_hosts)))
            or endpoint.scheme != "https" or endpoint.netloc != host
            or endpoint.query or endpoint.fragment or not re.fullmatch(r"/[a-zA-Z0-9/_-]+", endpoint.path)
        ):
            raise ValueError("Provide the store's advertised HTTPS checkout permalink endpoint.")

    def connect() -> sqlite3.Connection:
        return sqlite3.connect(database, timeout=5)

    with closing(connect()) as db, db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS attempts (
                approval_id TEXT PRIMARY KEY, checkout_digest TEXT NOT NULL UNIQUE,
                expires_at REAL NOT NULL, result TEXT
            )"""
        )

    bearer = HTTPBearer(auto_error=False)

    def require_service(auth: HTTPAuthorizationCredentials | None = Depends(bearer)) -> None:
        if auth is None or not hmac.compare_digest(auth.credentials.encode(), bearer_token.encode()):
            raise HTTPException(status_code=401, detail="Service authentication required.")

    app = FastAPI(title="FluxA Shopify Checkout")

    @app.post("/checkout-previews", dependencies=[Depends(require_service)])
    def preview(request: PreviewRequest) -> dict:
        store = preview_stores.get(request.merchant)
        if store is None:
            raise HTTPException(status_code=422, detail="This Shopify store is outside the configured preview scope.")
        payload = json.dumps({**request.model_dump(), "permalink_endpoint": store.permalink_endpoint}) + "\n"
        result = run_browser_worker(template, "preview", (request.merchant, *store.network_hosts), payload)
        if result.get("status") == "preview_ready":
            item, total = result.get("item"), result.get("total")
            if (
                result.get("merchant") != request.merchant or result.get("source") != "shopify_webmcp"
                or not isinstance(item, dict) or item.get("variant_id") != request.variant_id
                or type(item.get("quantity")) is not int or item["quantity"] != request.quantity
                or not isinstance(total, dict) or type(total.get("minor_units")) is not int or total["minor_units"] < 0
                or not isinstance(total.get("currency"), str) or not re.fullmatch(r"[A-Z]{3}", total["currency"])
            ):
                return {"status": "worker_unavailable"}
        return result

    def read_attempt(approval_id: UUID) -> tuple | None:
        with closing(connect()) as db:
            return db.execute(
                "SELECT expires_at, result FROM attempts WHERE approval_id = ?", (str(approval_id),)
            ).fetchone()

    @app.get("/checkouts/{approval_id}", dependencies=[Depends(require_service)])
    def get_attempt(approval_id: UUID, response: Response) -> dict:
        row = read_attempt(approval_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Checkout attempt not found.")
        return attempt_response(row, response)

    @app.post("/checkouts/{approval_id}", dependencies=[Depends(require_service)])
    def checkout(approval_id: UUID, response: Response) -> dict:
        if not test_stores:
            raise HTTPException(status_code=403, detail="Test order submission is disabled.")
        approval_key = str(approval_id)
        row = read_attempt(approval_id)
        if row:
            return attempt_response(row, response)

        try:
            grant = authorize(approval_id)
        except Exception:
            raise HTTPException(status_code=503, detail="Purchase approval is unavailable.") from None
        if not grant or not time.time() < grant.expires_at < float("inf"):
            raise HTTPException(status_code=403, detail="A current purchase approval is required.")
        try:
            host, token = checkout_identity(grant.checkout_url)
            validate_approval(grant)
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(status_code=422, detail="The approved checkout URL, cart or total is invalid.") from None
        store = test_stores.get(host)
        if store is None:
            raise HTTPException(status_code=422, detail="This Shopify test store is outside the configured scope.")

        # Claim the approval and the Shopify checkout token in the same insert.
        digest = hashlib.sha256(token.encode()).hexdigest()
        deadline = time.time() + ATTEMPT_TIMEOUT
        with closing(connect()) as db, db:
            claimed = db.execute(
                "INSERT OR IGNORE INTO attempts VALUES (?, ?, ?, NULL)",
                (approval_key, digest, deadline),
            ).rowcount
        if not claimed:
            row = read_attempt(approval_id)
            if row:
                return attempt_response(row, response)
            raise HTTPException(status_code=409, detail="This Shopify checkout already has a submission attempt.")

        try:
            contact = credentials(approval_id)
            payment = card(approval_id)
            profile = {
                "email": contact["email"],
                "delivery": {key: value for key, value in contact.get("delivery", {}).items() if key in ADDRESS_FIELDS},
                "billing": {
                    key: value for key, value in contact.get("billing", {}).items()
                    if key in ADDRESS_FIELDS or key == "same_as_delivery"
                },
                "storefront_password": contact.get("storefront_password"),
                "payment": {key: value for key, value in payment.items() if key in CARD_FIELDS},
            }
        except Exception:
            result = {"status": "credentials_unavailable"}
        else:
            try:
                grant = replace(grant, expires_at=min(grant.expires_at, deadline))
                result = (
                    run_in_e2b(template, host, store, grant, profile, approval_key)
                    if time.time() < grant.expires_at else {"status": "approval_expired"}
                )
            except (KeyError, TypeError, AttributeError):
                result = {"status": "credentials_unavailable"}
        with closing(connect()) as db, db:
            db.execute("UPDATE attempts SET result = ? WHERE approval_id = ?", (json.dumps(result), approval_key))
        return result

    return app


def attempt_response(row: tuple, response: Response) -> dict:
    expires_at, result = row
    if result:
        return json.loads(result)
    if time.time() < expires_at:
        response.status_code = 202
        return {"status": "processing"}
    return {"status": "reconciliation_required"}
