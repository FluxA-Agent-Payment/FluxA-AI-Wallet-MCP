const $ = (id) => document.getElementById(id);
const merchants = new Map();
const cart = new Map();
const shipping = new Map();
const SHOP_CATALOG = 'shop_catalog';
const E2B_CARD = 'e2b_card';
const supportedMarkets = { AU: 'AUD', CA: 'CAD', CH: 'CHF', CN: 'CNY', DE: 'EUR', FR: 'EUR', GB: 'GBP', HK: 'HKD', JP: 'JPY', SG: 'SGD', US: 'USD' };
const statusLabels = {
  draft: 'Cart ready', preparing: 'Preparing quote', quoted: 'Quote ready',
  submitting: 'Submitting', submitted: 'Order submitted', failed: 'Checkout failed',
  requires_action: 'Action needed', reconciliation_required: 'Checking order', expired: 'Quote expired',
};

let token = '';
let cardCheckout = false;
let purchase;
let pendingCreate;
let selectedQuote;
let statusTimer;
let expiryTimer;
let lastEvent = 0;
let editing = false;
let refreshing = false;
let searching = false;
let previousCountry = countryCode();

function element(tag, text, className) {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function message(id, text = '') {
  $(id).textContent = text;
  $(id).hidden = !text;
}

function label(value) {
  return value ? value.replaceAll(/[_.]/g, ' ').replace(/^./, (char) => char.toUpperCase()) : '';
}

function money(amount, currency, inMinorUnits = true) {
  const format = new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'code' });
  return format.format(inMinorUnits ? amount / 10 ** format.resolvedOptions().maximumFractionDigits : amount);
}

function timestamp(seconds) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(seconds * 1000);
}

function countryCode() {
  return $('country').value.trim().toUpperCase();
}

