#!/usr/bin/env python3
"""Shared Playwright helpers for Shopify payment adapters."""

from __future__ import annotations

from typing import Any, Callable
import asyncio
import re
import sys


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def digits(value: Any) -> str:
    return re.sub(r"\D+", "", str(value or ""))


async def pause(config: Any, seconds: float | None = None) -> None:
    delay = seconds if seconds is not None else float(getattr(config, "action_delay_seconds", 0) or 0)
    if delay > 0:
        await asyncio.sleep(delay)


def _select_all_shortcut() -> str:
    return "Meta+A" if sys.platform == "darwin" else "Control+A"


async def _iter_contexts(page: Any) -> list[Any]:
    contexts = [page]
    try:
        for frame in page.frames:
            if frame == page.main_frame:
                continue
            contexts.append(frame)
    except Exception:
        pass
    return contexts


async def _read_locator_value(locator: Any) -> str:
    try:
        value = await locator.input_value()
    except Exception:
        value = ""
    if normalize_text(value):
        return normalize_text(value)
    try:
        raw = await locator.evaluate(
            """(el) => {
                if (!el) return "";
                const value = "value" in el ? el.value : "";
                if (value) return value;
                return el.textContent || "";
            }"""
        )
    except Exception:
        raw = ""
    return normalize_text(raw)


async def _looks_like_autocomplete(locator: Any) -> bool:
    try:
        role = normalize_text(await locator.get_attribute("role")).lower()
        aria_autocomplete = normalize_text(await locator.get_attribute("aria-autocomplete")).lower()
        aria_haspopup = normalize_text(await locator.get_attribute("aria-haspopup")).lower()
        if role == "combobox" or aria_autocomplete in {"list", "both"} or aria_haspopup == "listbox":
            return True
    except Exception:
        return False
    return False


async def _is_interactable(locator: Any) -> bool:
    try:
        if not await locator.is_visible() or not await locator.is_enabled():
            return False
    except Exception:
        return False
    try:
        aria_hidden = normalize_text(await locator.get_attribute("aria-hidden")).lower()
        field_type = normalize_text(await locator.get_attribute("type")).lower()
        readonly = normalize_text(await locator.get_attribute("readonly")).lower()
        if aria_hidden == "true" or field_type == "hidden" or readonly in {"true", "readonly"}:
            return False
    except Exception:
        return False
    return True


async def fill_text_exact(
    locator: Any,
    value: str,
    config: Any,
    verifier: Callable[[str], bool] | None = None,
    commit_autocomplete: bool = False,
) -> bool:
    target = str(value)
    verify = verifier or (lambda raw: normalize_text(raw) == normalize_text(target))
    for _attempt in range(3):
        try:
            await locator.scroll_into_view_if_needed(timeout=2000)
        except Exception:
            pass
        try:
            await locator.click(timeout=3000)
        except Exception:
            pass
        try:
            await locator.press(_select_all_shortcut())
            await locator.press("Backspace")
        except Exception:
            pass
        try:
            await locator.fill("")
        except Exception:
            pass
        try:
            await locator.type(target, delay=35)
        except Exception:
            try:
                await locator.fill(target)
            except Exception:
                pass
        await pause(config, 0.2)
        current = await _read_locator_value(locator)
        if verify(current):
            return True
        if commit_autocomplete and await _looks_like_autocomplete(locator):
            for key in ("ArrowDown", "Enter", "Tab"):
                try:
                    await locator.press(key)
                except Exception:
                    continue
                await pause(config, 0.25)
                current = await _read_locator_value(locator)
                if verify(current):
                    return True
    return False


async def fill_first_matching(
    page: Any,
    selectors: list[str],
    value: str,
    verifier: Callable[[str], bool],
    config: Any,
    timeout_seconds: int = 20,
    commit_autocomplete: bool = False,
) -> tuple[bool, str]:
    deadline = asyncio.get_running_loop().time() + max(timeout_seconds, 1)
    last_value = ""
    while asyncio.get_running_loop().time() < deadline:
        for context in await _iter_contexts(page):
            for selector in selectors:
                try:
                    locator = context.locator(selector)
                    count = min(await locator.count(), 8)
                except Exception:
                    continue
                for index in range(count):
                    candidate = locator.nth(index)
                    if not await _is_interactable(candidate):
                        continue
                    if await fill_text_exact(
                        candidate,
                        value,
                        config,
                        verifier=verifier,
                        commit_autocomplete=commit_autocomplete,
                    ):
                        last_value = await _read_locator_value(candidate)
                        if verifier(last_value):
                            return True, last_value
        await asyncio.sleep(0.25)
    return False, last_value


async def select_first_matching(
    page: Any,
    selectors: list[str],
    values: list[str],
    timeout_seconds: int = 10,
) -> bool:
    targets = [normalize_text(value) for value in values if normalize_text(value)]
    if not targets:
        return False
    deadline = asyncio.get_running_loop().time() + max(timeout_seconds, 1)
    while asyncio.get_running_loop().time() < deadline:
        for context in await _iter_contexts(page):
            for selector in selectors:
                try:
                    locator = context.locator(selector)
                    count = min(await locator.count(), 6)
                except Exception:
                    continue
                for index in range(count):
                    candidate = locator.nth(index)
                    if not await _is_interactable(candidate):
                        continue
                    for target in targets:
                        for mode in ("label", "value"):
                            try:
                                await candidate.select_option(timeout=2000, **{mode: target})
                                return True
                            except Exception:
                                continue
        await asyncio.sleep(0.25)
    return False


