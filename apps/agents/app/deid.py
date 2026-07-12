"""Prompt de-identification (F2 — BAA blocker #1).

Every LLM call scrubs direct identifiers before the prompt leaves the process
and re-hydrates them in the structured output afterwards, so the model never
sees a real name, phone number, or email — it reasons over stable tokens like
[PATIENT_7] instead. The token map is deterministic *per request* (a
Deidentifier instance), which keeps multi-step graphs (rank → draft) coherent:
the same person is the same token in every message of that request.

Two scrubbing layers:
  1. registered entities — callers register the names they embedded in the
     prompt (they know exactly who appears); full names and their individual
     parts map to tokens so "Maria Gomez" and "Hi Maria" both scrub;
  2. pattern classes — phones and emails are caught by regex even inside
     free text (an inbound SMS can contain anything), registered on the fly
     so rehydration restores them.
"""

from __future__ import annotations

import re

EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
# North-American shapes: 512-555-0134, (512) 555-0134, +1 512 555 0134, 5125550134.
# The separator is only optional after an explicit country code so the match
# never swallows the whitespace before the number.
PHONE_RE = re.compile(r"(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b")

# Name parts shorter than this are too collision-prone to scrub ("Al", "Bo").
_MIN_PART_LEN = 3


class Deidentifier:
    """Deterministic per-request token map with round-trip rehydration."""

    def __init__(self) -> None:
        self._token_to_value: dict[str, str] = {}
        self._value_to_token: dict[str, str] = {}  # lowercased value -> token
        self._counts: dict[str, int] = {}

    def _register(self, kind: str, value: str) -> str:
        key = value.lower()
        existing = self._value_to_token.get(key)
        if existing:
            return existing
        n = self._counts.get(kind, 0) + 1
        self._counts[kind] = n
        token = f"[{kind}_{n}]"
        self._token_to_value[token] = value
        self._value_to_token[key] = token
        return token

    def register_person(self, name: str | None, kind: str = "PATIENT") -> None:
        """Register a person: the full name and each usable part share tokens."""
        full = (name or "").strip()
        if len(full) < _MIN_PART_LEN:
            return
        self._register(kind, full)
        for part in full.replace(",", " ").split():
            if len(part) >= _MIN_PART_LEN:
                self._register(kind, part)

    def scrub(self, text: str) -> str:
        if not text:
            return text
        # Pattern classes first — they self-register so rehydrate can restore.
        text = EMAIL_RE.sub(lambda m: self._register("EMAIL", m.group(0)), text)
        text = PHONE_RE.sub(lambda m: self._register("PHONE", m.group(0)), text)
        # Registered entities, longest first so "Maria Gomez" wins over "Maria".
        for value, token in sorted(
            ((v, t) for t, v in self._token_to_value.items()),
            key=lambda p: -len(p[0]),
        ):
            text = re.sub(rf"\b{re.escape(value)}\b", token, text, flags=re.IGNORECASE)
        return text

    def rehydrate(self, text: str) -> str:
        if not text:
            return text
        for token, value in self._token_to_value.items():
            text = text.replace(token, value)
        return text

    @property
    def token_count(self) -> int:
        return len(self._token_to_value)
