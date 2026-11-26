"""Exercise the public hosted worker with Chromium and synthetic checkout responses."""

import asyncio
import json
import time
import unittest
from html import escape
from urllib.parse import parse_qsl, urlsplit

from playwright.async_api import async_playwright

from checkout_service.contract import CheckoutGrant
from checkout_service.preview import run_preview
from checkout_service.purchase_worker import run_purchase
from checkout_service.worker import run_checkout


SHOP_ORIGIN = "https://fixture.myshopify.com"
CHECKOUT_URL = f"{SHOP_ORIGIN}/checkouts/cn/fixture/en-us"
CART_LINK = f"{SHOP_ORIGIN}/cart/c/fixture-cart"
VARIANT_ID = "123456789"
QUOTE = {
    "ucp": {"status": "success"},
    "id": "gid://shopify/Checkout/fixture",
    "status": "incomplete",
    "line_items": [{"item": {"id": f"gid://shopify/ProductVariant/{VARIANT_ID}", "title": "Pencil Notepad"}, "quantity": 1}],
    "currency": "USD",
    "totals": [{"type": "total", "amount": 1234}],
}
ORDER_ID = "gid://shopify/Order/1042"
PAYMENT_ORIGIN = "https://checkout.pci.shopifyinc.com"
PAYMENT_FIELDS = {
    "number": ("Card number", "cc-number", "1"),
    "expiry": ("Expiration date (MM / YY)", "cc-exp", "12/34"),
    "verification_value": ("Security code", "cc-csc", "111"),
    "name": ("Name on card", "cc-name", "Test payment gateway"),
}
PROFILE = {
    "payment": {
        "email": "checkout@example.com",
        "card_number": "1",
        "exp": "12/34",
        "cvc": "111",
        "name": "Test payment gateway",
    },
    "delivery": {
        "first_name": "Test",
        "last_name": "Buyer",
        "address1": "123 Main Street",
        "address2": "Suite 2",
        "city": "New York",
        "state": "NY",
        "postal": "10001",
        "country": "US",
        "phone": "+12125550100",
    },
    "billing": {"same_as_delivery": True},
}
BILLING = {
    "same_as_delivery": False, "first_name": "Test", "last_name": "Buyer",
    "address1": "100 Queen St W", "city": "Toronto", "state": "ON",
    "postal": "M5H 2N2", "country": "CA", "phone": "+14165550100",
}
EXPECTED_FORM = {
    "email": "checkout@example.com",
    "firstName": "Test",
    "lastName": "Buyer",
    "address1": "123 Main Street",
    "city": "New York",
    "zone": "NY",
    "postalCode": "10001",
    "countryCode": "US",
    "phone": "+12125550100",
    "shippingRate": "standard",
    "billingAddress": "shipping",
    "address2": "Suite 2",
    "paymentMethod": "card",
}
REVIEW_CASES = {
    "review", "review_steps", "review_reprice", "review_identity", "review_address", "review_challenge",
    "review_escape", "review_expired",
}
BLOCKED_REDIRECTS = {
    "redirect_forbidden": (403, "Forbidden"),
    "redirect_throttled": (429, "Please try again later"),
    "redirect_challenge": (200, "Verify you are human"),
}
DELIVERY_CHOICE_CASES = {"purchase_delivery_required", "purchase_delivery_selected", "purchase_delivery_changed"}
PURCHASE_CASES = {"purchase_approved", "purchase_repriced", "purchase_review_steps", *DELIVERY_CHOICE_CASES}


