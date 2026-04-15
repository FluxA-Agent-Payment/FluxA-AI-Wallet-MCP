#!/usr/bin/env python3
"""Operator-visible execute demo for the checkout handoff skill."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_ROOT = SCRIPT_DIR.parent
RUNNER = SCRIPT_DIR / "checkout_playwright_handoff.py"

DEFAULT_ENTRY_URL = "https://gracie-designs.myshopify.com/products/gift-card"
DEFAULT_OUT_DIR = SKILL_ROOT / "artifacts" / "execute-demo-headed"
DEFAULT_SECRETS_CANDIDATES = [
    Path.home() / ".clawdbot" / "credentials" / "kofi_tip_demo.json",
    Path.home() / ".clawdbot" / "credentials" / "shopify_giftcard_demo.json",
    Path.home() / ".clawdbot" / "credentials" / "buy_coffee_demo.json",
]


def default_secrets_path() -> str:
    for candidate in DEFAULT_SECRETS_CANDIDATES:
        if candidate.exists():
            return str(candidate)
    return str(DEFAULT_SECRETS_CANDIDATES[0])


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the execute-mode, headed checkout demo with visible browser automation."
    )
    parser.add_argument("--entry-url", default=DEFAULT_ENTRY_URL)
    parser.add_argument("--secrets-path", default=default_secrets_path())
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--browser-channel", default=None)
    parser.add_argument("--max-total-usd", type=float, default=10.0)
    parser.add_argument("--max-run-seconds", type=int, default=600)
    parser.add_argument("--keep-open-seconds", type=float, default=30.0)
    parser.add_argument("--record-trace", action="store_true", default=False)
    parser.add_argument("--no-record-trace", dest="record_trace", action="store_false")
    parser.add_argument("--record-video", action="store_true")
    parser.add_argument("--print-only", action="store_true", help="Print the resolved command without running it.")
    return parser


def build_command(args: argparse.Namespace) -> list[str]:
    command = [
        sys.executable,
        str(RUNNER),
        "--entry-url",
        str(args.entry_url),
        "--mode",
        "execute",
        "--secrets-path",
        str(args.secrets_path),
        "--out-dir",
        str(args.out_dir),
        "--headed",
        "--max-total-usd",
        str(args.max_total_usd),
        "--max-run-seconds",
        str(args.max_run_seconds),
        "--keep-open-seconds",
        str(args.keep_open_seconds),
    ]
    if args.browser_channel:
        command.extend(["--browser-channel", str(args.browser_channel)])
    if args.record_trace:
        command.append("--record-trace")
    if args.record_video:
        command.append("--record-video")
    return command


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    secrets_path = Path(args.secrets_path).expanduser()
    if not secrets_path.exists():
        looked_in = ", ".join(str(path) for path in DEFAULT_SECRETS_CANDIDATES)
        parser.error(
            f"Secrets file not found: {secrets_path}. "
            f"Looked for demo credentials in: {looked_in}"
        )

    command = build_command(args)
    print("Running headed execute demo:", flush=True)
    print(" ".join(command), flush=True)

    if args.print_only:
        return 0

    completed = subprocess.run(command, cwd=str(SKILL_ROOT), check=False)
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
