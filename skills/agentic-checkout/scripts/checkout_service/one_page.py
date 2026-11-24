"""Operate Shopify guest payment forms using native controls."""

import re

from playwright.async_api import Error, Locator, Page

from shopify.security import digits, normalize_text

from .contract import PCI_HOST

PAY_BUTTON = 'button#checkout-pay-button[type="submit"]'
FORM = f"form#checkout-one-page-form, form:has({PAY_BUTTON})"
CARD_METHOD = 'input[type="radio"][id$="-creditCards"]'
CARD_FIELDS = {
    "number": "card_number", "expiry": "card_exp",
    "verification_value": "card_cvc", "name": "card_name",
}
PAYMENT_ACTIONS = {
    "en": ("Pay now", "Review order"),
    "de": ("Jetzt bezahlen", "Bestellung überprüfen"),
    "es": ("Pagar ahora", "Revisar pedido"),
    "fr": ("Payer maintenant", "Vérifier la commande"),
    "it": ("Paga ora", "Controlla ordine"),
    "ja": ("今すぐ支払う", "注文内容の確認"),
    "ko": ("지금 결제", "주문 검토"),
    "nl": ("Nu betalen", "Bestelling controleren"),
    "pt": ("Pagar agora", "Revisar pedido"),
    "zh": ("立即支付", "检查订单"),
    "zh-hant": ("立即付款", "檢閱訂單"),
}


async def form_matches(form: Locator, *, delivery: bool, same_address: bool, fill: bool) -> bool:
    if delivery:
        modes = form.locator('input[name="billing_address_selector"][type="radio"]').filter(visible=True)
        checkbox = form.locator('input#billingAddressCheckbox[type="checkbox"]').filter(visible=True)
        checkbox_count = await checkbox.count()
        if await modes.count():
            chosen = modes.and_(form.locator(":checked"))
            suffixes = ("shipping_address", "shipping") if same_address else ("custom_billing_address", "custom")
            if (await chosen.count() != 1
                    or await chosen.get_attribute("id") not in {f"billing_address_selector-{suffix}" for suffix in suffixes}):
                return False
        elif checkbox_count != 1:
            return False
        if checkbox_count and (checkbox_count != 1 or await checkbox.is_checked() != same_address):
            return False
    if not await opt_out(form, fill=fill):
        return False
    return await form.evaluate("""form => ![...form.elements].some(el =>
        el.getClientRects().length && ((el.willValidate && !el.validity.valid)
            || el.getAttribute('aria-invalid') === 'true'))
    """)


async def opt_out(surface: Page | Locator, *, fill: bool) -> bool:
    opt_ins = surface.locator('input[name="marketing_opt_in"][type="checkbox"]').or_(
        surface.get_by_role("checkbox", name=re.compile(r"^Save my information for a faster checkout$", re.I))
    ).filter(visible=True)
    for control in await opt_ins.all():
        if fill:
            await control.uncheck()
        if await control.is_checked():
            return False
    return True


async def select_card(form: Locator) -> bool:
    method = form.locator(CARD_METHOD).filter(visible=True)
    count = await method.count()
    if count == 0:
        try:
            await form.locator(
                f'iframe[name^="card-fields-number-"][src^="https://{PCI_HOST}/"]'
            ).filter(visible=True).wait_for(timeout=5_000)
            return True
        except Error:
            return False
    if count != 1 or not await method.evaluate("(el) => el.form === el.closest('form')"):
        return False
    await method.check()
    return await method.is_checked()


async def card_matches(form: Locator, data: dict, *, fill: bool) -> bool:
    for field, name in CARD_FIELDS.items():
        owner = form.locator(
            f'iframe[name^="card-fields-{field}-"][src^="https://{PCI_HOST}/"]'
        ).filter(visible=True)
        if fill:
            await owner.wait_for(timeout=5_000)
        if await owner.count() != 1:
            return False
        frame = await (await owner.element_handle()).content_frame()
        if frame is None or not frame.url.startswith(f"https://{PCI_HOST}/"):
            return False
        inputs = frame.locator("input:visible:not([data-honeypot-field])")
        if fill:
            await inputs.wait_for(timeout=5_000)
        if await inputs.count() != 1:
            return False
        control = await inputs.element_handle()
        if not await control.is_editable() or not frame.url.startswith(f"https://{PCI_HOST}/"):
            return False
        normalize = normalize_text if field == "name" else digits
        expected = normalize(data[name])
        if not expected:
            return False
        if fill:
            entry = expected
            if field == "expiry":
                if len(expected) != 4:
                    return False
                entry = f"{expected[:2]}/{expected[2:]}"
            await control.press("ControlOrMeta+A")
            await control.press("Backspace")
            await control.type(entry, delay=35)
            await control.press("Tab")
        if normalize(await control.input_value()).casefold() != expected.casefold():
            return False
    return True


async def payment_action(form: Locator, currency: str, amount: int) -> tuple[str, Locator] | None:
    button = form.locator(PAY_BUTTON).filter(visible=True)
    if await button.count() != 1:
        return None
    label, action = await button.evaluate(r"""(el, {currency, amount, actions}) => {
        const plain = text => text.replace(/\s+/g, " ").trim();
        const locale = el.ownerDocument.documentElement.lang || "en-US";
        const language = new Intl.Locale(locale).maximize();
        const labels = actions[(language.language + "-" + language.script).toLowerCase()] ?? actions[language.language];
        if (!labels || el.form !== el.closest("form") || el.hasAttribute("formaction")) return ["", null];
        const price = currencyDisplay => {
            const format = Intl.NumberFormat(locale, {style: "currency", currency, currencyDisplay});
            return plain(format.format(amount / 10 ** format.resolvedOptions().maximumFractionDigits));
        };
        const visible = plain(el.innerText);
        const label = plain(el.getAttribute("aria-label") || visible);
        const amounts = ["symbol", "narrowSymbol", "code"].map(price);
        const lower = text => text.toLocaleLowerCase(locale);
        const index = value => labels.findIndex(text => lower(value) === lower(text)
            || amounts.some(price => lower(value) === lower(text + " " + price)));
        const action = index(label);
        return [label, action === index(visible) ? (["pay", "review"][action] ?? null) : null];
    }""", {"currency": currency, "amount": amount, "actions": PAYMENT_ACTIONS})
    if action:
        name = re.compile(r"^" + r"\s+".join(map(re.escape, label.split())) + r"$", re.I)
        return action, button.and_(form.get_by_role("button", name=name))
    return None
