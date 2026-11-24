"""Build the E2B template for the hosted Shopify checkout worker."""

import sys
from pathlib import Path

from e2b import Template

IMAGE = (
    "mcr.microsoft.com/playwright/python:v1.64.1-noble"
    "@sha256:330d401ae23c905896a0c26c66c36fc971b621519e7b11b435a8328d7bf6e031"
)
WORKER_ENV = {
    "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright",
    "PYTHONNOUSERSITE": "1",
    "PYTHONDONTWRITEBYTECODE": "1",
}


def build(name: str) -> str:
    skill = Path(__file__).resolve().parents[2]
    template = (
        Template(file_context_path=skill)
        .from_image(IMAGE)
        .set_user("root")
        .set_workdir("/opt/checkout")
        .copy("requirements-browser.txt", "/opt/checkout/")
        .run_cmd("/usr/bin/python3 -m pip install --no-cache-dir -r requirements-browser.txt")
        .copy("scripts/shopify", "/opt/checkout/shopify")
        .copy("scripts/checkout_service/buyer.py", "/opt/checkout/checkout_service/")
        .copy("scripts/checkout_service/contract.py", "/opt/checkout/checkout_service/")
        .copy("scripts/checkout_service/observation.py", "/opt/checkout/checkout_service/")
        .copy("scripts/checkout_service/one_page.py", "/opt/checkout/checkout_service/")
        .copy("scripts/checkout_service/worker.py", "/opt/checkout/checkout_service/")
        .copy("scripts/checkout_service/preview.py", "/opt/checkout/checkout_service/")
        .set_envs(WORKER_ENV)
        .set_user("pwuser")
    )
    info = Template.build(template, name, cpu_count=2, memory_mb=2048, on_build_logs=print)
    return f"{name.rsplit(':', 1)[0]}:{info.build_id}"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m checkout_service.template TEAM/fluxa-shopify-checkout")
    print(build(sys.argv[1]))
