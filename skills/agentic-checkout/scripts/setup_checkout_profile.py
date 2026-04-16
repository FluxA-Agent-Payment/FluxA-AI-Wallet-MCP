#!/usr/bin/env python3
"""Interactive setup flow for checkout payment, delivery, and billing profiles."""

from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path
from typing import Any

try:  # pragma: no cover - interactive helper only
    from shopify.runtime import _normalize_profile_section as normalize_profile_section_for_setup
except Exception:  # pragma: no cover
    normalize_profile_section_for_setup = None


DEFAULT_OUTPUT = Path.home() / ".clawdbot" / "credentials" / "real_card.json"


def normalize_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def prompt_text(label: str, default: str | None = None, required: bool = False, secret: bool = False) -> str:
    suffix = f" [{default}]" if default else ""
    prompt = f"{label}{suffix}: "
    while True:
        raw = getpass.getpass(prompt) if secret else input(prompt)
        value = normalize_text(raw) if raw else normalize_text(default)
        if value or not required:
            return value
        print(f"{label} is required.", flush=True)


def prompt_bool(label: str, default: bool = True) -> bool:
    suffix = "Y/n" if default else "y/N"
    while True:
        raw = normalize_text(input(f"{label} [{suffix}]: ")).lower()
        if not raw:
            return default
        if raw in {"y", "yes"}:
            return True
        if raw in {"n", "no"}:
            return False
        print("Please answer yes or no.", flush=True)


def split_full_name(value: str) -> tuple[str, str]:
    parts = normalize_text(value).split(" ", 1)
    if not parts or not parts[0]:
        return "", ""
    if len(parts) == 1:
        return parts[0], parts[0]
    return parts[0], parts[1]


def collect_address_block(label: str, default_country: str) -> dict[str, str]:
    print(f"\n{label}", flush=True)
    full_name = prompt_text("Full name", required=True)
    first_name, last_name = split_full_name(full_name)
    address1 = prompt_text("Address line 1", required=True)
    address2 = prompt_text("Address line 2")
    city = prompt_text("City", required=True)
    state = prompt_text("State / Province", required=True)
    country = prompt_text("Country", default=default_country, required=True)
    phone = prompt_text("Phone", required=True)
    ascii_defaults: dict[str, str] = {}
    postal_default = ""
    if normalize_profile_section_for_setup is not None:
        inferred = normalize_profile_section_for_setup(
            {
                "name": full_name,
                "address1": address1,
                "address2": address2,
                "city": city,
                "state": state,
                "country": country,
                "phone": phone,
            },
            default_country=country,
        )
        ascii_defaults = inferred
        postal_default = inferred.get("postal", "")
    address1_ascii_default = ascii_defaults.get("address1_ascii") or (address1 if address1.isascii() else "")
    address1_ascii = prompt_text("Address line 1 (English / Latin fallback)", default=address1_ascii_default)
    city_ascii_default = ascii_defaults.get("city_ascii") or (city if city.isascii() else "")
    city_ascii = prompt_text("City (English / Latin fallback)", default=city_ascii_default)
    state_ascii_default = ascii_defaults.get("state_ascii") or (state if state.isascii() else "")
    state_ascii = prompt_text("State / Province (English / Latin fallback)", default=state_ascii_default)
    postal = prompt_text("ZIP / Postal code", default=postal_default, required=True)
    return {
        "name": full_name,
        "first_name": first_name,
        "last_name": last_name,
        "address1": address1,
        "address1_ascii": address1_ascii,
        "address2": address2,
        "city": city,
        "city_ascii": city_ascii,
        "state": state,
        "state_ascii": state_ascii,
        "postal": postal,
        "country": country,
        "phone": phone,
    }


def build_profile(output_path: Path, default_country: str) -> dict[str, Any]:
    print("Checkout profile setup", flush=True)
    print(f"Output file: {output_path}", flush=True)

    email = prompt_text("Checkout email", required=True)
    delivery = collect_address_block("Delivery profile", default_country)
    same_billing = prompt_bool("Use the same address for billing", default=True)
    billing = delivery.copy() if same_billing else collect_address_block("Billing profile", default_country)
    billing["same_as_delivery"] = same_billing

    print("\nPayment card", flush=True)
    cardholder_default = billing.get("name") or delivery.get("name")
    cardholder_name = prompt_text("Name on card", default=cardholder_default, required=True)
    card_number = prompt_text("Card number", required=True, secret=True)
    exp = prompt_text("Expiry (MM/YY or MM/YYYY)", required=True, secret=True)
    cvc = prompt_text("CVC", required=True, secret=True)
    card_postal = prompt_text("Card postal code", default=billing.get("postal"), required=True)
    card_country = prompt_text("Card country", default=billing.get("country") or default_country, required=True)
    resident_id_number = prompt_text("Resident ID number (optional)")

    profile = {
        "email": email,
        "payment": {
            "email": email,
            "card_number": card_number,
            "exp": exp,
            "cvc": cvc,
            "postal": card_postal,
            "country": card_country,
            "name": cardholder_name,
        },
        "delivery": delivery,
        "billing": billing,
    }
    if resident_id_number:
        profile["additional_information"] = {"resident_id_number": resident_id_number}
    return profile


def write_profile(path: Path, profile: dict[str, Any], overwrite: bool) -> None:
    if path.exists() and not overwrite:
        raise FileExistsError(f"Refusing to overwrite existing file without --overwrite: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Collect payment, delivery, and billing details into one checkout profile JSON.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--country", default="United States", help="Default country for delivery, billing, and card prompts.")
    parser.add_argument("--overwrite", action="store_true")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    output_path = Path(os.path.expanduser(os.path.expandvars(str(args.output))))
    try:
        profile = build_profile(output_path, default_country=str(args.country))
        write_profile(output_path, profile, overwrite=bool(args.overwrite))
    except FileExistsError as exc:
        parser.error(str(exc))
    except KeyboardInterrupt:
        print("\nSetup cancelled.", flush=True)
        return 130

    print(f"\nSaved checkout profile to {output_path}", flush=True)
    print("Use this file as --secrets-path for preview or execute.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