def checkout_document(scenario):
    checkout_flow = "review_steps" if scenario == "purchase_review_steps" else scenario
    frames = "".join(
        f'<iframe title="{escape(title)}" name="card-fields-{field}-fixture" '
        f'src="{PAYMENT_ORIGIN}/{field}"></iframe>'
        for field, (title, _, _) in PAYMENT_FIELDS.items()
    )
    changes = {
        "reprice": "state.totals[0].amount = 1235",
        "cart_changed": "state.line_items[0].item.id = 'gid://shopify/ProductVariant/777'",
        "late_identity": "state.fulfillment.methods[0].destinations[0].street_address = '23 Main Street'",
        "shipping_changed": "state.fulfillment.methods[0].groups[0].selected_option_id = 'other'",
    }
    on_fill = changes.get(scenario, "")
    region_script = "address.address_region = 'NJ';" if scenario == "wrong_region" else ""
    pay_label = {
        "decline": "Pay now", "wrong_button": "Pay now&#10;$13.34",
        "review_label_mismatch": "Review order&#10;$12.34", "localized_pay": "PAGAR AHORA&#10;$12.34",
    }.get(scenario, "Pay now&#10;$12.34")
    reviewed = checkout_flow in REVIEW_CASES
    if reviewed:
        pay_label = "Review order&#10;$12.34"
    visible_label = "Pay now" if scenario == "review_label_mismatch" else pay_label
    form_action = "review" if reviewed else "complete"
    stale_decline = '<p role="alert">Your card was declined</p>' if scenario == "stale_decline" else ""
    duplicate = '<button id="checkout-pay-button" type="submit">Pay now</button>' if scenario == "ambiguous_payment" else ""
    extra_required = '<label>Tax ID <input required name="taxId"></label>' if scenario == "required_field" else ""
    separate_billing = scenario in {"distinct_billing", "wrong_billing"}
    three_steps = checkout_flow in {"three_steps", "review_steps"}
    payment_form = "checkout-payment-fixture" if three_steps else "checkout-one-page-form"
    form_visibility = "hidden" if three_steps else ""
    billing_field = '<input id="billingAddressCheckbox" type="checkbox" name="billingAddress" value="shipping" checked>'
    if separate_billing or three_steps:
        same_id = "shipping" if three_steps else "shipping_address"
        custom_id = "custom" if three_steps else "custom_billing_address"
        billing_field = f"""
            <label><input type="radio" name="billing_address_selector"
              id="billing_address_selector-{same_id}" value="same" checked> Same as shipping address</label>
            <label><input type="radio" name="billing_address_selector"
              id="billing_address_selector-{custom_id}" value="different"> Use a different billing address</label>
            <input type="hidden" name="billingPostal">
        """
    if separate_billing or three_steps:
        frames = f"""
            <label><input type="radio" name="basic" id="basic-wallet" value="wallet" checked> Wallet</label>
            <label><input type="radio" name="basic" id="basic-creditCards" value="card"> Credit card</label>
            <div id="fixtureCardFields" hidden>{frames}</div>
        """
    if scenario == "no_native_card":
        frames = '<label><input type="radio" name="basic" id="basic-wallet" checked> Wallet</label>'
    route_configuration = """
        const steps = ["information", "shipping", "payment"];
        state.webmcp = {step: {current: "information", all: steps}};
        document.modelContext.registerTool({
          name: "navigate_checkout", description: "Move to the next checkout step",
          inputSchema: {type: "object", properties: {destination: {type: "string"}}, required: ["destination"]},
          execute: ({destination}) => {
            if (steps[steps.indexOf(state.webmcp.step.current) + 1] !== destination)
              return {error: {code: "navigation_failed"}};
            if (destination === "shipping" && document.querySelector('#informationOptIn').checked)
              return {error: {code: "buyer_action_required"}};
            if (destination === "shipping")
              state.fulfillment.methods[0].groups = [{
                id: "shipment_1", selected_option_id: "other", options: [{id: "standard"}, {id: "other"}],
              }];
            if (destination === "payment" && state.fulfillment.methods[0].groups[0]?.selected_option_id !== "standard")
              return {error: {code: "buyer_action_required"}};
            state.webmcp.step.current = destination;
            history.replaceState(null, "", destination);
            document.querySelector("#checkout-payment-fixture").hidden = destination !== "payment";
            return {ucp: {status: "success"}, id: state.id, webmcp: state.webmcp};
          },
        });
    """ if three_steps else ""
    market_rewrite = """history.replaceState(null, "", "?market=CA");""" if scenario == "market_rewrite" else ""
    review_state = """
        state.status = "requires_escalation";
        state.messages = [{code: "buyer_review_required", severity: "requires_buyer_review"}];
    """ if scenario == "review_state" else ""
    if checkout_flow == "review_steps":
        route_configuration = route_configuration.replace('"shipping", "payment"', '"shipping", "payment", "review"')
    billing_rewrite = "billing.street_address = address.street_address;" if scenario == "wrong_billing" else ""
    delivery_choices = """
        state.fulfillment.methods[0].groups[0].options = [
          {id: "standard", title: "Standard", totals: [{type: "total", amount: 234}]},
          {id: "express", title: "Express", totals: [{type: "total", amount: 734}]},
        ];
        delete state.fulfillment.methods[0].groups[0].selected_option_id;
    """ if scenario in DELIVERY_CHOICE_CASES else ""
    preserve_rates = """
        const currentRates = state.fulfillment.methods[0].groups;
        if (!checkout.fulfillment.methods[0].groups && currentRates)
          checkout.fulfillment.methods[0].groups = currentRates;
    """ if scenario in PURCHASE_CASES else ""
    language = "es-US" if scenario == "localized_pay" else "en-US"
    information = '<input id="informationOptIn" type="checkbox" name="marketing_opt_in" checked>' if three_steps else ""
    return f"""
        <!doctype html>
        <html lang="{language}">
        <title>Checkout</title>
        <main>
          {information}
          {stale_decline}
          <form><input autocomplete="email" name="email" value="unrelated@example.com"></form>
          <form id="{payment_form}" method="post" action="{CHECKOUT_URL}/{form_action}" {form_visibility}>
            <h2>Contact</h2>
            <label>Email <input id="email" type="email" name="email" autocomplete="email"></label>
            <h2>Delivery</h2>
            <label>Country/Region
              <select id="countryCode" name="countryCode" autocomplete="shipping country-name">
                <option value="">Select country</option>
                <option value="US">United States</option>
              </select>
            </label>
            <label>First name <input id="firstName" name="firstName" autocomplete="shipping given-name"></label>
            <label>Last name <input id="lastName" name="lastName" autocomplete="shipping family-name"></label>
            <label>Address <input id="address1" name="address1" autocomplete="shipping address-line1"></label>
            <label>Suite <input name="address2" autocomplete="shipping address-line2"></label>
            <label>City <input id="city" name="city" autocomplete="shipping address-level2"></label>
            <label>State
              <select id="zone" name="zone" autocomplete="shipping address-level1">
                <option value="">Select state</option>
                <option value="NY">New York</option>
                <option value="NJ">New Jersey</option>
              </select>
            </label>
            <label>ZIP code <input id="postalCode" name="postalCode" autocomplete="shipping postal-code"></label>
            <label>Phone <input id="phone" name="phone" autocomplete="shipping tel"></label>
            <h2>Shipping method</h2>
            <label><input type="radio" name="shippingRate" value="standard" checked> Standard</label>
            <h2>Payment</h2>
            {frames}
            {billing_field}
            <input type="checkbox" name="marketing_opt_in" checked aria-label="News">
            <input type="checkbox" checked aria-label="Save my information for a faster checkout">
            {extra_required}
            <button id="checkout-pay-button" type="submit" name="paymentMethod" value="card" aria-label="{pay_label}">{visible_label}</button>
            <button type="submit" name="paymentMethod" value="wallet">Pay now with Shop Pay</button>
            {duplicate}
          </form>
          <aside aria-label="Order summary">
            <div><span>Subtotal</span> <span>$12.34</span></div>
            <div><span>Total</span> <span id="total">USD $12.34</span></div>
          </aside>
        </main>
        <script>
          const state = {json.dumps(QUOTE)};
          {review_state}
          state.fulfillment = {{methods: [{{type: "shipping", destinations: [], groups: [
            {{id: "shipment_1", selected_option_id: "standard"}}
          ]}}]}};
          {delivery_choices}
          if ({str(three_steps).lower()}) delete state.fulfillment.methods[0].groups;
          state.declared_fields = [{{key: "shop_pay_sign_up", value: true, required: false}}];
          state.discounts = {{codes: ["SPRING"]}};
          {route_configuration}
          const form = document.getElementById("{payment_form}");
          form.addEventListener("change", event => {{
            if (event.target.id === "basic-creditCards") {{
              document.querySelector("#fixtureCardFields").hidden = false;
              if (state.webmcp?.step.current === "payment")
                state.declared_fields = [{{key: "shop_pay_sign_up", value: true, required: false}}];
            }}
          }});
          document.modelContext.registerTool({{
            name: "get_checkout", description: "Current checkout", inputSchema: {{type: "object"}},
            execute: () => state,
          }});
          document.modelContext.registerTool({{
            name: "update_checkout", description: "Update guest checkout",
            inputSchema: {{type: "object", properties: {{checkout: {{type: "object"}}}}, required: ["checkout"]}},
            execute: ({{checkout}}) => {{
              state.buyer = checkout.buyer;
              {preserve_rates}
              state.fulfillment = checkout.fulfillment;
              state.declared_fields = checkout.declared_fields;
              const method = checkout.fulfillment.methods[0];
              const address = method.destinations[0];
              {region_script}
              const billing = checkout.payment?.instruments[0]?.billing_address ?? address;
              {billing_rewrite}
              state.payment = {{instruments: [{{billing_address: billing}}]}};
              if (form.elements.billing_address_selector) {{
                form.elements.billing_address_selector.value = billing === address ? "same" : "different";
                form.elements.billingPostal.value = billing.postal_code;
              }}
              if (checkout.discounts?.codes[0] === "SPRING" && method.groups?.[0]?.selected_option_id === "standard")
                state.status = "ready_for_complete";
              {market_rewrite}
              const values = {{
                email: checkout.buyer.email, countryCode: address.address_country,
                firstName: address.first_name, lastName: address.last_name,
                address1: address.street_address, address2: address.extended_address,
                city: address.address_locality, zone: address.address_region,
                postalCode: address.postal_code, phone: address.phone_number,
              }};
              for (const [key, value] of Object.entries(values)) form.elements[key].value = value;
              if ({str(scenario == "applied_update_timeout").lower()})
                return {{ucp: {{status: "error"}}, error: {{code: "update_failed"}}}};
              return state;
            }},
          }});
          window.addEventListener("message", event => {{
            if (event.origin === "{PAYMENT_ORIGIN}" && event.data === "fixture-card-number-entered") {{
              {on_fill}
            }}
          }});
        </script>
    """


