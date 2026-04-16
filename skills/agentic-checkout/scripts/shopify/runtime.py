#!/usr/bin/env python3
"""Runtime helpers shared by Shopify automation scripts."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any
import json
import os
import re

try:  # pragma: no cover - optional dependency in some local environments
    from pypinyin import lazy_pinyin
except Exception:  # pragma: no cover
    lazy_pinyin = None


def parse_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def get_env(name: str, default: Any = None) -> Any:
    value = os.getenv(name)
    return value if value not in (None, "") else default


def resolve_path(value: Any) -> Path:
    expanded = os.path.expandvars(os.path.expanduser(str(value or "")))
    return Path(expanded)


def json_dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _canonical_label(value: Any) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", normalize_text(value).lower())


def _first_non_empty(*values: Any) -> Any:
    for value in values:
        if value not in (None, ""):
            return value
    return None


def _split_full_name(value: Any) -> tuple[str, str]:
    parts = normalize_text(value).split(" ", 1)
    if not parts or not parts[0]:
        return "", ""
    if len(parts) == 1:
        return parts[0], parts[0]
    return parts[0], parts[1]


PHONE_PATTERN = re.compile(r"^\+?(?:\d[\d\s().-]{6,}\d|\d{7,})$")
INLINE_PHONE_PATTERN = re.compile(
    r"(?:电话(?:号码)?|手机号?|手机|phone|mobile|tel|telephone)\s*[：: ]\s*(\+?(?:\d[\d\s().-]{6,}\d|\d{7,}))",
    re.IGNORECASE,
)
POSTAL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9\s-]{2,11}$")
ADDRESS_HINT_PATTERN = re.compile(
    r"(?:\d|street|st\b|road|rd\b|ave\b|avenue|boulevard|blvd|drive|dr\b|lane|ln\b|building|center|centre|district|"
    r"路|街|号|楼|室|苑|大厦|中心|区|镇|乡)",
    re.IGNORECASE,
)
CHINA_PATTERN = re.compile(r"中国|china|cn", re.IGNORECASE)
CHINA_STATE_PATTERN = re.compile(r"(北京市|上海市|天津市|重庆市|[^省市]{2,12}省|[^区]{2,12}自治区|[^区]{2,12}特别行政区)")
CHINA_CITY_PATTERN = re.compile(r"(.{2,12}?(?:市|州|盟|地区))")
CHINA_DISTRICT_PATTERN = re.compile(r"(.{2,16}?(?:区|县|旗|镇|乡|街道|村))")
CJK_PATTERN = re.compile(r"[\u4e00-\u9fff]+")

CHINA_REGION_ASCII: dict[str, str] = {
    "北京市": "Beijing",
    "天津市": "Tianjin",
    "上海市": "Shanghai",
    "重庆市": "Chongqing",
    "河北省": "Hebei",
    "山西省": "Shanxi",
    "辽宁省": "Liaoning",
    "吉林省": "Jilin",
    "黑龙江省": "Heilongjiang",
    "江苏省": "Jiangsu",
    "浙江省": "Zhejiang",
    "安徽省": "Anhui",
    "福建省": "Fujian",
    "江西省": "Jiangxi",
    "山东省": "Shandong",
    "河南省": "Henan",
    "湖北省": "Hubei",
    "湖南省": "Hunan",
    "广东省": "Guangdong",
    "海南省": "Hainan",
    "四川省": "Sichuan",
    "贵州省": "Guizhou",
    "云南省": "Yunnan",
    "陕西省": "Shaanxi",
    "甘肃省": "Gansu",
    "青海省": "Qinghai",
    "台湾省": "Taiwan",
    "内蒙古自治区": "Inner Mongolia",
    "广西壮族自治区": "Guangxi",
    "西藏自治区": "Tibet",
    "宁夏回族自治区": "Ningxia",
    "新疆维吾尔自治区": "Xinjiang",
    "香港特别行政区": "Hong Kong",
    "澳门特别行政区": "Macau",
    "杭州市": "Hangzhou",
    "西湖区": "Xihu District",
    "黄龙国际中心": "Huanglong International Center",
    "浙数科技": "Zheshu Keji",
}

CHINA_GENERAL_POSTAL_BY_REGION: dict[str, str] = {
    "北京市": "100000",
    "天津市": "300000",
    "上海市": "200000",
    "重庆市": "400000",
    "河北省": "050000",
    "山西省": "030000",
    "辽宁省": "110000",
    "吉林省": "130000",
    "黑龙江省": "150000",
    "江苏省": "210000",
    "浙江省": "310000",
    "安徽省": "230000",
    "福建省": "350000",
    "江西省": "330000",
    "山东省": "250000",
    "河南省": "450000",
    "湖北省": "430000",
    "湖南省": "410000",
    "广东省": "510000",
    "海南省": "570000",
    "四川省": "610000",
    "贵州省": "550000",
    "云南省": "650000",
    "陕西省": "710000",
    "甘肃省": "730000",
    "青海省": "810000",
    "台湾省": "100000",
    "内蒙古自治区": "010000",
    "广西壮族自治区": "530000",
    "西藏自治区": "850000",
    "宁夏回族自治区": "750000",
    "新疆维吾尔自治区": "830000",
    "香港特别行政区": "999077",
    "澳门特别行政区": "999078",
}

CHINA_REGION_SUFFIX_ASCII: tuple[tuple[str, str], ...] = (
    ("特别行政区", " SAR"),
    ("自治区", " Autonomous Region"),
    ("自治州", " Prefecture"),
    ("街道", " Subdistrict"),
    ("地区", " Prefecture"),
    ("省", ""),
    ("市", ""),
    ("盟", " League"),
    ("区", " District"),
    ("县", " County"),
    ("旗", " Banner"),
    ("镇", " Town"),
    ("乡", " Township"),
    ("村", " Village"),
)

CHINA_ADDRESS_PHRASE_ASCII: tuple[tuple[str, str], ...] = (
    ("国际中心", " International Center "),
    ("国际广场", " International Plaza "),
    ("国际大厦", " International Tower "),
    ("科技园", " Tech Park "),
    ("工业园", " Industrial Park "),
    ("中心", " Center "),
    ("广场", " Plaza "),
    ("大厦", " Tower "),
    ("园区", " Park "),
    ("花园", " Garden "),
    ("小区", " Residential Compound "),
    ("科技", " Keji "),
    ("大楼", " Building "),
    ("号楼", " Building "),
    ("单元", " Unit "),
    ("室", " Room "),
    ("层", " Floor "),
    ("楼", " Floor "),
    ("路", " Road "),
    ("街", " Street "),
    ("道", " Road "),
    ("巷", " Lane "),
    ("弄", " Lane "),
    ("号", " No. "),
)

SECTION_KEY_ALIASES: dict[str, tuple[str, ...]] = {
    "name": ("name", "full_name", "recipient_name", "recipient", "receiver", "consignee", "contact_name"),
    "first_name": ("first_name", "given_name", "firstname"),
    "last_name": ("last_name", "family_name", "lastname", "surname"),
    "address1": ("address1", "line1", "street", "street1"),
    "address2": ("address2", "line2", "apartment", "suite", "unit"),
    "city": ("city", "city_name", "town", "municipality"),
    "state": ("state", "province", "region", "province_name", "state_name"),
    "postal": ("postal", "postal_code", "zip", "zipcode", "zip_code"),
    "country": ("country", "country_name"),
    "phone": ("phone", "phone_number", "mobile", "mobile_number", "tel", "telephone"),
}

SECTION_BLOB_ALIASES: dict[str, tuple[str, ...]] = {
    "address1": ("address", "full_address", "shipping_address", "delivery_address", "street_address", "raw_address"),
}

LABEL_ALIASES: dict[str, tuple[str, ...]] = {
    "name": ("name", "full name", "recipient", "recipient name", "receiver", "consignee", "contact name", "收件人", "姓名", "联系人"),
    "address1": ("address", "address line 1", "line1", "street", "shipping address", "delivery address", "收货地址", "地址", "详细地址"),
    "address2": ("address line 2", "line2", "apartment", "suite", "unit", "地址2", "楼层", "单元"),
    "city": ("city", "city name", "town", "城市", "市"),
    "state": ("state", "province", "region", "省份", "省", "州", "地区"),
    "postal": ("postal", "postal code", "zip", "zip code", "postcode", "邮编", "邮政编码"),
    "country": ("country", "国家"),
    "phone": ("phone", "mobile", "telephone", "tel", "电话号码", "手机号", "手机", "电话"),
}

LABEL_ALIAS_TOKENS = {
    field: {_canonical_label(alias) for alias in aliases}
    for field, aliases in LABEL_ALIASES.items()
}


def _looks_like_phone(value: Any) -> bool:
    text = normalize_text(value)
    if not text:
        return False
    return bool(PHONE_PATTERN.fullmatch(text))


def _normalize_phone(value: Any) -> str:
    text = normalize_text(value)
    if not text:
        return ""
    prefix = "+" if text.startswith("+") else ""
    digits = re.sub(r"\D", "", text)
    if len(digits) < 7:
        return text
    return f"{prefix}{digits}" if prefix else digits


def _looks_like_postal(value: Any) -> bool:
    text = normalize_text(value)
    if not text:
        return False
    digits = re.sub(r"\D", "", text)
    if digits and len(digits) > 8:
        return False
    return bool(POSTAL_PATTERN.fullmatch(text))


def _looks_like_address_line(value: Any) -> bool:
    text = normalize_text(value)
    if not text or len(text) < 6:
        return False
    return bool(ADDRESS_HINT_PATTERN.search(text))


def _match_labeled_field(label: Any) -> str | None:
    token = _canonical_label(label)
    if not token:
        return None
    for field, aliases in LABEL_ALIAS_TOKENS.items():
        if token in aliases:
            return field
    return None


def _extract_labeled_values(section: dict[str, Any]) -> dict[str, str]:
    extracted: dict[str, str] = {}
    for raw_value in section.values():
        if not isinstance(raw_value, str):
            continue
        for piece in re.split(r"[\r\n]+", raw_value):
            line = normalize_text(piece)
            if not line:
                continue
            if ":" in line or "：" in line:
                label, content = re.split(r"\s*[：:]\s*", line, maxsplit=1)
                field = _match_labeled_field(label)
                if field and content and field not in extracted:
                    extracted[field] = normalize_text(content)
                continue
            phone_match = re.match(
                r"^(电话(?:号码)?|手机号?|手机|phone|mobile|tel|telephone)\s+(.+)$",
                line,
                flags=re.IGNORECASE,
            )
            if phone_match and "phone" not in extracted:
                extracted["phone"] = normalize_text(phone_match.group(2))
    return extracted


def _first_section_value(section: dict[str, Any], aliases: tuple[str, ...], labeled: dict[str, str] | None = None, labeled_key: str | None = None) -> str:
    for key in aliases:
        value = normalize_text(section.get(key))
        if value:
            return value
    if labeled and labeled_key:
        return normalize_text(labeled.get(labeled_key))
    return ""


def _extract_china_state_city(address_text: str) -> tuple[str, str]:
    text = normalize_text(address_text)
    if not text:
        return "", ""
    state_match = CHINA_STATE_PATTERN.search(text)
    state = normalize_text(state_match.group(1)) if state_match else ""
    tail = text[state_match.end() :] if state_match else text
    city_match = CHINA_CITY_PATTERN.search(tail)
    city = normalize_text(city_match.group(1)) if city_match else ""
    return state, city


def _contains_cjk(value: Any) -> bool:
    return bool(CJK_PATTERN.search(str(value or "")))


def _romanize_cjk_token(value: str, *, spaced: bool) -> str:
    text = normalize_text(value)
    if not text:
        return ""
    direct = CHINA_REGION_ASCII.get(text)
    if direct:
        return direct
    if lazy_pinyin is not None:
        pieces = [piece for piece in lazy_pinyin(text, errors="ignore") if piece]
        if not pieces:
            return ""
        normalized = [piece.capitalize() for piece in pieces]
        return " ".join(normalized) if spaced else "".join(normalized)
    return ""


def _romanize_region_name(value: Any) -> str:
    text = normalize_text(value)
    if not text:
        return ""
    direct = CHINA_REGION_ASCII.get(text)
    if direct:
        return direct
    for suffix, english_suffix in CHINA_REGION_SUFFIX_ASCII:
        if text.endswith(suffix) and len(text) > len(suffix):
            core = text[: -len(suffix)]
            core_ascii = _romanize_cjk_token(core, spaced=False) or _romanize_cjk_token(core, spaced=True)
            return normalize_text(f"{core_ascii}{english_suffix}")
    return _romanize_cjk_token(text, spaced=False) or _romanize_cjk_token(text, spaced=True)


def _romanize_address_line(value: Any, state: str = "", city: str = "") -> str:
    text = normalize_text(value)
    if not text:
        return ""
    if text.isascii():
        return text

    remainder = text
    for prefix in (normalize_text(state), normalize_text(city)):
        if prefix and remainder.startswith(prefix):
            remainder = remainder[len(prefix) :]
    remainder = normalize_text(remainder)

    for source, replacement in sorted(CHINA_REGION_ASCII.items(), key=lambda item: len(item[0]), reverse=True):
        if _contains_cjk(source):
            remainder = remainder.replace(source, f" {replacement} ")
    remainder = re.sub(r"([A-Za-z])座", r"Building \1 ", remainder)
    remainder = re.sub(r"([A-Za-z0-9]+)栋", r"Building \1 ", remainder)
    remainder = re.sub(r"([0-9]+)号楼", r"Building \1 ", remainder)
    for source, replacement in CHINA_ADDRESS_PHRASE_ASCII:
        remainder = remainder.replace(source, replacement)

    tokens: list[str] = []
    for token in re.findall(r"[\u4e00-\u9fff]+|[A-Za-z0-9]+|[^\w\s]+", remainder):
        if not token or token.isspace():
            continue
        if CJK_PATTERN.fullmatch(token):
            ascii_token = _romanize_region_name(token) or _romanize_cjk_token(token, spaced=True)
            if ascii_token:
                tokens.append(ascii_token)
            continue
        tokens.append(token)

    ascii_text = " ".join(tokens)
    ascii_text = re.sub(r"\s*,\s*", ", ", ascii_text)
    ascii_text = re.sub(r"\s+([/.#-])", r"\1", ascii_text)
    ascii_text = re.sub(r"([/.#-])\s+", r"\1", ascii_text)
    ascii_text = re.sub(r"\s+", " ", ascii_text).strip(" ,")
    return ascii_text


def _infer_china_general_postal(state: str, city: str) -> str:
    for value in (normalize_text(state), normalize_text(city)):
        if not value:
            continue
        if value in CHINA_GENERAL_POSTAL_BY_REGION:
            return CHINA_GENERAL_POSTAL_BY_REGION[value]
    return ""


def _stabilize_profile_section(section: dict[str, str]) -> dict[str, str]:
    result = {key: normalize_text(value) for key, value in section.items()}

    for field in ("address1", "address2", "city", "state"):
        value = result.get(field, "")
        inline_phone = INLINE_PHONE_PATTERN.search(value)
        if inline_phone and not result.get("phone"):
            result["phone"] = _normalize_phone(inline_phone.group(1))
            value = normalize_text(INLINE_PHONE_PATTERN.sub("", value))
        result[field] = value

    for field in ("city", "state", "address2", "address1"):
        value = result.get(field, "")
        if not value:
            continue
        if _looks_like_phone(value):
            if not result.get("phone"):
                result["phone"] = _normalize_phone(value)
            result[field] = ""

    for field in ("city", "state", "address2"):
        value = result.get(field, "")
        if value and not result.get("postal") and _looks_like_postal(value):
            result["postal"] = value
            result[field] = ""

    if not result.get("address1"):
        for field in ("address2", "city", "state"):
            value = result.get(field, "")
            if value and not _looks_like_phone(value) and not _looks_like_postal(value) and _looks_like_address_line(value):
                result["address1"] = value
                result[field] = ""
                break

    china_like = any(
        CHINA_PATTERN.search(result.get(field, ""))
        for field in ("country", "address1", "city", "state")
    )
    if china_like and result.get("address1"):
        guessed_state, guessed_city = _extract_china_state_city(result["address1"])
        if guessed_state and not result.get("state"):
            result["state"] = guessed_state
        if guessed_city and not result.get("city"):
            result["city"] = guessed_city

    if china_like and result.get("state") and not result.get("state_ascii"):
        result["state_ascii"] = _romanize_region_name(result["state"])
    if china_like and result.get("city") and not result.get("city_ascii"):
        result["city_ascii"] = _romanize_region_name(result["city"])
    if china_like and result.get("address1") and not result.get("address1_ascii"):
        result["address1_ascii"] = _romanize_address_line(
            result["address1"],
            state=result.get("state", ""),
            city=result.get("city", ""),
        )
        district_match = CHINA_DISTRICT_PATTERN.search(result["address1"])
        district = normalize_text(district_match.group(1)) if district_match else ""
        district_ascii = _romanize_region_name(district)
        if district_ascii and result["address1_ascii"] and district_ascii not in result["address1_ascii"]:
            result["address1_ascii"] = normalize_text(f"{result['address1_ascii']}, {district_ascii}")
    if china_like and not result.get("postal"):
        result["postal"] = _infer_china_general_postal(result.get("state", ""), result.get("city", ""))

    result["phone"] = _normalize_phone(result.get("phone", ""))
    if not result.get("address1_ascii") and result.get("address1", "").isascii():
        result["address1_ascii"] = result["address1"]
    if not result.get("city_ascii") and result.get("city", "").isascii():
        result["city_ascii"] = result["city"]
    if not result.get("state_ascii") and result.get("state", "").isascii():
        result["state_ascii"] = result["state"]
    return result


def _any_present(section: dict[str, Any]) -> bool:
    meaningful_keys = ("name", "first_name", "last_name", "address1", "address2", "city", "state", "postal", "phone")
    return any(normalize_text(section.get(key)) for key in meaningful_keys)


def _normalize_profile_section(raw: dict[str, Any] | None, default_country: str = "United States") -> dict[str, str]:
    section = raw or {}
    labeled = _extract_labeled_values(section)
    first_name = _first_section_value(section, SECTION_KEY_ALIASES["first_name"])
    last_name = _first_section_value(section, SECTION_KEY_ALIASES["last_name"])
    full_name = _first_section_value(section, SECTION_KEY_ALIASES["name"], labeled, "name")
    if full_name and not (first_name and last_name):
        fallback_first, fallback_last = _split_full_name(full_name)
        first_name = first_name or fallback_first
        last_name = last_name or fallback_last
    if not full_name and (first_name or last_name):
        full_name = " ".join(part for part in [first_name, last_name] if part)
    normalized = {
        "name": full_name,
        "first_name": first_name,
        "last_name": last_name,
        "address1": _first_section_value(
            section,
            SECTION_KEY_ALIASES["address1"],
            labeled,
            "address1",
        )
        or _first_section_value(section, SECTION_BLOB_ALIASES["address1"]),
        "address1_ascii": normalize_text(
            section.get("address1_ascii")
            or section.get("address1_latin")
            or section.get("line1_ascii")
            or section.get("street_ascii")
        ),
        "address2": _first_section_value(section, SECTION_KEY_ALIASES["address2"], labeled, "address2"),
        "city": _first_section_value(section, SECTION_KEY_ALIASES["city"], labeled, "city"),
        "city_ascii": normalize_text(section.get("city_ascii") or section.get("city_latin")),
        "state": _first_section_value(section, SECTION_KEY_ALIASES["state"], labeled, "state"),
        "state_ascii": normalize_text(section.get("state_ascii") or section.get("state_latin") or section.get("province_ascii")),
        "postal": _first_section_value(section, SECTION_KEY_ALIASES["postal"], labeled, "postal"),
        "country": _first_section_value(section, SECTION_KEY_ALIASES["country"], labeled, "country") or normalize_text(default_country),
        "phone": _first_section_value(section, SECTION_KEY_ALIASES["phone"], labeled, "phone"),
    }
    return _stabilize_profile_section(normalized)


@dataclass
class Config:
    query: str
    candidate_urls_json: str
    mode: str
    secrets_path: Path
    out_dir: Path
    user_data_dir: Path | None
    fresh_profile: bool
    headed: bool
    use_vision: bool
    record_trace: bool
    record_video: bool
    browser_channel: str | None
    max_run_seconds: int
    max_total_usd: float
    keep_open_seconds: float
    action_delay_seconds: float
    manual_verification_timeout_seconds: int
    llm_provider: str
    browser_use_model: str
    openai_model: str
    max_steps: int
    proxy_server: str | None
    proxy_bypass: str | None
    proxy_username: str | None
    proxy_password: str | None
    confirm_delivery: bool
    confirm_legal_consent: bool
    resident_id_number: str | None
    record_order_on_success: bool
    order_label: str | None
    order_note: str | None
    order_currency: str | None
    order_store_dir: Path


def resolve_proxy_settings(args: Any) -> tuple[str | None, str | None, str | None, str | None]:
    proxy_server = _first_non_empty(
        getattr(args, "proxy_server", None),
        get_env("BROWSER_PROXY_URL"),
        get_env("HTTPS_PROXY"),
        get_env("https_proxy"),
        get_env("HTTP_PROXY"),
        get_env("http_proxy"),
        get_env("ALL_PROXY"),
        get_env("all_proxy"),
    )
    proxy_bypass = _first_non_empty(
        getattr(args, "proxy_bypass", None),
        get_env("BROWSER_PROXY_BYPASS"),
        get_env("NO_PROXY"),
        get_env("no_proxy"),
    )
    proxy_username = _first_non_empty(getattr(args, "proxy_username", None), get_env("BROWSER_PROXY_USERNAME"))
    proxy_password = _first_non_empty(getattr(args, "proxy_password", None), get_env("BROWSER_PROXY_PASSWORD"))
    return proxy_server, proxy_bypass, proxy_username, proxy_password


def load_secrets(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise ValueError(f"Secrets file not found: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    payment = data.get("payment") or {}
    email = normalize_text(payment.get("email") or data.get("email"))
    card_number = normalize_text(payment.get("card_number"))
    exp = normalize_text(payment.get("exp"))
    cvc = normalize_text(payment.get("cvc"))
    delivery = _normalize_profile_section(data.get("delivery") or data.get("shipping"))
    legacy_billing = {
        "name": payment.get("name"),
        "address1": payment.get("address1"),
        "address2": payment.get("address2"),
        "city": payment.get("city"),
        "state": payment.get("state"),
        "postal": payment.get("postal"),
        "country": payment.get("country"),
        "phone": payment.get("phone"),
    }
    billing_raw = data.get("billing") or {}
    billing_same_as_delivery = parse_bool(billing_raw.get("same_as_delivery"), False)
    if not billing_raw and _any_present(delivery):
        billing_same_as_delivery = True
    billing_source = delivery if billing_same_as_delivery else (billing_raw or legacy_billing)
    billing = _normalize_profile_section(billing_source)
    postal = normalize_text(payment.get("postal") or billing.get("postal") or delivery.get("postal"))
    country = normalize_text(payment.get("country") or billing.get("country") or delivery.get("country") or "United States")
    cardholder_name = normalize_text(payment.get("name") or billing.get("name"))
    additional_information = data.get("additional_information") or {}
    custom_fields = data.get("custom_fields") or {}
    resident_id_number = normalize_text(
        _first_non_empty(
            payment.get("resident_id_number"),
            payment.get("residentIdNumber"),
            payment.get("resident_id"),
            data.get("resident_id_number"),
            data.get("residentIdNumber"),
            data.get("resident_id"),
            additional_information.get("resident_id_number"),
            additional_information.get("residentIdNumber"),
            additional_information.get("resident_id"),
            custom_fields.get("resident_id_number"),
            custom_fields.get("residentIdNumber"),
            custom_fields.get("resident_id"),
        )
    )
    missing = [
        name
        for name, value in [
            ("payment.email", email),
            ("payment.card_number", card_number),
            ("payment.exp", exp),
            ("payment.cvc", cvc),
            ("payment.postal", postal),
            ("payment.country", country),
        ]
        if not value
    ]
    if missing:
        raise ValueError(f"Secrets file is missing required fields: {', '.join(missing)}")
    return {
        "email": email,
        "card_number": card_number,
        "card_exp": exp,
        "card_cvc": cvc,
        "card_postal": postal,
        "card_country": country,
        "card_name": cardholder_name,
        "resident_id_number": resident_id_number,
        "delivery": delivery,
        "billing": billing,
        "billing_same_as_delivery": billing_same_as_delivery,
    }


def build_sensitive_data(secrets: dict[str, Any]) -> dict[str, str]:
    delivery = secrets.get("delivery") or {}
    billing = secrets.get("billing") or {}
    return {
        "guest_email": secrets["email"],
        "card_number": secrets["card_number"],
        "card_exp": secrets["card_exp"],
        "card_cvc": secrets["card_cvc"],
        "card_postal": secrets["card_postal"],
        "card_country": secrets["card_country"],
        "card_name": secrets.get("card_name", ""),
        "resident_id_number": secrets.get("resident_id_number", ""),
        "delivery_name": delivery.get("name", ""),
        "delivery_first_name": delivery.get("first_name", ""),
        "delivery_last_name": delivery.get("last_name", ""),
        "delivery_address1": delivery.get("address1", ""),
        "delivery_address1_ascii": delivery.get("address1_ascii", ""),
        "delivery_address2": delivery.get("address2", ""),
        "delivery_city": delivery.get("city", ""),
        "delivery_city_ascii": delivery.get("city_ascii", ""),
        "delivery_state": delivery.get("state", ""),
        "delivery_state_ascii": delivery.get("state_ascii", ""),
        "delivery_postal": delivery.get("postal", ""),
        "delivery_country": delivery.get("country", ""),
        "delivery_phone": delivery.get("phone", ""),
        "billing_name": billing.get("name", ""),
        "billing_first_name": billing.get("first_name", ""),
        "billing_last_name": billing.get("last_name", ""),
        "billing_address1": billing.get("address1", ""),
        "billing_address1_ascii": billing.get("address1_ascii", ""),
        "billing_address2": billing.get("address2", ""),
        "billing_city": billing.get("city", ""),
        "billing_city_ascii": billing.get("city_ascii", ""),
        "billing_state": billing.get("state", ""),
        "billing_state_ascii": billing.get("state_ascii", ""),
        "billing_postal": billing.get("postal", ""),
        "billing_country": billing.get("country", ""),
        "billing_phone": billing.get("phone", ""),
        "billing_same_as_delivery": "true" if secrets.get("billing_same_as_delivery") else "",
    }