function variantId(value, channel) {
  const id = String(value ?? '').trim();
  const match = /^(gid:\/\/shopify\/ProductVariant\/)?([1-9][0-9]{0,19})(?:\?[^\s#]+)?$/.exec(id);
  if (!channel) return match?.[2];
  if (match?.[1] && id === value && id.length <= 512) return id;
}

function receiptOrderId(result) {
  if (result?.status === 'submitted' && typeof result.order_id === 'string'
    && /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(result.order_id)) return result.order_id;
}

function httpsUrl(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) return;
  const url = new URL(value);
  if (url.protocol === 'https:' && !url.username && !url.password) return value;
}

function externalLink(title, value) {
  const url = httpsUrl(value);
  if (!url) return;
  const link = element('a', title);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

async function request(path, method = 'GET', body, access = token) {
  const headers = { Authorization: `Bearer ${access}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(path.endsWith('/quote') ? 150000 : 65000),
    });
  } catch {
    throw new Error('The checkout service did not respond. Try again or refresh the purchase status.');
  }
  if (response.status === 401) {
    if (token === access) {
      token = '';
      updateConnection();
    }
    throw new Error('Connect with a valid checkout service token.');
  }
  if (response.status === 403) {
    const error = await response.json().catch(() => null);
    if (typeof error?.detail === 'string') throw new Error(error.detail);
  }
  if (!response.ok) {
    throw new Error(response.status === 409
      ? 'The purchase changed. Refresh its status before continuing.'
      : `The checkout service returned HTTP ${response.status}.`);
  }
  return response.json();
}

function updateConnection() {
  $('connection').textContent = token ? 'Service connected' : 'Connect service';
  $('connection').classList.toggle('connected', Boolean(token));
}

function openConnection() {
  message('connect-error');
  $('connect-dialog').showModal();
}

function rememberPurchase() {
  const url = new URL(location.href);
  if (purchase) url.searchParams.set('purchase', purchase.id);
  else url.searchParams.delete('purchase');
  history.replaceState(null, '', url);
}

async function resumePurchase() {
  const id = new URL(location.href).searchParams.get('purchase');
  if (purchase || !id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return;
  purchase = await request(`/purchases/${id}`);
  $('country').value = purchase.country;
  $('country').dispatchEvent(new Event('change'));
  const { merchant, country, channel, currency } = purchase;
  if (currency) $('currency').value = currency;
  for (const [id, quantity] of Object.entries(purchase.items)) {
    const fixture = fixtures.find((item) => item.id === id && item.merchant === merchant);
    cart.set(id, { id, merchant, country, channel, currency, title: fixture?.title ?? `Variant ${variantId(id)}`, quantity });
  }
  await readEvents();
}

function fixturesFromMerchants() {
  const options = [];
  $('merchant-list').replaceChildren();
  for (const item of merchants.values()) {
    if (!merchantCanQuote(item.merchant)) continue;
    const option = element('option');
    option.value = item.merchant;
    $('merchant-list').append(option);
    for (const product of item.products ?? []) {
      const id = variantId(product.variant_id);
      if (id) options.push({ ...product, id, merchant: item.merchant });
    }
  }
  $('fixture').replaceChildren(...options.map((item) => element('option', `${item.title} · ${item.merchant} · ${item.country}`)));
  $('fixtures').hidden = !options.length;
  $('test-note').textContent = options.length
    ? 'Choose a product from a configured test store.'
    : 'Enter a variant ID from one of your configured merchants.';
  return options;
}

function merchantCanQuote(domain) {
  return merchants.get(domain)?.status === 'test_checkout';
}

function canCheckout({ merchant, channel }) {
  if (channel) return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(merchant);
  return merchantCanQuote(merchant);
}

function renderProducts(products, country, currency, testLink = false) {
  const cards = [];
  const catalogChannel = cardCheckout ? E2B_CARD : SHOP_CATALOG;
  for (const product of products) {
    for (const variant of product.variants ?? []) {
      const merchant = variant.seller?.domain;
      const channel = testLink || (!cardCheckout && merchantCanQuote(merchant)) ? undefined : catalogChannel;
      const id = variantId(variant.id, channel);
      const title = product.title || 'Shopify product';
      const options = variant.options?.map((option) => option.label).filter(Boolean).join(' · ') || variant.title;
      const card = element('article', '', 'product');
      const imageUrl = [...(variant.media ?? []), ...(product.media ?? [])]
        .map((media) => httpsUrl(media.url ?? media.image?.url)).find(Boolean);
      if (imageUrl) {
        const image = element('img');
        image.alt = '';
        image.loading = 'lazy';
        image.addEventListener('error', () => image.remove(), { once: true });
        image.src = imageUrl;
        card.append(image);
      }
      const heading = element('h3', title);
      const productLink = externalLink(title, variant.url);
      if (productLink) heading.replaceChildren(productLink);
      const description = [variant.seller?.name || merchant, options, variant.selected ? 'Linked variant' : ''];
      card.append(heading, element('p', description.filter(Boolean).join(' · '), 'muted'));
      const { price } = variant;
      if (price && /^[A-Z]{3}$/.test(price.currency) && Number.isFinite(Number(price.amount))) {
        card.append(element('p', money(price.amount, price.currency, !testLink), 'product-price'));
      }
      const item = { id, merchant, title, options, country, channel, currency: channel ? currency : undefined };
      if (id && canCheckout(item) && variant.availability?.available !== false) {
        const button = element('button', 'Add to cart', 'button secondary product-add');
        button.type = 'button';
        button.setAttribute('aria-label', `Add ${title}${options ? ` (${options})` : ''} to cart`);
        button.addEventListener('click', () => add(item));
        card.append(button);
      } else {
        card.append(element('p', variant.availability?.available === false ? 'Out of stock' : 'Checkout unavailable', 'muted'));
      }
      cards.push(card);
    }
  }
  $('results').replaceChildren(...cards);
  renderControls();
  return cards.length;
}

function firstItem() {
  return cart.values().next().value;
}

function items() {
  return Object.fromEntries(Array.from(cart, ([id, item]) => [id, item.quantity]).sort());
}

function sameItems() {
  const current = items();
  const stored = purchase?.items ?? {};
  return Object.keys(current).length === Object.keys(stored).length
    && Object.entries(current).every(([id, quantity]) => stored[id] === quantity);
}

function needsDelivery() {
  return purchase?.status === 'requires_action' && purchase.result?.reason === 'shipping_option_required';
}

function canEdit() {
  if (purchase?.channel === SHOP_CATALOG && (purchase.continue_url || purchase.quote)) return false;
  return !editing && (!purchase || ['draft', 'quoted', 'expired'].includes(purchase.status) || needsDelivery());
}

function add(item) {
  if (!token) return openConnection();
  if (!canEdit()) return selectionNotice('Wait for the current purchase or start a new cart.');
  if (!canCheckout(item)) return selectionNotice('Choose a Shopify catalog product or a configured test store.');
  if (item.channel && (item.channel === SHOP_CATALOG || item.currency !== undefined) && !/^[A-Z]{3}$/.test(item.currency)) {
    return selectionNotice('Enter a three-letter currency code.');
  }
  if (!/^[A-Z]{2}$/.test(item.country)) return selectionNotice('Enter a two-letter country code to add this product.');
  const existing = firstItem();
  const market = existing ?? purchase;
  if (market && (market.merchant !== item.merchant || market.country !== item.country
    || market.channel !== item.channel)) {
    return selectionNotice('Choose products from the same merchant, shipping country, and checkout type.');
  }
  if (market?.currency && item.channel && market.currency !== item.currency) {
    return selectionNotice('Choose products in the cart’s currency.');
  }
  const quantity = cart.get(item.id)?.quantity ?? 0;
  if (quantity === 100) return selectionNotice('Each variant can have a quantity of up to 100.');
  if (!quantity && cart.size === 50) return selectionNotice('A cart can contain up to 50 variants.');
  $('country').value = item.country;
  if (!existing && item.currency) $('currency').value = item.currency;
  previousCountry = item.country;
  cart.set(item.id, { ...item, quantity: quantity + 1 });
  selectionNotice(`Added ${item.title} to your cart.`, '');
  cartChanged();
}

function selectionNotice(text, className = 'notice') {
  $('selection-note').className = className || 'muted';
  message('selection-note', text);
}

function cartChanged() {
  shipping.clear();
  message('purchase-error');
  render();
}

function deliveryGroups() {
  return needsDelivery() && sameItems() ? purchase.result.delivery_options ?? {} : {};
}

function deliverySummary(quote) {
  return Object.entries(quote.shipping_options).map(([group, option]) => {
    const id = option.selected_option_id;
    return quote.delivery_options?.[group]?.find((choice) => choice.id === id)?.title || id;
  }).join(' · ');
}

function currentQuote() {
  if (!sameItems()) return;
  return purchase?.quote;
}

function canApprove() {
  const quote = currentQuote();
  return Boolean(token && !editing && !refreshing && purchase?.status === 'quoted' && quote?.expires_at > Date.now() / 1000
    && canCheckout(purchase) && Number.isSafeInteger(quote.minor_units) && !quote.amount_provisional
    && (purchase.channel !== SHOP_CATALOG || quote.payment_methods?.length));
}

function selectedPaymentMethod() {
  const id = $('payment-method').value;
  return currentQuote()?.payment_methods?.find((method) => method.id === id)?.id;
}

function renderControls() {
  const editable = canEdit();
  $('country').disabled = Boolean(cart.size || purchase || searching);
  $('currency').disabled = searching || Boolean((firstItem() ?? purchase)?.channel);
  $('search-button').disabled = searching;
  $('connection').disabled = editing || refreshing || searching;
  $('fixture-add').disabled = !editable;
  $('manual-add').disabled = !editable;
  for (const button of $('results').querySelectorAll('.product-add')) button.disabled = !editable;
  const choiceNeeded = Object.entries(deliveryGroups()).some(([group, choices]) => choices.length && !shipping.has(group));
  const quoteRetry = purchase?.channel === SHOP_CATALOG && purchase.status === 'failed'
    && purchase.result?.status === 'checkout_unavailable';
  $('quote-button').disabled = !token || editing || refreshing || !cart.size || choiceNeeded || (!editable && !quoteRetry);
  $('quote-button').hidden = (purchase?.channel === SHOP_CATALOG && !editable && !quoteRetry)
    || (purchase?.status === 'quoted' && currentQuote()?.expires_at > Date.now() / 1000);
  $('quote-button').textContent = quoteRetry ? 'Retry checkout quote' : 'Get checkout quote';
  const approvable = canApprove();
  $('review-button').hidden = !approvable;
  $('approve-submit').disabled = !approvable || (purchase.channel === SHOP_CATALOG && !selectedPaymentMethod());
  if (!approvable && $('approve-dialog').open) $('approve-dialog').close();
  $('refresh-button').disabled = !token || editing || refreshing;
  $('new-cart').disabled = editing || refreshing;
}

function renderCount() {
  $('cart-count').textContent = Array.from(cart.values()).reduce((count, item) => count + item.quantity, 0);
}

function renderCart() {
  const editable = canEdit();
  renderCount();
  $('cart-empty').hidden = Boolean(cart.size);
  const market = firstItem();
  message('cart-merchant', market ? [market.merchant, `Ships to ${market.country}`,
    market.channel ? market.currency : 'Test checkout'].filter(Boolean).join(' · ') : '');
  $('cart-items').replaceChildren(...Array.from(cart.values(), (item) => {
    const row = element('li', '', 'cart-item');
    const title = element('div');
    title.append(element('p', item.title), element('p', item.options || `Variant ${variantId(item.id)}`, 'muted'));
    const controls = element('div');
    if (editable) {
      const quantity = element('input');
      quantity.type = 'number';
      quantity.min = 1;
      quantity.max = 100;
      quantity.value = item.quantity;
      quantity.setAttribute('aria-label', `Quantity for ${item.title}`);
      quantity.addEventListener('change', () => {
        const next = quantity.valueAsNumber;
        if (!Number.isInteger(next) || next < 1 || next > 100) {
          quantity.value = item.quantity;
          return;
        }
        item.quantity = next;
        shipping.clear();
        message('purchase-error');
        renderCount();
        renderDelivery();
        renderCheckout();
        renderControls();
      });
      const remove = element('button', 'Remove', 'text-button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${item.title}`);
      remove.addEventListener('click', () => {
        cart.delete(item.id);
        selectionNotice('');
        cartChanged();
      });
      controls.append(quantity, remove);
    } else {
      controls.textContent = `Qty ${item.quantity}`;
    }
    row.append(title, controls);
    return row;
  }));
}

