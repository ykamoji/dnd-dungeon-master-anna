"""Local equivalents of the ADK campaign, character, rules, and asset tools."""
from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote

_CACHE: dict[str, list[dict[str, Any]]] = {}
_CHARACTERS: dict[str, dict[str, Any]] | None = None
_ASSETS: list[dict[str, str]] | None = None
_STOPWORDS = {
    "about", "after", "again", "against", "along", "also", "and", "any", "are",
    "around", "ask", "at", "back", "before", "behind", "being", "between",
    "bring", "but", "can", "could", "do", "does", "for", "from", "get", "give",
    "go", "have", "her", "here", "him", "his", "how", "into", "its", "make",
    "me", "more", "my", "near", "of", "off", "on", "onto", "or", "our", "out",
    "over", "party", "please", "some", "tell", "that", "the", "their", "them",
    "there", "this", "through", "to", "toward", "under", "up", "us", "use",
    "want", "we", "what", "when", "where", "which", "who", "with", "would",
}


def data_root() -> Path:
    if getattr(sys, "frozen", False) or hasattr(sys, "_MEIPASS"):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent)) / "data"
    return Path(__file__).resolve().parents[1] / "data"


def load_resource(resource_type: str) -> list[dict[str, Any]]:
    if resource_type not in _CACHE:
        path = data_root() / "open5e" / f"{resource_type}.json"
        try:
            parsed = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            parsed = []
        _CACHE[resource_type] = parsed if isinstance(parsed, list) else []
    return _CACHE[resource_type]


def _names(value: str | list[str]) -> list[str]:
    raw = value if isinstance(value, list) else [value]
    return [item.strip() for item in raw if isinstance(item, str) and item.strip()]


_RESOURCE_FIELDS = {
    "classes": (
        "name", "desc", "hit_dice", "hp_at_1st_level", "hp_at_higher_levels",
        "prof_armor", "prof_weapons", "prof_saving_throws", "prof_skills",
        "spellcasting_ability", "archetypes",
    ),
    "spells": (
        "name", "desc", "higher_level", "range", "target_range_sort",
        "components", "material", "duration", "concentration", "casting_time",
        "level", "school", "ritual",
    ),
    "armor": ("name", "category", "base_ac", "ac_string", "cost", "weight", "stealth_disadvantage"),
    "weapons": ("name", "category", "damage_dice", "damage_type", "cost", "weight", "properties"),
    "magicitems": ("name", "type", "desc", "rarity", "requires_attunement"),
    "monsters": (
        "name", "size", "type", "subtype", "alignment", "armor_class", "armor_desc",
        "hit_points", "hit_dice", "speed", "strength", "dexterity", "constitution",
        "intelligence", "wisdom", "charisma", "challenge_rating", "actions", "special_abilities",
    ),
}


_CLASS_PROFILE_FIELDS = (
    "name", "slug", "desc", "hit_dice", "hp_at_1st_level",
    "prof_armor", "prof_weapons", "prof_saving_throws", "prof_skills",
    "spellcasting_ability", "subtypes_name",
)


def get_class_profiles() -> list[dict[str, Any]]:
    """Return the same pruned Open5e class data used by the production UI."""
    profiles: list[dict[str, Any]] = []
    for cls in load_resource("classes"):
        profile = {field: cls.get(field, "") for field in _CLASS_PROFILE_FIELDS}
        archetypes = cls.get("archetypes", [])
        profile["archetypes"] = [
            {
                "name": archetype.get("name", ""),
                "slug": archetype.get("slug", ""),
                "desc": archetype.get("desc", ""),
            }
            for archetype in archetypes
            if isinstance(archetype, dict)
        ] if isinstance(archetypes, list) else []
        profiles.append(profile)
    return profiles


