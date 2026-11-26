"""Build the E2B template for the hosted Shopify checkout worker."""

import sys
from hashlib import sha256
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
SOURCE_MARKER = "/opt/checkout/checkout-source.sha256"
SERVICE_MODULES = ("buyer", "contract", "observation", "one_page", "worker", "preview", "purchase_worker")
SKILL = Path(__file__).resolve().parents[2]


def source_digest() -> str:
    digest = sha256(IMAGE.encode())
    files = [SKILL / "requirements-browser.txt", *(SKILL / "scripts/shopify").rglob("*.py")]
    files.extend(SKILL / "scripts/checkout_service" / f"{module}.py" for module in SERVICE_MODULES)
    for file in sorted(files):
        digest.update(str(file.relative_to(SKILL)).encode() + b"\0" + sha256(file.read_bytes()).digest())
    return digest.hexdigest()


def build(name: str) -> str:
    template = (
        Template(file_context_path=SKILL)
        .from_image(IMAGE)
        .set_user("root")
        .set_workdir("/opt/checkout")
        .copy("requirements-browser.txt", "/opt/checkout/")
        .run_cmd("/usr/bin/python3 -m pip install --no-cache-dir -r requirements-browser.txt")
        .copy("scripts/shopify", "/opt/checkout/shopify")
    )
    for module in SERVICE_MODULES:
        template = template.copy(f"scripts/checkout_service/{module}.py", "/opt/checkout/checkout_service/")
    template = (template.run_cmd(f"echo {source_digest()} > {SOURCE_MARKER}")
                .set_envs(WORKER_ENV).set_user("pwuser"))
    info = Template.build(template, name, cpu_count=2, memory_mb=2048, on_build_logs=print)
    return f"{name.rsplit(':', 1)[0]}:{info.build_id}"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m checkout_service.template TEAM/fluxa-shopify-checkout")
    print(build(sys.argv[1]))
