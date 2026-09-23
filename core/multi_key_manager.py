"""
multi_key_manager.py — API Key Rotation for MARK LIII
======================================================
Multiplies the effective free-tier rate limit by round-robining
across multiple Gemini API keys. Three keys = 45 RPM instead of 15.

Keys are stored in config/api_keys.json under "gemini_api_keys" (list)
or as the legacy single "gemini_api_key" string.

Usage
-----
    from core.multi_key_manager import get_key, report_quota_hit

    key = get_key()          # next available key
    client = genai.Client(api_key=key)
    ...
    report_quota_hit(key)    # mark exhausted, skip for ~60s

The manager is thread-safe and works from any thread/async context.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path


def _base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent


_CONFIG = _base_dir() / "config" / "api_keys.json"

# How long (seconds) to skip a key after it hits 429 / quota exhausted
_COOLDOWN = 65.0


class _KeyManager:
    """Thread-safe round-robin key manager with per-key cooldown."""

    def __init__(self):
        self._lock    = threading.Lock()
        self._keys: list[str] = []
        self._cooldown: dict[str, float] = {}   # key → resume_at timestamp
        self._idx     = 0
        self._loaded  = False

    # ── loading ────────────────────────────────────────────────────────────────
    def _load(self) -> None:
        try:
            cfg = json.loads(_CONFIG.read_text(encoding="utf-8"))
        except Exception:
            cfg = {}

        keys: list[str] = []

        # New format: list of keys
        multi = cfg.get("gemini_api_keys", [])
        if isinstance(multi, list):
            keys.extend(k.strip() for k in multi if k.strip())

        # Legacy format: single key
        single = cfg.get("gemini_api_key", "").strip()
        if single and single not in keys:
            keys.append(single)

        self._keys   = keys
        self._loaded = True
        if keys:
            print(f"[KeyMgr] {len(keys)} Gemini key(s) loaded "
                  f"(effective free RPM ~= {len(keys) * 15})")

    def _ensure_loaded(self) -> None:
        if not self._loaded:
            self._load()

    # ── public API ─────────────────────────────────────────────────────────────
    def get_key(self, reload: bool = False) -> str:
        """Return the next available key (round-robin, skipping cooled-down keys)."""
        with self._lock:
            if reload or not self._loaded:
                self._load()

            if not self._keys:
                return ""

            now = time.monotonic()
            # Try each key in round-robin order, skip if in cooldown
            for _ in range(len(self._keys)):
                key = self._keys[self._idx % len(self._keys)]
                self._idx += 1
                resume_at = self._cooldown.get(key, 0)
                if now >= resume_at:
                    return key

            # All keys in cooldown — return the one with the shortest wait
            best = min(self._keys, key=lambda k: self._cooldown.get(k, 0))
            wait = max(0, self._cooldown.get(best, 0) - now)
            if wait > 0:
                print(f"[KeyMgr] All keys in cooldown — waiting {wait:.1f}s")
                time.sleep(wait + 0.5)
            return best

    def report_quota_hit(self, key: str, cooldown: float = _COOLDOWN) -> None:
        """Call this when a key returns HTTP 429. It will be skipped for `cooldown` seconds."""
        with self._lock:
            self._cooldown[key] = time.monotonic() + cooldown
            print(f"[KeyMgr] Key ...{key[-6:]} quota hit — cooling down {cooldown:.0f}s")

    def report_error(self, key: str) -> None:
        """Call on any non-quota API error — shorter cooldown."""
        self.report_quota_hit(key, cooldown=10.0)

    def all_keys(self) -> list[str]:
        with self._lock:
            self._ensure_loaded()
            return list(self._keys)

    def key_count(self) -> int:
        with self._lock:
            self._ensure_loaded()
            return len(self._keys)

    def add_key(self, key: str) -> bool:
        """Add a new key at runtime and persist it to config."""
        key = key.strip()
        if not key:
            return False
        with self._lock:
            self._ensure_loaded()
            if key in self._keys:
                return False
            self._keys.append(key)
            self._persist()
            print(f"[KeyMgr] New key added — now {len(self._keys)} key(s)")
            return True

    def _persist(self) -> None:
        try:
            cfg = json.loads(_CONFIG.read_text(encoding="utf-8"))
        except Exception:
            cfg = {}
        cfg["gemini_api_keys"] = self._keys
        # Keep legacy single key in sync (first key)
        if self._keys:
            cfg["gemini_api_key"] = self._keys[0]
        _CONFIG.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


# ── Singleton ──────────────────────────────────────────────────────────────────
_mgr = _KeyManager()


def get_key(reload: bool = False) -> str:
    """Get the next available Gemini API key."""
    return _mgr.get_key(reload=reload)


def report_quota_hit(key: str) -> None:
    """Mark a key as quota-exhausted (HTTP 429)."""
    _mgr.report_quota_hit(key)


def report_error(key: str) -> None:
    """Mark a key as errored (short cooldown)."""
    _mgr.report_error(key)


def add_key(key: str) -> bool:
    """Add a new API key at runtime."""
    return _mgr.add_key(key)


def all_keys() -> list[str]:
    return _mgr.all_keys()


def key_count() -> int:
    return _mgr.key_count()


def call_with_retry(fn, *args, max_retries: int = 3, **kwargs):
    """
    Call `fn(api_key, *args, **kwargs)` with automatic key rotation on quota errors.
    fn must accept `api_key` as its first argument.

    Example:
        result = call_with_retry(my_api_function, prompt, model="gemini-flash")
    """
    last_err = None
    for attempt in range(max_retries * key_count() or max_retries):
        key = get_key()
        if not key:
            raise RuntimeError("No Gemini API keys configured.")
        try:
            return fn(key, *args, **kwargs)
        except Exception as e:
            err_str = str(e)
            if "429" in err_str or "RESOURCE_EXHAUSTED" in err_str or "quota" in err_str.lower():
                report_quota_hit(key)
                last_err = e
                continue
            raise
    raise last_err or RuntimeError("All retries exhausted.")
