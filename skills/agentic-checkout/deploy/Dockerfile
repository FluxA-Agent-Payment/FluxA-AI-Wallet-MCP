FROM python:3.12-slim-bookworm@sha256:44cf1793efa7c7a476bb0f2cff81443f4a072c90c1cb127e2924933daa3e8c64

WORKDIR /srv/fluxa-checkout
ENV PYTHONPATH=/srv/fluxa-checkout/scripts \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CHECKOUT_ATTEMPTS_DB=/var/lib/fluxa-checkout/attempts.sqlite3

COPY requirements-service.txt requirements-browser.txt ./
RUN python -m pip install --no-cache-dir -r requirements-service.txt \
    && install -d -m 0700 -o 10001 -g 10001 /var/lib/fluxa-checkout

COPY scripts/shopify/ scripts/shopify/
COPY scripts/checkout_service/ scripts/checkout_service/
COPY demo/ demo/

USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
    CMD ["python", "-c", "from urllib.request import urlopen; urlopen('http://127.0.0.1:8080/openapi.json', timeout=2).close()"]
CMD ["python", "-m", "uvicorn", "checkout_service.smoke:app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--no-proxy-headers"]
