# Roadmap

Use this file when the user asks what is planned next.

## Planned next

### 1. More merchant adapters

- Broaden support beyond standard Shopify pages.
- Add explicit adapters for other common checkout stacks instead of relying on generic heuristics.

### 2. More payment providers

- Expand beyond current Shopify card checkout and Stripe checkout support.
- Add first-class adapters for providers such as Adyen, Braintree, and other hosted-card surfaces when they are validated.

### 3. Stronger pre-checkout navigation

- Improve generic storefront traversal before the checkout surface opens.
- Add reusable logic for common product option selection, cart review, and shipping-step transitions.

### 4. Better operator handoff

- Preserve richer resumable state so a human can take over without restarting from the homepage.
- Capture more precise handoff reasons and suggested next actions in the result payload.

### 5. Broader verification handling

- Distinguish CAPTCHA, login walls, OTP, issuer 3DS, and merchant-specific review steps more cleanly.
- Add pause-and-resume workflows around those verification checkpoints.
