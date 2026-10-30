import type { TurnSnapshot } from "@/lib/types";
import { resolveAssetUrl } from "@/lib/assetUrl";

/** Icon + label for a turn's resolved intent (single-glance readability). */
export function intentMeta(intent?: string | null): { icon: string; label: string } {
  switch ((intent ?? "").toUpperCase()) {
    case "ACTION":
      return { icon: "⚔️", label: "Action" };
    case "NPC_DIALOGUE":
      return { icon: "💬", label: "Dialogue" };
    case "CAMPAIGN":
      return { icon: "🗺️", label: "Story" };
    case "SETUP":
      return { icon: "✨", label: "Setup" };
    default:
      return { icon: "📜", label: "Turn" };
  }
}

/** Short human label for a turn (for map waypoints). */
export function sceneLabel(s: TurnSnapshot): string {
  return (
    s.scene ||
    s.metadata?.section ||
    s.metadata?.chapter ||
    (s.npc_name ? `Talk with ${s.npc_name}` : "") ||
    "Untitled scene"
  );
}

/** The first scene image of a turn, if any. */
export function firstAsset(s: TurnSnapshot): string | undefined {
  const asset = s.metadata?.assets?.find(Boolean)?.URL;
  if (asset) return resolveAssetUrl(asset) ?? undefined;
}
