// NPC voice assignment. Voices come from Anna's speech catalogue (see
// `speakText` in api.ts), so this module only produces a stable hint per
// speaker: "<gender>:<seed>". The same speaker name always maps to the same
// seed, so a character keeps one voice across turns, reloads and devices.

/** FNV-1a hash of the speaker name: small, fast and stable across sessions. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/** Voice hint for an NPC line, resolved to a catalogue voice when the line is spoken. */
export function resolveVoiceName(speaker?: string, gender?: string): string {
  const g = (gender ?? "").trim().toLowerCase();
  const kind = g.startsWith("f") || g.startsWith("w") ? "female" : g.startsWith("m") ? "male" : "any";
  return `${kind}:${hash((speaker ?? "").trim().toLowerCase() || "narrator")}`;
}
