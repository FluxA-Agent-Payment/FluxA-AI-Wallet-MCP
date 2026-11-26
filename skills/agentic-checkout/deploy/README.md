# FluxA Shopify checkout pilot

Run one container on the FluxA host. Use the Docker Engine already installed on Amazon Linux 2023. The image pins Python 3.12 and leaves the Amazon Linux system Python in place. Docker supervises the container, publishes its HTTP port on the host loopback interface, and keeps the receipt database in a dedicated host directory. The browser runs in the pinned E2B template. [Amazon Linux Python](https://docs.aws.amazon.com/linux/al2023/ug/python.html) · [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/) · [Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/)

Build the deployment image from a Git revision so the context contains only tracked source. From the repository root:

```sh
revision=$(git rev-parse HEAD)
context=$(mktemp -d)
git archive "$revision" skills/agentic-checkout | tar -xf - -C "$context"
docker build --label "org.opencontainers.image.revision=$revision" \
  -f "$context/skills/agentic-checkout/deploy/Dockerfile" \
  -t "fluxa-shopify-checkout:$revision" "$context/skills/agentic-checkout"
```

Keep `/etc/fluxa-shopify-checkout/runtime.env` readable only by root. Set `E2B_API_KEY`, `CHECKOUT_SERVICE_TOKEN`, `CHECKOUT_E2B_TEMPLATE`, and `CHECKOUT_PREVIEW_STORES` per the [service reference](../references/shopify-e2b-service.md). Omit `CHECKOUT_TEST_URL` to disable all submissions. Create the host state directory with owner UID and GID `10001` and mode `0700`. Preserve this directory across container replacement.

```sh
docker run -d --name fluxa-shopify-checkout --restart unless-stopped \
  --publish 127.0.0.1:8080:8080 --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec \
  --cap-drop ALL --security-opt no-new-privileges \
  --env-file /etc/fluxa-shopify-checkout/runtime.env \
  --mount type=bind,source=/var/lib/fluxa-shopify-checkout,target=/var/lib/fluxa-checkout \
  "fluxa-shopify-checkout:$revision"
```

After start, confirm the image revision and loopback port binding. Call the authenticated catalog and preview routes and verify that the checkout submission route returns HTTP 403. A running container confirms process startup. An E2B preview confirms the configured browser template and its runtime access.

## Shopify webhook tunnel

Create a dedicated remotely managed tunnel in the Cloudflare account that owns `fluxapay.xyz`. Use [cloudflare-ingress.json](cloudflare-ingress.json) as its ingress configuration. Validate the file from the skill directory with `cloudflared tunnel --config deploy/cloudflare-ingress.json ingress validate`. Install [cloudflared-fluxa-checkout.service](cloudflared-fluxa-checkout.service) as a separate systemd unit. Place the tunnel-scoped connector token at `/etc/fluxa-shopify-checkout/cloudflare-token` with root ownership and mode `0600` before enabling the unit. Verify connector readiness at `http://127.0.0.1:17881/ready`. A connector can become healthy before the DNS record exists. [Cloudflare Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/) · [Connector monitoring](https://developers.cloudflare.com/tunnel/monitoring/)

The DNS owner can then add `checkout.fluxapay.xyz` as a proxied CNAME to the tunnel UUID's `.cfargotunnel.com` address. The ingress rule forwards the exact webhook path. FastAPI accepts POST and verifies Shopify's HMAC when the test shop and app secret are configured. The host binding keeps the rest of the API private. [Shopify webhook verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries)
