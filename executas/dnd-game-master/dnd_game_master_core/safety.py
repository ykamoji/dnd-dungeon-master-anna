"""Input guardrails ported from the original ADK workflow."""
from __future__ import annotations

import re

_INJECTION_PATTERNS = (
    r"ignore\s+(your|previous|all)\s+(instructions|rules|prompts)",
    r"you\s+are\s+now\s+a",
    r"pretend\s+to\s+be",
    r"act\s+as\s+(if\s+you\s+are\s+)?a",
    r"forget\s+(everything|your\s+instructions)",
    r"system\s*prompt",
    r"jailbreak",
)
_OUT_OF_SCOPE_PATTERNS = (
    r"write\s+(me\s+)?(a\s+)?(python|javascript|code|script|program)",
    r"what('s|\s+is)\s+the\s+weather",
    r"(stock|crypto)\s+price",
    r"(translate|summarize)\s+this\s+(article|document|text)",
    r"help\s+me\s+with\s+my\s+(homework|essay|resume)",
)
_INJECTION_REFUSAL = (
    "⚔️ I'm your D&D Dungeon Master — I can only help with in-game actions, "
    "NPC dialogue, and campaign management. Let's get back to the adventure!"
)
_OUT_OF_SCOPE_REFUSAL = (
    "🎲 That's outside the realm of this adventure! I can help with combat, "
    "NPC conversations, or campaign management. What would you like to do?"
)


def evaluate_input_safety(text: str) -> tuple[bool, str, str]:
    value = (text or "").lower()
    if any(re.search(pattern, value) for pattern in _INJECTION_PATTERNS):
        return False, "Prompt injection detected", _INJECTION_REFUSAL
    if any(re.search(pattern, value) for pattern in _OUT_OF_SCOPE_PATTERNS):
        return False, "Out-of-scope request", _OUT_OF_SCOPE_REFUSAL
    return True, "", ""