function renderDelivery() {
  const groups = Object.entries(deliveryGroups()).filter(([, options]) => options.length);
  $('delivery').replaceChildren(...groups.map(([group, options], index) => {
    const field = element('label', groups.length === 1 ? 'Delivery option' : `Delivery option ${index + 1}`, 'muted');
    const select = element('select');
    select.disabled = !canEdit();
    const prompt = element('option', 'Choose a delivery option');
    prompt.value = '';
    prompt.disabled = true;
    select.append(prompt);
    for (const option of options) {
      const row = element('option', [option.title || option.id, option.display_text].filter(Boolean).join(' · '));
      row.value = option.id;
      select.append(row);
    }
    select.value = shipping.get(group) || '';
    select.addEventListener('change', () => {
      shipping.set(group, select.value);
      renderControls();
    });
    field.append(select);
    return field;
  }));
}

function definition(container, title, value, className) {
  const details = element('dd', '', className);
  details.append(value);
  container.append(element('dt', title, className), details);
}

function trackingLabel(tracking) {
  const title = [tracking.company, tracking.number].filter(Boolean).join(' · ') || 'Track shipment';
  return externalLink(title, tracking.url) ?? title;
}

function renderQuoteDetails(quote) {
  const messages = $('quote-messages');
  messages.replaceChildren(...(quote?.messages ?? []).filter(({ content }) => content)
    .map(({ content }) => element('li', content)));
  messages.hidden = !messages.childElementCount;

  const links = $('quote-links');
  links.replaceChildren();
  for (const { title, type, url } of quote?.links ?? []) {
    const link = externalLink(title || label(type) || 'Merchant policy', url);
    if (!link) continue;
    const row = element('li');
    row.append(link);
    links.append(row);
  }
  links.hidden = !links.childElementCount;
}