def _project(resource_type: str, item: dict[str, Any]) -> dict[str, Any]:
    result = {key: item[key] for key in _RESOURCE_FIELDS.get(resource_type, ()) if key in item}
    for key, value in tuple(result.items()):
        if isinstance(value, str) and len(value) > 3200:
            result[key] = value[:3200] + "…"
        elif isinstance(value, list) and len(value) > 16:
            result[key] = value[:16]
    return result


def lookup_character_resource(resource_type: str, names: str | list[str]) -> list[dict[str, Any]]:
    if resource_type not in ("spells", "classes", "armor", "weapons", "magicitems", "monsters"):
        return []
    dataset = load_resource(resource_type)
    results: list[dict[str, Any]] = []
    for query in _names(names):
        normalized = query.casefold()
        exact = next((item for item in dataset if str(item.get("name", "")).casefold() == normalized), None)
        match = exact or next(
            (item for item in dataset if normalized in str(item.get("name", "")).casefold()),
            None,
        )
        if match:
            results.append(_project(resource_type, match))
    return results


def _load_characters() -> dict[str, dict[str, Any]]:
    global _CHARACTERS
    if _CHARACTERS is not None:
        return _CHARACTERS
    _CHARACTERS = {}
    path = data_root() / "Tomb-of-Annihilation" / "Appendix D.csv"
    try:
        with path.open(encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                name = str(row.get("Name") or "").strip()
                if name:
                    _CHARACTERS[name.casefold()] = {
                        key: value.strip() if isinstance(value, str) else value
                        for key, value in row.items() if value not in (None, "")
                    }
    except OSError:
        pass
    return _CHARACTERS


def lookup_character(name: str) -> dict[str, Any] | None:
    query = name.strip().casefold()
    if not query:
        return None
    exact = _load_characters().get(query)
    if exact:
        return exact
    monsters = lookup_character_resource("monsters", name)
    return monsters[0] if monsters else None


def _tokens(text: str) -> set[str]:
    return {
        token.casefold()
        for token in re.findall(r"[A-Za-z][A-Za-z'-]{2,}", text)
        if token.casefold() not in _STOPWORDS
    }


def _load_assets() -> list[dict[str, str]]:
    global _ASSETS
    if _ASSETS is not None:
        return _ASSETS
    path = data_root() / "assets" / "Tomb-of-Annihilation" / "ASSETS.md"
    base = "https://raw.githubusercontent.com/5etools-mirror-3/5etools-img/main/adventure/ToA/"
    _ASSETS = []
    section = ""
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("## "):
                section = line[3:].strip()
                continue
            columns = line.split("|")
            if len(columns) < 3:
                continue
            filename = columns[1].strip().strip(chr(96))
            description = columns[2].strip()
            if filename and description and filename.endswith((".webp", ".png", ".jpg", ".jpeg")):
                _ASSETS.append({
                    "URL": base + quote(filename),
                    "description": description,
                    "section": section,
                })
    except OSError:
        pass
    return _ASSETS


def find_assets(query: str, limit: int = 8) -> list[dict[str, str]]:
    wanted = _tokens(query)
    ranked: list[tuple[int, dict[str, str]]] = []
    for asset in _load_assets():
        words = _tokens(asset["description"] + " " + asset["section"])
        score = len(wanted & words)
        if score:
            ranked.append((score, asset))
    strong = [item for item in ranked if item[0] >= 2] or ranked
    strong.sort(key=lambda item: (-item[0], len(item[1]["description"])))
    return [
        {"URL": item["URL"], "description": item["description"]}
        for _, item in strong[:limit]
    ]


def retrieve_campaign_files(query: str, current_section: str = "", limit: int = 4) -> list[dict[str, str]]:
    root = data_root() / "Tomb-of-Annihilation"
    index_path = data_root() / "KNOWLEDGE.md"
    wanted = _tokens(query + " " + current_section)
    candidates: list[tuple[float, Path, str, str]] = []
    try:
        index_lines = index_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        index_lines = []

    # The curated ADK knowledge index maps topics and descriptions to exact
    # chapter files; use it before ranking source text.
    link_re = re.compile(r"\[([^]]+)\]\(([^)]+)\)\s*[-—]\s*(.*)")
    indexed: dict[str, tuple[str, str]] = {}
    for line in index_lines:
        match = link_re.search(line)
        if not match:
            continue
        title, link, description = match.groups()
        decoded = unquote(link)
        prefix = "Tomb-of-Annihilation/"
        relative = decoded[len(prefix):] if decoded.startswith(prefix) else decoded
        if relative.lower().endswith(".md"):
            indexed[relative] = (title, description)

    try:
        paths = sorted(root.rglob("*.md"))
    except OSError:
        paths = []
    for path in paths:
        try:
            content = path.read_text(encoding="utf-8")
        except OSError:
            continue
        relative = path.relative_to(root).as_posix()
        title, description = indexed.get(relative, (path.stem, ""))
        title_words = _tokens(title + " " + path.stem.replace("-", " "))
        description_words = _tokens(description)
        path_words = _tokens(relative.replace("-", " "))
        content_words = _tokens(content[:16000])
        title_score = len(wanted & title_words)
        description_score = len(wanted & description_words)
        path_score = len(wanted & path_words)
        content_score = sum(1 for word in wanted if word in content_words)
        phrase_score = 6 if query and len(query) > 4 and query.casefold() in content.casefold() else 0
        section_score = 2 if current_section and current_section.casefold() in str(path).casefold() else 0
        opening_terms = {"starting", "begin", "begins", "opening", "recruitment", "hook"}
        opening_score = 18 if wanted & opening_terms and path.name.casefold() == "starting the adventure.md" else 0
        score = title_score * 9 + description_score * 5 + path_score * 2 + content_score + phrase_score + section_score + opening_score
        if score:
            candidates.append((score, path, content, description))
    candidates.sort(key=lambda item: (-item[0], len(item[1].name)))
    output = []
    for _, path, content, description in candidates[:limit]:
        relative = path.relative_to(data_root()).as_posix()
        parts = path.relative_to(root).parts
        if len(parts) > 1 and parts[0] == "Chapters":
            chapter = parts[1].replace("-", " ")
        else:
            chapter = parts[0].replace("-", " ") if len(parts) > 1 else "Tomb of Annihilation"
        section = path.stem.replace("-", " ")
        output.append({
            "path": relative,
            "chapter": chapter,
            "section": section,
            "description": description[:1000],
            "content": content[:5000],
        })
    return output


def get_state(campaign: dict[str, Any]) -> dict[str, Any]:
    """Return the latest available snapshot context, carrying party state forward."""
    return {
        "campaign_id": campaign.get("id"),
        "campaign_name": campaign.get("name"),
        "scene_title": campaign.get("scene_title"),
        "turn": campaign.get("turn", 0),
        "progress": campaign.get("progress", 0.1),
        "party": campaign.get("party") or [],
        "party_breakdown": campaign.get("party_breakdown") or {},
        "quest_log": (campaign.get("quest_log") or [])[-8:],
        "state_notes": (campaign.get("state_notes") or [])[-12:],
        "recent_events": (campaign.get("events") or [])[-12:],
        "metadata": campaign.get("metadata") or {},
    }


def gather_tool_results(action: str, campaign: dict[str, Any], intent: str) -> tuple[dict[str, Any], list[str]]:
    """Run the ADK-equivalent deterministic lookup tools for this turn."""
    state = get_state(campaign)
    tools = ["get_state"]
    lowered = action.casefold()
    names: list[str] = []
    for name in _load_characters():
        name_tokens = [token.casefold() for token in re.findall(r"[A-Za-z][A-Za-z'-]*", name)]
        full_match = re.search(rf"(?<!\w){re.escape(name)}(?!\w)", lowered)
        # Players normally use a character's first or last name. Match those
        # components too, while requiring a meaningful token to limit noise.
        partial_match = any(
            len(token) >= 4 and re.search(rf"(?<!\w){re.escape(token)}(?!\w)", lowered)
            for token in name_tokens
        )
        if full_match or partial_match:
            names.append(name)
    for resource_type in ("monsters", "spells", "classes", "armor", "weapons", "magicitems"):
        for item in load_resource(resource_type):
            name = str(item.get("name") or "")
            if len(name) >= 4 and re.search(rf"(?<!\w){re.escape(name.casefold())}(?!\w)", lowered):
                names.append(name)
                if len(names) >= 12:
                    break
        if len(names) >= 12:
            break

    monster_names = {str(item.get("name") or "").casefold() for item in load_resource("monsters")}
    character_results = []
    for name in names[:5]:
        if name.casefold() in _load_characters() or name.casefold() in monster_names:
            result = lookup_character(name)
            if result:
                character_results.append(result)
    if character_results:
        tools.append("lookup_character")

    resource_results: dict[str, list[dict[str, Any]]] = {}
    for resource_type in ("spells", "classes", "armor", "weapons", "magicitems"):
        hits = lookup_character_resource(resource_type, names[:6])
        if hits:
            resource_results[resource_type] = hits[:4]
    if resource_results:
        tools.append("lookup_character_resource")

    return {
        "state": state,
        "characters": character_results,
        "resources": resource_results,
        "assets": find_assets(action + " " + str(state.get("scene_title") or "")),
    }, tools


def story_context(query: str, current_section: str = "") -> dict[str, Any]:
    files = retrieve_campaign_files(query, current_section=current_section)
    asset_query = " ".join([query, current_section, *(item["section"] for item in files)])
    assets = find_assets(asset_query)
    return {
        "found": bool(files),
        "chapter": files[0]["chapter"] if files else "",
        "section": files[0]["section"] if files else current_section,
        "source_path": files[0]["path"] if files else "",
        "files": files,
        "assets": assets,
    }


def initialize_party(party: Any) -> list[dict[str, Any]]:
    if not isinstance(party, list) or not party or len(party) > 6:
        raise ValueError("Add between one and six adventurers to your party.")
    initialized: list[dict[str, Any]] = []
    for member in party:
        if not isinstance(member, dict):
            raise ValueError("Each party member needs a name and class.")
        name = str(member.get("name") or "").strip()[:60]
        class_name = str(member.get("class") or "Adventurer").strip()[:60]
        if not name:
            raise ValueError("Every party member needs a name.")
        class_data = lookup_character_resource("classes", class_name)
        if not class_data:
            raise ValueError(f"Could not find the D&D class “{class_name}” in the rules reference.")
        profile = class_data[0]
        hp_text = str(profile.get("hp_at_1st_level") or profile.get("hit_dice") or "8")
        hp_match = re.search(r"\d+", hp_text)
        max_hp = int(hp_match.group(0)) if hp_match else 8
        initialized.append({
            "id": str(member.get("id") or ""),
            "name": name,
            "class": str(profile.get("name") or class_name),
            "role": str(member.get("role") or profile.get("name") or "Adventurer"),
            "ancestry": str(member.get("ancestry") or "Human"),
            "skills": member.get("skills") if isinstance(member.get("skills"), list) else [],
            "hp": max_hp,
            "max_hp": max_hp,
            "conditions": [],
            "armor_proficiencies": str(profile.get("prof_armor") or ""),
            "weapon_proficiencies": str(profile.get("prof_weapons") or ""),
            "armors": [],
            "weapons": [],
            "spells": [],
            "magicitems": [],
            "inventory": [],
            "level": 1,
        })
    return initialized


def party_breakdown(party: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "level": sum(int(member.get("level") or 1) for member in party),
        "perception": max((int(member.get("passive_perception") or 10) for member in party), default=10),
        "health": sum(int(member.get("hp") or 0) for member in party),
        "money": 50,
    }