def review_document(scenario):
    address = {
        "first_name": "Test", "last_name": "Buyer", "street_address": "123 Main Street",
        "extended_address": "Suite 2", "address_locality": "New York", "address_region": "NY",
        "postal_code": "10001", "address_country": "US", "phone_number": "+12125550100",
    }
    state = {
        **QUOTE, "status": "requires_escalation",
        "messages": [{"code": "buyer_review_required", "severity": "requires_buyer_review"}],
        "buyer": {"email": "checkout@example.com"},
        "fulfillment": {"methods": [{
            "type": "shipping", "destinations": [dict(address)],
            "groups": [{"id": "shipment_1", "selected_option_id": "standard"}],
        }]},
        "payment": {"instruments": [{"billing_address": address}]},
    }
    if scenario == "review_steps":
        state["webmcp"] = {"step": {"current": "review", "all": ["information", "shipping", "payment", "review"]}}
    if scenario == "review_reprice":
        state["totals"] = [{"type": "total", "amount": 1235}]
    if scenario == "review_identity":
        state["id"] = "gid://shopify/Checkout/other"
    if scenario == "review_address":
        state["fulfillment"]["methods"][0]["destinations"][0]["street_address"] = "23 Main Street"
    challenge = "<p>Authenticate your payment</p>" if scenario == "review_challenge" else ""
    wait = "await new Promise(resolve => setTimeout(resolve, 4000));" if scenario == "review_expired" else ""
    return f"""
        <html lang="en-US">
        <h1>Review order</h1>
        {challenge}
        <form method="post" action="{CHECKOUT_URL}/complete">
          <input type="hidden" name="reviewedOrder" value="fixture">
          <button id="checkout-pay-button" type="submit" name="paymentMethod" value="card">Pay now</button>
        </form>
        <script>
          document.modelContext.registerTool({{
            name: "get_checkout", description: "Checkout review", inputSchema: {{type: "object"}},
            execute: async () => {{ {wait} return {json.dumps(state)}; }},
          }});
        </script>
    """