function renderCheckout() {
  const quote = currentQuote();
  const orderId = receiptOrderId(purchase?.result);
  const phase = purchase?.status === 'submitted' && !orderId ? 'reconciliation_required' : purchase?.status;
  const native = purchase?.channel === SHOP_CATALOG;
  const merchantCheckout = native && phase === 'requires_action' && purchase.result?.reason === 'merchant_checkout';
  const continueUrl = merchantCheckout && httpsUrl(purchase.continue_url);
  let status = statusLabels[phase] ?? (cart.size ? 'Ready for quote' : 'Awaiting cart');
  let note = 'Get a quote to review the merchant’s total and delivery terms.';
  if (phase === 'preparing') note = 'The merchant is preparing your quote.';
  if (phase === 'submitting') note = 'Your approval was received. Waiting for the merchant’s response.';
  if (phase === 'submitted') note = 'The merchant returned an order receipt.';
  if (phase === 'failed') note = label(purchase.result?.reason ?? purchase.result?.status) || 'Checkout failed.';
  if (phase === 'reconciliation_required') note = 'The order is awaiting merchant confirmation. Check this purchase for updates.';
  if (phase === 'requires_action') {
    note = label(purchase.result?.reason ?? purchase.result?.status) || 'The merchant requires another action.';
    if (needsDelivery()) note = sameItems()
      ? 'Choose a delivery option and request an updated quote.'
      : 'Request a quote for the updated cart.';
  }
  if (merchantCheckout) {
    status = 'Shopify checkout';
    note = continueUrl ? 'Complete checkout on Shopify, then return here to refresh your order status.'
      : 'Refresh the purchase status to check for a Shopify checkout link.';
    if (quote?.amount_provisional) note += ' Shopify will confirm the final total during checkout.';
  }
  if (phase === 'expired' || (phase === 'quoted' && quote?.expires_at <= Date.now() / 1000)) {
    status = 'Quote expired';
    note = native ? 'Start a new cart for a fresh checkout quote.' : 'Request a fresh checkout quote to continue.';
  } else if (phase === 'quoted') {
    if (quote) {
      note = native ? 'Review the total and select a payment method to approve the order.'
        : `Review the total before approving this ${purchase.channel ? 'order' : 'test order'}.`;
    } else {
      status = 'Quote needs updating';
      note = 'Request an updated quote for your cart and delivery terms.';
    }
  }
  $('purchase-status').textContent = editing || status;
  $('purchase-status').dataset.state = phase ?? '';
  $('checkout-note').textContent = note;
  const continueLink = $('merchant-checkout');
  continueLink.hidden = !continueUrl;
  if (continueUrl) continueLink.href = continueUrl;
  else continueLink.removeAttribute('href');
  const totals = $('quote-totals');
  totals.replaceChildren();
  totals.hidden = !quote;
  const delivery = quote ? deliverySummary(quote) : '';
  if (delivery) definition(totals, 'Delivery', delivery);
  for (const total of quote?.totals ?? []) {
    const grandTotal = total.type === 'total';
    const name = grandTotal && quote.amount_provisional ? 'Estimated total' : total.display_text || label(total.type);
    definition(totals, name, money(grandTotal ? quote.minor_units : total.amount, quote.currency), grandTotal ? 'grand-total' : '');
  }
  renderQuoteDetails(quote);
  message('quote-expiry', phase === 'quoted' && quote?.expires_at ? `Quote expires ${timestamp(quote.expires_at)}` : '');
  const receipt = $('receipt');
  receipt.replaceChildren();
  receipt.hidden = phase !== 'submitted';
  if (phase === 'submitted') {
    definition(receipt, 'Merchant order', orderId);
    definition(receipt, 'Purchase ID', purchase.id);
    if (purchase.order_status) definition(receipt, 'Order status', label(purchase.order_status));
    for (const tracking of purchase.tracking ?? []) definition(receipt, 'Tracking', trackingLabel(tracking));
  }
  $('refresh-button').hidden = !purchase;
  $('new-cart').hidden = !purchase || ['preparing', 'submitting', 'reconciliation_required'].includes(phase);
  $('activity').hidden = !purchase;
  clearTimeout(expiryTimer);
  if (phase === 'quoted' && quote?.expires_at > Date.now() / 1000) {
    expiryTimer = setTimeout(() => { renderCheckout(); renderControls(); }, quote.expires_at * 1000 - Date.now());
  }
}

