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


def address(data: dict, section: dict) -> dict:
    result = {field: data[name] for name, field in ADDRESS_FIELDS.items()}
    result["company"] = normalize_text(section.get("company"))
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


def shipping_groups(method: dict) -> dict:
    groups = {}
    for group in method.get("groups", []):
        identity = group["id"]
        if not isinstance(identity, str) or not identity or identity in groups:
            raise ValueError("Expected distinct Shopify shipping group IDs.")
        groups[identity] = group
    return groups


def approved_groups(method: dict, approved: dict) -> list[dict] | None:
    groups = shipping_groups(method)
    if groups.keys() != approved.keys():
        return None
    for identity, option in approved.items():
        current = groups[identity]
        available = current.get("options")
        option_id = option["selected_option_id"]
        if available is None:
            if current.get("selected_option_id") != option_id:
                return None
        elif not any(candidate.get("id") == option_id for candidate in available):
            return None
    return [{"id": identity, **option} for identity, option in approved.items()]


def shipping_matches(method: dict, approved: dict) -> bool:
    groups = shipping_groups(method)
    return groups.keys() == approved.keys() and all(
        groups[identity].get("selected_option_id") == option["selected_option_id"]
        and (groups[identity].get("selected_option_details") or {}) == option.get("selected_option_details", {})
        for identity, option in approved.items()
    )


def delivery_options(method: dict) -> dict:
    options = {}
    for group_id, group in shipping_groups(method).items():
        choices = []
        for option in group.get("options") or []:
            option_id = option.get("id")
            if not isinstance(option_id, str) or not option_id:
                raise ValueError("Expected a Shopify delivery option ID.")
            result = {"id": option_id}
            for field in ("title", "display_text"):
                label = option.get(field)
                if isinstance(label, str) and label.strip():
                    result[field] = " ".join(label.split())[:250]
            prices = [row.get("amount") for row in option.get("totals", []) if row.get("type") == "total"]
            if len(prices) == 1 and type(prices[0]) is int:
                result["amount"] = prices[0]
            choices.append(result)
        if len({choice["id"] for choice in choices}) != len(choices):
            raise ValueError("Expected distinct Shopify delivery option IDs.")
        selected = group.get("selected_option_id")
        if group.get("options") is None and isinstance(selected, str) and selected:
            choices = [{"id": selected}]
        options[group_id] = choices
    return options


def select_shipping(method: dict, requested: dict | None, options: dict) -> dict | None:
    groups = shipping_groups(method)
    if method and not groups:
        return None
    if requested is not None:
        return requested if approved_groups(method, requested) is not None else None
    selected = {}
    for group_id, group in groups.items():
        choice = group.get("selected_option_id")
        available = [option["id"] for option in options[group_id]]
        if available and choice not in available:
            choice = available[0] if len(available) == 1 else None
        if not isinstance(choice, str) or not choice:
            return None
        selected[group_id] = {"selected_option_id": choice}
        if choice == group.get("selected_option_id") and group.get("selected_option_details"):
            selected[group_id]["selected_option_details"] = group["selected_option_details"]
    return selected if approved_groups(method, selected) is not None else None


@dataclass(frozen=True, repr=False)
class Guest:
    email: str
    delivery: dict
    billing: dict
    same_as_delivery: bool

    @classmethod
    def from_profile(cls, profile: dict, data: dict):
        delivery = address(data["delivery"], profile["delivery"]) if profile.get("delivery") else {}
        same = data["billing_same_as_delivery"]
        billing = delivery if same else address(data["billing"], profile.get("billing") or {})
        return cls(data["email"], delivery, billing, same)

    def update(self, state: dict, groups: list[dict] | None) -> dict:
        update = {"buyer": {"email": self.email}}
        if self.delivery:
            method = {"type": "shipping", "destinations": [self.delivery]}
            if groups is not None:
                method["groups"] = groups
            update["fulfillment"] = {"methods": [method]}
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

    def contact_matches(self, state: dict, method: dict) -> bool:
        if state.get("buyer", {}).get("email", "").casefold() != self.email.casefold():
            return False
        destinations = method.get("destinations", [])
        if self.delivery and (len(destinations) != 1 or not address_matches(destinations[0], self.delivery)):
            return False
        return bool(self.delivery) == bool(method)

    def matches(self, state: dict, method: dict) -> bool:
        if not self.contact_matches(state, method):
            return False
        instruments = state.get("payment", {}).get("instruments", [])
        if len(instruments) != 1 or not address_matches(instruments[0].get("billing_address"), self.billing):
            return False
        return all(field.get("value") is False for field in state.get("declared_fields", [])
                   if field.get("key") == "shop_pay_sign_up")