async def click_first_visible(page: Any, selectors: list[str], timeout_ms: int = 3000) -> bool:
    for selector in selectors:
        try:
            locator = page.locator(selector)
            count = min(await locator.count(), 8)
        except Exception:
            continue
        for index in range(count):
            candidate = locator.nth(index)
            if not await _is_interactable(candidate):
                continue
            try:
                try:
                    await candidate.scroll_into_view_if_needed(timeout=2000)
                except Exception:
                    pass
                await candidate.click(timeout=timeout_ms)
                return True
            except Exception:
                try:
                    await candidate.click(timeout=timeout_ms, force=True)
                    return True
                except Exception:
                    continue
    return False


async def visible_button_texts(page: Any) -> list[str]:
    texts: list[str] = []
    try:
        locator = page.locator("button, [role='button'], input[type='submit']")
        count = min(await locator.count(), 20)
    except Exception:
        return texts
    for index in range(count):
        try:
            candidate = locator.nth(index)
            if not await candidate.is_visible():
                continue
            text = normalize_text(await candidate.inner_text())
            if not text:
                try:
                    text = normalize_text(await candidate.get_attribute("value"))
                except Exception:
                    text = ""
            if text:
                texts.append(text)
        except Exception:
            continue
    return texts


async def iframe_urls(page: Any) -> list[str]:
    values: list[str] = []
    try:
        for frame in page.frames:
            if frame == page.main_frame:
                continue
            if frame.url:
                values.append(frame.url)
    except Exception:
        pass
    return values


CHECKBOX_STATE_SCRIPT = """(payload) => {
  const { phrases, desiredState } = payload;
  const normalize = (text) => String(text || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const visible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const labelledByText = (node) => {
    const ids = String(node?.getAttribute?.('aria-labelledby') || '').trim().split(/\\s+/).filter(Boolean);
    return ids
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((el) => el.innerText || el.textContent || '')
      .join(' ');
  };
  const relatedNodes = (box) => {
    const nodes = [];
    const push = (node) => {
      if (!node || nodes.includes(node)) return;
      nodes.push(node);
    };
    push(box);
    const id = box.getAttribute && box.getAttribute('id');
    if (id) push(document.querySelector(`label[for="${id}"]`));
    push(box.closest && box.closest('label'));
    push(box.nextElementSibling);
    push(box.previousElementSibling);
    let current = box.parentElement;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      push(current);
    }
    return nodes;
  };
  const combinedText = (box) => {
    return relatedNodes(box)
      .map((node) => [node.innerText || node.textContent || '', labelledByText(node)].filter(Boolean).join(' '))
      .filter(Boolean)
      .join(' ');
  };
  const matches = (box) => {
    const hay = normalize(combinedText(box));
    return hay && phrases.some((phrase) => hay.includes(phrase));
  };
  const isChecked = (box) => {
    if ('checked' in box) return !!box.checked;
    return box.getAttribute('aria-checked') === 'true';
  };
  const interact = (node) => {
    if (!node || typeof node.click !== 'function') return;
    node.click();
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const setChecked = (box, shouldCheck) => {
    if (isChecked(box) === shouldCheck) return isChecked(box);
    for (const node of relatedNodes(box)) {
      if (!visible(node) && node !== box) continue;
      interact(node);
      if (isChecked(box) === shouldCheck) return true;
    }
    interact(box);
    return isChecked(box) === shouldCheck;
  };
  for (const box of Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]'))) {
    if (!matches(box)) continue;
    const visibleNodes = relatedNodes(box).filter((node) => visible(node));
    if (!visibleNodes.length && !visible(box)) continue;
    let checked = isChecked(box);
    if (desiredState !== null && checked !== desiredState) {
      setChecked(box, desiredState);
      checked = isChecked(box);
    }
    return JSON.stringify({ found: true, checked });
  }
  return JSON.stringify({ found: false, checked: null });
}"""


async def disable_save_info(page: Any, phrases: list[str], config: Any) -> bool | None:
    phrases = [normalize_text(phrase).lower() for phrase in phrases]
    for context in await _iter_contexts(page):
        try:
            raw = await context.evaluate(CHECKBOX_STATE_SCRIPT, {"phrases": phrases, "desiredState": False})
        except Exception:
            continue
        lowered = normalize_text(raw)
        if not lowered:
            continue
        if "\"unchecked\": true" in lowered.lower():
            await pause(config, 0.2)
            return True
        if "\"unchecked\": false" in lowered.lower():
            return False
    return None


async def ensure_checkbox_state(page: Any, phrases: list[str], config: Any, should_check: bool) -> bool | None:
    normalized_phrases = [normalize_text(phrase).lower() for phrase in phrases if normalize_text(phrase)]
    for context in await _iter_contexts(page):
        try:
            raw = await context.evaluate(
                CHECKBOX_STATE_SCRIPT,
                {"phrases": normalized_phrases, "desiredState": bool(should_check)},
            )
        except Exception:
            continue
        lowered = normalize_text(raw)
        if not lowered:
            continue
        if "\"found\": false" in lowered.lower():
            continue
        await pause(config, 0.2)
        if "\"checked\": true" in lowered.lower():
            return True
        if "\"checked\": false" in lowered.lower():
            return False
    return None