function render() {
  renderCart();
  renderDelivery();
  renderCheckout();
  renderControls();
}

function purchasePath(suffix = '') {
  return `/purchases/${encodeURIComponent(purchase.id)}${suffix}`;
}

async function readEvents() {
  const { events } = await request(purchasePath(`/events?after=${lastEvent}`));
  for (const event of events) {
    if (event.id <= lastEvent) continue;
    const row = element('li');
    const orderId = receiptOrderId(event.data?.result);
    const detail = label(event.data?.result?.reason ?? (orderId ? event.data?.order_status : ''));
    const type = event.type === 'submitted' && !orderId ? 'reconciliation_required' : event.type;
    const title = statusLabels[type] ?? label(type);
    row.append(element('span', [title, detail].filter(Boolean).join(' · ')), element('time', timestamp(event.created_at)));
    $('events').prepend(row);
    lastEvent = event.id;
  }
  $('event-note').hidden = $('events').childElementCount > 0;
}

function scheduleRefresh() {
  clearTimeout(statusTimer);
  if (token && ['preparing', 'submitting', 'reconciliation_required'].includes(purchase?.status)) {
    statusTimer = setTimeout(refresh, 4000);
  }
}

async function refresh() {
  if (!token || !purchase || editing || refreshing) return;
  clearTimeout(statusTimer);
  refreshing = true;
  renderControls();
  try {
    purchase = await request(purchasePath());
    await readEvents();
    message('purchase-error');
  } catch (error) {
    message('purchase-error', error.message);
  } finally {
    refreshing = false;
    render();
    scheduleRefresh();
  }
}

