"""Input guardrails ported from the original ADK workflow."""
from __future__ import annotations

import re

# Only phrases aimed at the model's instructions. In-character roleplay ("I pretend to be
# a merchant", "act as a decoy", "you are now a prisoner of the cult") must pass: the
# player's text is quoted as data in every prompt, and the evaluator reviews each draft.
_INJECTION_PATTERNS = (
    r"\b(ignore|disregard|override|bypass)\s+((all|any|your|these|those)\s+|(the\s+)?(previous|prior|above|earlier|original|system)\s+)+(\w+\s+)?(instructions|rules|prompts?|guidelines|directives)\b(?!\s+(of|in|at|on)\b)",
    r"\bforget\s+(everything|all|your)\s+(\w+\s+)?(instructions|rules|prompts?|guidelines|you\s+were\s+told)",
    r"\bforget\s+everything\b",
    r"\b(system|developer|hidden|initial)\s+prompt",
    r"\b(reveal|show|print|repeat|leak|output)\s+(me\s+)?(your|the)\s+(\w+\s+)?(instructions|prompt|rules)",
    r"\bjailbreak",
    r"\bdeveloper\s+mode\b",
    r"\byou\s+are\s+(now\s+)?(no\s+longer\s+)?(an?\s+)?(ai|assistant|chatbot|language\s+model|llm|gpt|claude)\b",
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
    """Return (safe, reason, in-character refusal) for a player's action."""
    value = (text or "").lower()
    if any(re.search(pattern, value) for pattern in _INJECTION_PATTERNS):
        return False, "Prompt injection detected", _INJECTION_REFUSAL
    if any(re.search(pattern, value) for pattern in _OUT_OF_SCOPE_PATTERNS):
        return False, "Out-of-scope request", _OUT_OF_SCOPE_REFUSAL
    return True, "", ""


def evaluate_setup_safety(*texts: str) -> str:
    """Return a player-facing error when a premise or party name targets the model's instructions."""
    for text in texts:
        value = (text or "").lower()
        if any(re.search(pattern, value) for pattern in _INJECTION_PATTERNS):
            return "Campaign names, premises and party names can only describe the adventure. Please rephrase."
    return ""
