"""Update and verify the authorized guest details with Shopify Checkout WebMCP."""

import re
from dataclasses import dataclass
from unicodedata import normalize

from shopify.security import normalize_text

ADDRESS_FIELDS = {
    "first_name": "first_name", "last_name": "last_name", "address1": "street_address",
    "address2": "extended_address", "city": "address_locality", "state": "address_region",
    "postal": "postal_code", "country": "address_country", "phone": "phone_number",
}


def address(data: dict, section: str, profile: dict) -> dict:
    result = {field: data[f"{section}_{name}"] for name, field in ADDRESS_FIELDS.items()}
    result["company"] = normalize_text(profile.get(section, {}).get("company"))
    if not re.fullmatch(r"[A-Z]{2}", result["address_country"]):
        raise ValueError("Use the two-letter country code for a checkout address.")
    phone = result["phone_number"]
    if phone and not re.fullmatch(r"\+[1-9][0-9]{6,14}", phone):
        raise ValueError("Use an E.164 phone number for a checkout address.")
    return result


def address_value(field: str, value: str) -> str:
    text = normalize("NFC", normalize_text(value)).casefold()
    if field == "postal_code":
        return text.replace(" ", "").replace("-", "")
    if field == "phone_number":
        return re.sub(r"[ ().-]", "", text)
    return text


def address_matches(actual: dict, approved: dict) -> bool:
    return isinstance(actual, dict) and all(
        address_value(field, actual.get(field)) == address_value(field, value)
        for field, value in approved.items()
        # Shopify can derive an omitted region from the supplied address.
        if field != "address_region" or value
    )


def shipping_method(state: dict) -> dict:
    methods = state.get("fulfillment", {}).get("methods", [])
    if not methods:
        return {}
    if len(methods) != 1 or methods[0].get("type") != "shipping":
        raise ValueError("Expected one Shopify shipping method.")
    return methods[0]


def selected_groups(method: dict) -> dict:
    return {
        group["id"]: {key: group[key] for key in ("id", "selected_option_id", "selected_option_details") if key in group}
        for group in method.get("groups", []) if group.get("selected_option_id")
    }


@dataclass(frozen=True, repr=False)
class Guest:
    email: str
    delivery: dict
    billing: dict
    same_as_delivery: bool

    @classmethod
    def from_profile(cls, profile: dict, data: dict):
        delivery = address(data, "delivery", profile) if profile.get("delivery") else {}
        same = data["billing_same_as_delivery"] == "true"
        return cls(data["guest_email"], delivery, delivery if same else address(data, "billing", profile), same)

    def update(self, state: dict, method: dict) -> dict:
        if bool(method) != bool(self.delivery):
            raise ValueError("The approved delivery does not match the checkout.")
        update = {"buyer": {"email": self.email}}
        if self.delivery:
            update["fulfillment"] = {"methods": [{
                "type": "shipping", "destinations": [self.delivery],
                "groups": list(selected_groups(method).values()),
            }]}
        if not self.same_as_delivery:
            update["payment"] = {"instruments": [{"billing_address": self.billing}]}
        discounts = state.get("discounts", {}).get("codes")
        if discounts is not None:
            update["discounts"] = {"codes": discounts}
        declared = [
            {"key": field["key"], "value": False if field["key"] == "shop_pay_sign_up" else field["value"]}
            for field in state.get("declared_fields", []) if field.get("value") is not None
        ]
        if declared:
            update["declared_fields"] = declared
        return update

    def matches(self, state: dict, method: dict) -> bool:
        if state.get("buyer", {}).get("email", "").casefold() != self.email.casefold():
            return False
        destinations = method.get("destinations", [])
        if self.delivery and (len(destinations) != 1 or not address_matches(destinations[0], self.delivery)):
            return False
        if not self.delivery and method:
            return False
        instruments = state.get("payment", {}).get("instruments", [])
        if len(instruments) != 1 or not address_matches(instruments[0].get("billing_address"), self.billing):
            return False
        return all(field.get("value") is False for field in state.get("declared_fields", [])
                   if field.get("key") == "shop_pay_sign_up")