async function updatePurchase(inProgress, operation) {
  if (editing || refreshing) return;
  editing = inProgress;
  message('purchase-error');
  render();
  try {
    await operation();
    await readEvents();
  } catch (error) {
    message('purchase-error', error.message);
    if (purchase && token) {
      try {
        purchase = await request(purchasePath());
        await readEvents();
      } catch {
        // Keep the original failure and allow status refresh.
      }
    }
  } finally {
    editing = false;
    selectedQuote = undefined;
    render();
    scheduleRefresh();
  }
}

let fixtures = [];
$('connection').addEventListener('click', openConnection);
$('connect-cancel').addEventListener('click', () => $('connect-dialog').close());
$('connect-dialog').addEventListener('close', () => { $('token').value = ''; });
$('connect-dialog').addEventListener('cancel', (event) => {
  if ($('connect-submit').disabled) event.preventDefault();
});
$('connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const candidate = $('token').value.trim();
  if ($('connect-submit').disabled || !candidate) return;
  $('token').value = '';
  $('connect-submit').disabled = true;
  $('connect-cancel').disabled = true;
  message('connect-error');
  try {
    const response = await request('/purchase-merchants', 'GET', undefined, candidate);
    merchants.clear();
    for (const merchant of response.merchants) merchants.set(merchant.merchant, merchant);
    cardCheckout = response.card_checkout === true;
    token = candidate;
    fixtures = fixturesFromMerchants();
    $('connect-dialog').close();
    updateConnection();
    try {
      await resumePurchase();
    } catch (error) {
      message('purchase-error', error.message);
    }
    render();
    scheduleRefresh();
    $('query').focus();
  } catch (error) {
    message('connect-error', error.message);
    $('token').focus();
  } finally {
    $('connect-submit').disabled = false;
    $('connect-cancel').disabled = false;
  }
});

$('country').addEventListener('change', () => {
  const country = countryCode();
  const currency = $('currency');
  if (supportedMarkets[country] && (!currency.value || currency.value.toUpperCase() === supportedMarkets[previousCountry])) {
    currency.value = supportedMarkets[country];
  }
  previousCountry = country;
});

$('search').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!token) return openConnection();
  const query = $('query').value.trim();
  if (searching || !query) return;
  const country = countryCode();
  const currency = $('currency').value.trim().toUpperCase();
  searching = true;
  $('query-message').textContent = query;
  $('search-response').hidden = false;
  $('search-note').textContent = 'Searching the Shopify catalog…';
  $('results').replaceChildren();
  renderControls();
  try {
    const isLink = /^https?:\/\//i.test(query);
    const url = isLink ? httpsUrl(query) : undefined;
    if (isLink && !url) throw new Error('Enter an HTTPS Shopify product URL.');
    const testLink = url && merchantCanQuote(new URL(url).host);
    let data;
    if (testLink) {
      const product = await request('/purchase-products/resolve', 'POST', { url, country });
      const variants = product.variants.map((variant) => ({
        id: variant.variant_id,
        title: variant.title,
        seller: { domain: product.merchant },
        availability: { available: variant.available },
        selected: variant.selected,
        price: { amount: variant.price.amount, currency: variant.price.currencyCode },
      }));
      data = { products: [{ title: product.title, variants }] };
    } else if (url) {
      data = await request('/catalog/lookup', 'POST', { url, country, currency });
    } else {
      if (query.length > 256) throw new Error('Use up to 256 characters for a product search.');
      data = await request('/catalog/search', 'POST', { query, country, currency, limit: 8 });
    }
    const count = renderProducts(data.products, country, currency, testLink);
    $('search-note').textContent = count ? `${count} ${count === 1 ? 'result' : 'results'}` : 'No matching products found.';
    for (const item of data.messages ?? []) {
      if (item.type === 'warning' && item.content) $('search-note').append(element('span', ` · ${item.content}`));
    }
  } catch (error) {
    $('search-note').textContent = error.message;
  } finally {
    searching = false;
    renderControls();
  }
});