class HostedBrowserTest(unittest.IsolatedAsyncioTestCase):
    async def test_purchase_quote_waits_for_approval_on_the_same_page(self):
        """The real card form must stay untouched until approval and reject a subsequent merchant price change."""
        cases = {
            "purchase_approved": {"status": "submitted", "order_id": ORDER_ID},
            "purchase_repriced": {"status": "total_mismatch"},
            "purchase_delivery_required": None,
            "purchase_delivery_selected": {"status": "submitted", "order_id": ORDER_ID},
            "purchase_delivery_changed": None,
            "purchase_review_steps": {"status": "submitted", "order_id": ORDER_ID},
        }
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(args=["--enable-features=WebMCP"])
            try:
                for scenario, expected_result in cases.items():
                    with self.subTest(scenario=scenario):
                        await self.run_scenario(browser, scenario, expected_result)
            finally:
                await browser.close()

    async def test_checkout_authorization_and_merchant_outcome(self):
        """Drive the browser because parser or worker mocks cannot prove which form is dispatched."""
        cases = {
            "confirmation": {"status": "submitted", "order_id": ORDER_ID},
            # Shopify reports a timed-out update that nevertheless applied. Submit only after readback.
            "applied_update_timeout": {"status": "submitted", "order_id": ORDER_ID},
            "reprice": {"status": "total_mismatch"},
            "decline": {"status": "payment_failed"},
            "stale_decline": {"status": "submitted", "order_id": ORDER_ID},
            "wrong_region": {"status": "identity_incomplete"},
            "ambiguous_payment": {"status": "unsupported_checkout"},
            "wrong_button": {"status": "unsupported_checkout"},
            "cart_changed": {"status": "cart_mismatch"},
            "card_rewritten": {"status": "payment_fields_incomplete"},
            "late_identity": {"status": "identity_incomplete"},
            "shipping_changed": {"status": "checkout_not_ready"},
            "unapproved_shipping": {"status": "checkout_not_ready"},
            "required_field": {"status": "identity_incomplete"},
            "no_receipt": {"status": "reconciliation_required"},
            "distinct_billing": {"status": "submitted", "order_id": ORDER_ID},
            "wrong_billing": {"status": "identity_incomplete"},
            "three_steps": {"status": "submitted", "order_id": ORDER_ID},
            "market_rewrite": {"status": "submitted", "order_id": ORDER_ID},
            "localized_pay": {"status": "submitted", "order_id": ORDER_ID},
            "review": {"status": "submitted", "order_id": ORDER_ID},
            "review_steps": {"status": "submitted", "order_id": ORDER_ID},
            "review_reprice": {"status": "total_mismatch"},
            "review_identity": {"status": "checkout_unavailable"},
            "review_address": {"status": "identity_incomplete"},
            "review_challenge": {"status": "manual_verification"},
            "review_escape": {"status": "reconciliation_required"},
            "review_expired": {"status": "approval_expired"},
            "review_state": {"status": "checkout_not_ready"},
            "review_label_mismatch": {"status": "unsupported_checkout"},
            "no_native_card": {"status": "payment_method_unavailable"},
            **{scenario: {"status": "manual_verification"} for scenario in BLOCKED_REDIRECTS},
        }
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(args=["--enable-features=WebMCP"])
            try:
                for scenario, expected_result in cases.items():
                    with self.subTest(scenario=scenario):
                        await self.run_scenario(browser, scenario, expected_result)
            finally:
                await browser.close()

    async def run_scenario(self, browser, scenario, expected_result):
        context = await browser.new_context(locale="en-US", service_workers="block", accept_downloads=False)
        page = await context.new_page()
        page.set_default_timeout(5_000)
        submitted = []
        reviewed = []
        merchant_posts = []
        card_at_submit = []
        card_inputs = {}
        server = None
        escape_url = None

        async def off_route_response(reader, writer):
            try:
                await reader.readuntil(b"\r\n\r\n")
                status, body = BLOCKED_REDIRECTS.get(scenario, (200, '<p role="alert">Your card was declined</p>'))
                payload = body.encode()
                writer.write(
                    f"HTTP/1.1 {status} Fixture\r\nContent-Type: text/html\r\n"
                    f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n".encode() + payload
                )
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        def record_card_input(source, value):
            frame_url = source["frame"].url
            if frame_url.startswith(f"{PAYMENT_ORIGIN}/"):
                card_inputs[urlsplit(frame_url).path[1:]] = value

        async def respond(route):
            request = route.request
            if request.method == "POST" and urlsplit(request.url).netloc == urlsplit(SHOP_ORIGIN).netloc:
                merchant_posts.append(request.url)
            if request.method == "POST" and request.url == f"{CHECKOUT_URL}/review":
                reviewed.append(dict(parse_qsl(request.post_data or "")))
                if scenario == "review_escape":
                    await route.fulfill(status=303, headers={"location": escape_url})
                else:
                    await route.fulfill(
                        content_type="text/html",
                        body=review_document("review_steps" if scenario == "purchase_review_steps" else scenario),
                    )
            elif request.method == "POST" and request.url == f"{CHECKOUT_URL}/complete":
                submitted.append(dict(parse_qsl(request.post_data or "")))
                card_at_submit.append(card_inputs.copy())
                suffix = {"decline": "?declined=1", "stale_decline": "?processing=1"}.get(scenario, "/thank-you")
                destination = f"{CHECKOUT_URL}{suffix}"
                await route.fulfill(
                    content_type="text/html",
                    body=f"<script>location.replace('{destination}');</script>",
                )
            elif request.url == f"{CHECKOUT_URL}?processing=1":
                await route.fulfill(content_type="text/html", body=f"""
                    <p role="alert">Your card was declined</p>
                    <script>setTimeout(() => location.replace('{CHECKOUT_URL}/thank-you'), 1500);</script>
                """)
            elif request.url == CART_LINK and scenario in PURCHASE_CASES:
                destination = f"{CHECKOUT_URL}/information" if scenario == "purchase_review_steps" else CHECKOUT_URL
                await route.fulfill(
                    content_type="text/html",
                    body=checkout_document(scenario).replace(
                        "const state =", f"history.replaceState(null, '', '{destination}'); const state =", 1,
                    ),
                )
            elif request.url in {CHECKOUT_URL, f"{CHECKOUT_URL}/information"}:
                if scenario in BLOCKED_REDIRECTS:
                    await route.fulfill(status=302, headers={"location": escape_url})
                else:
                    await route.fulfill(content_type="text/html", body=checkout_document(scenario))
            elif request.url == f"{CHECKOUT_URL}/thank-you":
                receipt = {**QUOTE, "status": "completed", "order": {"id": ORDER_ID}}
                if scenario == "no_receipt":
                    receipt = {**receipt, "totals": [{"type": "total", "amount": 999}]}
                await route.fulfill(content_type="text/html", body=f"""
                    <h1>Thank you</h1>
                    <script>
                    document.modelContext.registerTool({{
                      name: "get_checkout", description: "Order receipt", inputSchema: {{type: "object"}},
                      execute: () => ({json.dumps(receipt)}),
                    }});
                    </script>
                """)
            elif request.url == f"{CHECKOUT_URL}?declined=1":
                await route.fulfill(content_type="text/html", body='<p role="alert">Your card was declined</p>')
            elif request.url.startswith(f"{PAYMENT_ORIGIN}/") and urlsplit(request.url).path[1:] in PAYMENT_FIELDS:
                field = urlsplit(request.url).path[1:]
                title, autocomplete, _ = PAYMENT_FIELDS[field]
                notify_parent = (
                    f"parent.postMessage('fixture-card-number-entered', '{SHOP_ORIGIN}');"
                    if field == "number" else ""
                )
                rewrite = "event.currentTarget.value = '3';" if field == "number" and scenario == "card_rewritten" else ""
                await route.fulfill(
                    content_type="text/html",
                    body=f"""
                        <input aria-label="{escape(title)}" name="{field}" autocomplete="{autocomplete}">
                        <script>
                          document.querySelector('input').addEventListener('input', (event) => {{
                            {rewrite}
                            window.recordFixtureCardInput(event.currentTarget.value);
                            {notify_parent}
                          }});
                        </script>
                    """,
                )
            else:
                await route.abort("blockedbyclient")

        try:
            if scenario in BLOCKED_REDIRECTS or scenario == "review_escape":
                # A redirected navigation bypasses Playwright routing for the original request.
                server = await asyncio.start_server(off_route_response, "127.0.0.1", 0)
                escape_url = f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}/checkout-elsewhere"
            await context.expose_binding("recordFixtureCardInput", record_card_input)
            await context.route("**/*", respond)
            if scenario in PURCHASE_CASES:
                quotes = []
                selections = []
                profile = {key: value for key, value in PROFILE.items() if key != "payment"}
                profile["email"] = PROFILE["payment"]["email"]
                payload = {
                    "checkout_url": CART_LINK, "checkout_host": urlsplit(SHOP_ORIGIN).netloc,
                    "items": {VARIANT_ID: 1}, "profile": profile, "expires_at": time.time() + 160,
                }
                if scenario == "purchase_review_steps":
                    payload["shipping_options"] = {"shipment_1": {"selected_option_id": "standard"}}

                async def read_next():
                    self.assertEqual(len(quotes), 1)
                    self.assertEqual(card_inputs, {})
                    self.assertEqual(merchant_posts, [])
                    if quotes[0]["status"] == "requires_action" and not selections:
                        self.assertLess(time.time(), quotes[0]["selection_expires_at"])
                        self.assertEqual(quotes[0]["reason"], "shipping_option_required")
                        self.assertEqual(quotes[0]["delivery_options"], {"shipment_1": [
                            {"id": "standard", "title": "Standard", "amount": 234},
                            {"id": "express", "title": "Express", "amount": 734},
                        ]})
                        if scenario == "purchase_delivery_required":
                            return None
                        await page.evaluate("window.deliveryChoicePage = true")
                        if scenario == "purchase_delivery_changed":
                            await page.evaluate("state.fulfillment.methods[0].groups[0].options.shift()")
                        return {"shipping_options": {"shipment_1": {"selected_option_id": "standard"}}}

                    observed = selections[0] if selections else quotes[0]
                    self.assertEqual(observed["status"], "quoted")
                    self.assertEqual(observed["quote"]["minor_units"], 1234)
                    self.assertEqual(observed["quote"]["shipping_options"], {
                        "shipment_1": {"selected_option_id": "standard"},
                    })
                    if scenario == "purchase_delivery_selected":
                        self.assertTrue(await page.evaluate("window.deliveryChoicePage === true"))
                    if scenario == "purchase_repriced":
                        await page.evaluate("state.totals[0].amount = 1235")
                    return {"gateway": "shopify_test_gateway", "payment": PROFILE["payment"]}

                result = await run_purchase(page, payload, quotes.append, read_next, publish_selection=selections.append)
                self.assertEqual(result, expected_result)
                if scenario == "purchase_delivery_required":
                    self.assertEqual(selections, [{"status": "approval_expired"}])
                if scenario == "purchase_delivery_changed":
                    self.assertEqual(selections, [{
                        "status": "requires_action", "reason": "shipping_option_required",
                        "delivery_options": {"shipment_1": [
                            {"id": "express", "title": "Express", "amount": 734},
                        ]},
                    }])
                if expected_result and expected_result["status"] == "submitted":
                    if scenario == "purchase_review_steps":
                        self.assertEqual(merchant_posts, [f"{CHECKOUT_URL}/review", f"{CHECKOUT_URL}/complete"])
                        self.assertEqual(submitted, [{"reviewedOrder": "fixture", "paymentMethod": "card"}])
                    else:
                        self.assertEqual(merchant_posts, [f"{CHECKOUT_URL}/complete"])
                        self.assertEqual(submitted, [EXPECTED_FORM])
                    self.assertEqual(card_at_submit, [{field: expected for field, (_, _, expected) in PAYMENT_FIELDS.items()}])
                else:
                    self.assertEqual(merchant_posts, [])
                    self.assertEqual(card_inputs, {})
                return

            grant = CheckoutGrant(
                checkout_url=f"{CHECKOUT_URL}/information" if scenario in {"three_steps", "review_steps"} else CHECKOUT_URL,
                items={VARIANT_ID: 1}, total_minor_units=1234,
                currency="USD", expires_at=time.time() + (4 if scenario == "review_expired" else 300),
                shipping_options={} if scenario == "unapproved_shipping" else {"shipment_1": {"selected_option_id": "standard"}},
            )
            card_number = "2" if scenario == "decline" else "1"
            profile = {**PROFILE, "payment": {**PROFILE["payment"], "card_number": card_number}}
            if scenario in {"distinct_billing", "wrong_billing"}:
                profile["billing"] = BILLING
            result = await run_checkout(page, grant, profile, "shopify_test_gateway")
            self.assertEqual(result, expected_result)
            if scenario in REVIEW_CASES:
                expected_review = dict(EXPECTED_FORM)
                if scenario == "review_steps":
                    expected_review.pop("billingAddress")
                    expected_review.update(basic="card", billing_address_selector="same", billingPostal="10001")
                self.assertEqual(reviewed, [expected_review])
                expected_posts = [f"{CHECKOUT_URL}/review"]
                if expected_result["status"] == "submitted":
                    expected_posts.append(f"{CHECKOUT_URL}/complete")
                    self.assertEqual(submitted, [{"reviewedOrder": "fixture", "paymentMethod": "card"}])
                    self.assertEqual(card_at_submit, [{field: expected for field, (_, _, expected) in PAYMENT_FIELDS.items()}])
                else:
                    self.assertEqual(submitted, [])
                self.assertEqual(merchant_posts, expected_posts)
                return
            if scenario in {
                "wrong_region", "required_field", "wrong_billing", "no_native_card",
                "ambiguous_payment", "wrong_button", "review_label_mismatch", "review_state", "unapproved_shipping",
                *BLOCKED_REDIRECTS,
            }:
                self.assertEqual(merchant_posts, [])
                self.assertEqual(card_inputs, {})
            elif scenario == "card_rewritten":
                self.assertEqual(submitted, [])
                self.assertEqual(card_inputs.get("number"), "3")
            elif scenario in {"reprice", "cart_changed", "late_identity", "shipping_changed"}:
                self.assertEqual(submitted, [])
                self.assertEqual(card_inputs.get("number"), card_number)
            else:
                expected_form = dict(EXPECTED_FORM)
                if scenario == "distinct_billing":
                    expected_form.pop("billingAddress")
                    expected_form.update(basic="card", billing_address_selector="different", billingPostal="M5H 2N2")
                if scenario == "three_steps":
                    expected_form.pop("billingAddress")
                    expected_form.update(basic="card", billing_address_selector="same", billingPostal="10001")
                self.assertEqual(submitted, [expected_form])
                expected_card = {field: expected for field, (_, _, expected) in PAYMENT_FIELDS.items()}
                expected_card["number"] = card_number
                self.assertEqual(card_at_submit, [expected_card])
        finally:
            await context.close()
            if server:
                server.close()
                await server.wait_closed()

    async def test_preview_retries_only_documented_initialization(self):
        """Prove that one read can survive native tool replacement and preserve other errors."""
        variant_id = "123456789"
        reference = {
            "ucp": {"status": "success"},
            "status": "incomplete",
            "line_items": [{
                "item": {"id": f"gid://shopify/ProductVariant/{variant_id}", "title": "Pencil Notepad"},
                "quantity": 1,
            }],
            "currency": "USD",
            "totals": [{"type": "total", "amount": 1800}],
        }
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(args=["--enable-features=WebMCP"])
            try:
                for initializing in (True, False):
                    with self.subTest(initializing=initializing):
                        page = await browser.new_page()
                        error = {"error": {
                            "code": "internal_error",
                            "message": "Checkout is initializing." if initializing else "Unexpected failure.",
                        }}
                        try:
                            async def respond(route):
                                if urlsplit(route.request.url).path.startswith("/buy/"):
                                    await route.fulfill(
                                        content_type="text/html", body=f"<script>location.replace('{CHECKOUT_URL}')</script>",
                                    )
                                    return
                                await route.fulfill(content_type="text/html", body=f"""
                                    <div><span>Total</span> <span>USD $18.00</span></div>
                                    <script>
                                      const model = document.modelContext;
                                      const controller = new AbortController();
                                      const tool = {{
                                        name: "get_checkout", description: "Read checkout",
                                        inputSchema: {{type: "object"}},
                                      }};
                                      model.registerTool({{ ...tool, execute: () => {{
                                        if ({json.dumps(initializing)}) {{
                                          setTimeout(() => {{
                                            controller.abort();
                                            model.registerTool({{ ...tool, execute: () => ({json.dumps(reference)}) }});
                                          }}, 50);
                                        }}
                                        return {json.dumps(error)};
                                      }} }}, {{signal: controller.signal}});
                                    </script>
                                """)
                            await page.route("**/*", respond)
                            result = await run_preview(
                                page, "fixture.myshopify.com", f"{SHOP_ORIGIN}/buy", variant_id, 1,
                            )
                            if initializing:
                                self.assertEqual(result["status"], "preview_ready")
                                self.assertEqual(result["source"], "shopify_webmcp")
                                self.assertEqual(result["item"]["variant_id"], variant_id)
                                self.assertEqual(result["total"], {"currency": "USD", "minor_units": 1800})
                            else:
                                self.assertEqual(result["status"], "checkout_reached")
                                self.assertEqual(result["webmcp_status"], "internal_error")
                        finally:
                            await page.close()
            finally:
                await browser.close()
