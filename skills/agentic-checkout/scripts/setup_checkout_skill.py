#!/usr/bin/env python3
"""One-command setup for checkout runtime and optional profile creation."""

from __future__ import annotations

import argparse
import platform
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_ROOT = SCRIPT_DIR.parent
PROFILE_SETUP = SCRIPT_DIR / "setup_checkout_profile.py"
VENV_DIR = SKILL_ROOT / ".venv"


def run_command(command: list[str]) -> None:
    completed = subprocess.run(command, cwd=str(SKILL_ROOT), check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"Command failed with exit code {completed.returncode}: {' '.join(command)}")


def ensure_runtime(venv_dir: Path) -> Path:
    if not venv_dir.exists():
        try:
            run_command([sys.executable, "-m", "venv", str(venv_dir)])
        except RuntimeError as exc:
            raise RuntimeError(
                "Python virtualenv bootstrap failed. "
                "If this is a fresh Docker/OpenClaw environment, install the base runtime first with: "
                "apt-get update && apt-get install -y python3-pip python3-venv xauth"
            ) from exc
    python_bin = venv_dir / "bin" / "python"
    if not python_bin.exists():
        raise RuntimeError(f"Virtualenv python not found: {python_bin}")
    run_command([str(python_bin), "-m", "pip", "install", "-r", "requirements.txt"])
    install_command = [str(python_bin), "-m", "playwright", "install", "chromium"]
    if platform.system().lower() == "linux" and hasattr(sys, "getuid") and sys.getuid() == 0:
        install_command = [str(python_bin), "-m", "playwright", "install", "--with-deps", "chromium"]
    try:
        run_command(install_command)
    except RuntimeError as exc:
        raise RuntimeError(
            "Playwright browser install failed. "
            "If system libraries are missing, run: python3 -m playwright install --with-deps chromium"
        ) from exc
    return python_bin


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Install checkout skill runtime upfront and optionally collect payment, delivery, and billing profile data."
    )
    parser.add_argument("--skip-runtime", action="store_true", help="Skip venv / pip / Playwright setup.")
    parser.add_argument("--skip-profile", action="store_true", help="Skip the interactive profile collection flow.")
    parser.add_argument("--venv-dir", default=str(VENV_DIR))
    parser.add_argument("--profile-output", default=str(Path.home() / ".clawdbot" / "credentials" / "real_card.json"))
    parser.add_argument("--country", default="United States")
    parser.add_argument("--overwrite-profile", action="store_true")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        if not args.skip_runtime:
            python_bin = ensure_runtime(Path(args.venv_dir).expanduser())
            print(f"Checkout runtime ready: {python_bin}", flush=True)
        if not args.skip_profile:
            command = [
                sys.executable,
                str(PROFILE_SETUP),
                "--output",
                str(Path(args.profile_output).expanduser()),
                "--country",
                str(args.country),
            ]
            if args.overwrite_profile:
                command.append("--overwrite")
            run_command(command)
    except Exception as exc:
        print(str(exc), file=sys.stderr, flush=True)
        return 1

    print("Checkout skill setup complete.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