$('fixtures').addEventListener('submit', (event) => {
  event.preventDefault();
  const item = fixtures[$('fixture').selectedIndex];
  if (item) add(item);
});

$('manual').addEventListener('submit', (event) => {
  event.preventDefault();
  const merchant = $('merchant').value.trim().toLowerCase();
  const id = variantId($('variant').value);
  if (!id) return selectionNotice('Enter the numeric ID or GID of a Shopify product variant.');
  add({ id, merchant, country: countryCode(), title: `Variant ${id}` });
});

$('quote-button').addEventListener('click', () => updatePurchase('Preparing quote', async () => {
  const cartItems = items();
  if (!purchase) {
    const { merchant, country, channel, currency } = firstItem();
    const body = { merchant, country, items: cartItems };
    if (channel) Object.assign(body, { channel, currency });
    const signature = JSON.stringify(body);
    if (pendingCreate?.signature !== signature) pendingCreate = { signature, id: crypto.randomUUID() };
    purchase = await request('/purchases', 'POST', { request_id: pendingCreate.id, ...body });
    pendingCreate = undefined;
    rememberPurchase();
  } else if (!sameItems()) {
    purchase = await request(purchasePath('/cart'), 'PUT', { items: cartItems });
  }
  const options = needsDelivery() ? Object.fromEntries(Array.from(shipping, ([group, id]) => [group, { selected_option_id: id }])) : {};
  purchase = await request(purchasePath('/quote'), 'POST', Object.keys(options).length ? { shipping_options: options } : {});
  shipping.clear();
}));

$('review-button').addEventListener('click', () => {
  if (!canApprove()) return;
  const quote = currentQuote();
  selectedQuote = quote.id;
  const quantity = $('cart-count').textContent;
  $('approve-summary').textContent = [`${quantity} ${quantity === '1' ? 'item' : 'items'} from ${purchase.merchant}`, `Ships to ${purchase.country}`, deliverySummary(quote)].filter(Boolean).join(' · ');
  $('approve-amount').textContent = money(quote.minor_units, quote.currency);
  const native = purchase.channel === SHOP_CATALOG;
  $('approve-title').textContent = purchase.channel ? 'Approve this order' : 'Approve this test order';
  $('approve-submit').textContent = purchase.channel ? 'Approve & place order' : 'Approve & place test order';
  $('payment-method-field').hidden = !native;
  const paymentMethod = $('payment-method');
  const prompt = new Option('Choose a payment method', '');
  prompt.disabled = true;
  paymentMethod.replaceChildren(prompt, ...(native ? quote.payment_methods.map(({ id, label }) => new Option(label, id)) : []));
  paymentMethod.value = '';
  paymentMethod.required = native;
  renderControls();
  $('approve-dialog').showModal();
});

$('approve-cancel').addEventListener('click', () => $('approve-dialog').close());
$('approve-dialog').addEventListener('close', () => { if (!editing) selectedQuote = undefined; });
$('payment-method').addEventListener('change', renderControls);
$('approve-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!canApprove() || selectedQuote !== currentQuote().id) return;
  const body = { quote_id: selectedQuote };
  if (purchase.channel === SHOP_CATALOG) {
    const paymentMethod = selectedPaymentMethod();
    if (!paymentMethod) return;
    body.payment_method_id = paymentMethod;
  }
  $('approve-dialog').close();
  updatePurchase('Submitting order', async () => { purchase = await request(purchasePath('/confirm'), 'POST', body); });
});

$('refresh-button').addEventListener('click', refresh);
$('new-cart').addEventListener('click', () => {
  purchase = undefined;
  rememberPurchase();
  pendingCreate = undefined;
  lastEvent = 0;
  cart.clear();
  $('events').replaceChildren();
  $('event-note').hidden = false;
  selectionNotice('');
  cartChanged();
});
