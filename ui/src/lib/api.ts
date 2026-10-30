// Anna App adapter for the existing React client.
// Every game request runs through the bundled Executa; durable campaign state
// stays in the current Anna user's APS namespace.
import type {
  Campaign,
  CampaignSummary,
  ClassProfile,
  SessionEvent,
  TurnSnapshot,
} from "./types";

export const HITL_INTERRUPT_ID = "hitl_approval";

const TOOL_HANDLE = "dnd-game-master";
const DEV_TOOL_ID = "tool-dev-dnd-game-master";
const PREFIX = "dnd-dungeon-master";
const INDEX_KEY = `${PREFIX}/campaign-index`;
const campaignKey = (id: string) => `${PREFIX}/campaign/${id}`;

type Stored<T = unknown> = { exists: boolean; value?: T; etag?: string };
export type CampaignRecord = {
  id: string;
  name: string;
  game_id?: string;
  premise: string;
  created_at: string;
  updated_at: string;
  turn: number;
  scene_title: string;
  quest_log: string[];
  party: Array<Record<string, unknown>>;
  pending: Record<string, unknown> | null;
  events: Array<Record<string, unknown>>;
  suggested_actions: string[];
  state_notes: Array<Record<string, unknown>>;
  party_breakdown?: Record<string, number>;
  metadata?: Record<string, unknown>;
  progress?: number;
  intent?: string;
  trace?: Array<Record<string, unknown>>;
};

type AnnaRuntime = {
  storage: {
    get(args: { scope: "user"; key: string }): Promise<Stored>;
    set(args: { scope: "user"; key: string; value: unknown; if_match?: string }): Promise<unknown>;
    delete(args: { scope: "user"; key: string; if_match?: string }): Promise<unknown>;
  };
  tools: { invoke(args: { tool_id: string; method: string; args: Record<string, unknown> }): Promise<unknown> };
};

declare global {
  interface Window {
    __ANNA_TOOL_IDS__?: Record<string, string>;
  }
}

const localStorageApi = {
  async get({ key }: { scope?: "user"; key: string }): Promise<Stored> {
    const raw = localStorage.getItem(`${PREFIX}:${key}`);
    return raw === null ? { exists: false } : JSON.parse(raw) as Stored;
  },
  async set({ key, value, if_match }: { scope?: "user"; key: string; value: unknown; if_match?: string }) {
    const current = await this.get({ key });
    if (if_match && (!current.exists || current.etag !== if_match)) {
      throw new Error("precondition_failed: this campaign changed in another window.");
    }
    if (!if_match && current.exists) throw new Error("precondition_failed: this campaign already exists.");
    const etag = crypto.randomUUID();
    localStorage.setItem(`${PREFIX}:${key}`, JSON.stringify({ exists: true, value, etag }));
    return { ok: true, etag };
  },
  async delete({ key, if_match }: { scope?: "user"; key: string; if_match?: string }) {
    const current = await this.get({ key });
    if (!current.exists) return { ok: true, deleted: false };
    if (if_match && current.etag !== if_match) {
      throw new Error("precondition_failed: this campaign changed in another window.");
    }
    localStorage.removeItem(`${PREFIX}:${key}`);
    return { ok: true, deleted: true };
  },
};

let runtimePromise: Promise<{ anna: AnnaRuntime; preview: boolean }> | null = null;
async function getRuntime(): Promise<{ anna: AnnaRuntime; preview: boolean }> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const previewRequested =
        typeof window !== "undefined" &&
        ["localhost", "127.0.0.1"].includes(window.location.hostname) &&
        new URLSearchParams(window.location.search).get("preview") === "1";
      if (previewRequested) {
        return {
          anna: {
            storage: localStorageApi,
            tools: { invoke: async () => { throw new Error("Anna tools are unavailable in local preview."); } },
          },
          preview: true,
        };
      }
      try {
        const sdkUrl = "/static/anna-apps/_sdk/latest/index.js";
        const { AnnaAppRuntime } = await import(/* webpackIgnore: true */ sdkUrl);
        return { anna: await AnnaAppRuntime.connect() as AnnaRuntime, preview: false };
      } catch (error) {
        console.error("Could not connect to the Anna app runtime.", error);
        throw new Error("Could not connect to Anna. Open this app from Anna or use ?preview=1 for a local UI preview.");
      }
    })();
  }
  return runtimePromise;
}

function unwrap<T>(value: unknown): T {
  let result = value as any;
  for (let i = 0; i < 3; i++) {
    if (result?.success === false) throw new Error(result.error?.message || result.message || "The D&D tool could not complete that request.");
    if (result?.success === true && Object.hasOwn(result, "data")) { result = result.data; continue; }
    if (result?.data?.success === true && Object.hasOwn(result.data, "data")) { result = result.data.data; continue; }
    break;
  }
  return result as T;
}

function previewInvoke(method: string, args: Record<string, any>): any {
  const campaign = args.campaign as CampaignRecord | undefined;
  if (method === "get_class_profiles") {
    return classSpecs.map(([name, hit_dice, hp_at_1st_level, prof_saving_throws, spellcasting_ability, prof_armor, prof_weapons, skills, roles]) => ({
      name, slug: name.toLowerCase(), desc: name + " adventurer", hit_dice, hp_at_1st_level,
      prof_armor, prof_weapons, prof_saving_throws, prof_skills: "Choose 2 from " + skills,
      spellcasting_ability, subtypes_name: "Archetype",
      archetypes: roles.map((role) => ({ name: role, slug: role.toLowerCase().replaceAll(" ", "-"), desc: role + " archetype" })),
    }));
  }
  if (method === "create_campaign") {
    const party = (args.party as Array<Record<string, unknown>>).map((member) => ({ ...member, id: crypto.randomUUID(), hp: 12, max_hp: 12, armor_class: 12 }));
    return {
      id: args.campaign_id || crypto.randomUUID(), name: args.name, game_id: args.game_id, premise: args.premise,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), turn: 0,
      scene_title: "Port Nyanzaru", party, quest_log: ["Investigate the death curse and follow its trail into Chult."],
      pending: null, state_notes: [], suggested_actions: ["Ask about the death curse", "Find a guide for the jungle", "Gather rumors at the harbor"],
      events: [{ id: crypto.randomUUID(), kind: "narration", turn: 0, scene_title: "Port Nyanzaru", text: "Heat shimmers above the harbor stones as your party reaches Port Nyanzaru. Bright sails crowd the bay, traders call from the waterfront, and rumors of a death curse move through the city. A local guide waits beneath a canvas awning, watching your group with wary interest.", created_at: new Date().toISOString() }],
    } satisfies CampaignRecord;
  }
  if (method === "draft_turn" && campaign) return {
    id: crypto.randomUUID(), campaign_id: campaign.id, action: args.action, scene_title: "At the Harbor Gate",
    narration: "The guide points toward a trail leading inland. Beyond the harbor, the green wall of Chult rises beneath a haze of heat. A runner pushes through the crowd with a warning: the death curse has reached another household, and the party's lead may be the only one that points toward its source.",
    suggested_actions: ["Ask about the death curse", "Find a guide for the jungle", "Gather rumors at the harbor"],
    check: (args.dice as any)?.d20 ? { ability: "Wisdom", dc: 12, reason: `The party rolled a d20: ${(args.dice as any).d20}` } : null,
    state_changes: [{ kind: "clue", text: "A guide has offered to lead the party into Chult." }], created_at: new Date().toISOString(),
  };
  if (method === "resolve_turn" && campaign) {
    const updated = structuredClone(campaign);
    updated.pending = null;
    updated.updated_at = new Date().toISOString();
    if (args.approved) {
      const draft = args.draft as Record<string, any>;
      const turn = Number(updated.turn || 0) + 1;
      updated.events.push(
        { id: crypto.randomUUID(), kind: "action", turn, text: draft.action, created_at: new Date().toISOString() },
        { id: crypto.randomUUID(), kind: "narration", turn, scene_title: draft.scene_title, suggested_actions: draft.suggested_actions, text: draft.narration, created_at: new Date().toISOString() },
      );
      if (draft.check) updated.events.push({ id: crypto.randomUUID(), kind: "check", turn, text: `${draft.check.ability} check · DC ${draft.check.dc} — ${draft.check.reason}`, created_at: new Date().toISOString() });
      updated.state_notes.push(...(draft.state_changes || []).map((change: any) => ({ ...change, turn })));
      updated.scene_title = draft.scene_title;
      updated.suggested_actions = draft.suggested_actions || [];
      updated.turn = turn;
    }
    return updated;
  }
  if (method === "voice_token") throw new Error("Voice needs a configured Gemini API key and Anna external API approval.");
  throw new Error("The local preview could not complete that request.");
}

export async function invokeTool<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const { anna, preview } = await getRuntime();
  if (preview) return previewInvoke(method, args) as T;
  const toolId = window.__ANNA_TOOL_IDS__?.[TOOL_HANDLE] || DEV_TOOL_ID;
  return unwrap<T>(await anna.tools.invoke({ tool_id: toolId, method, args }));
}

async function getStored<T>(key: string): Promise<Stored<T>> {
  const { anna } = await getRuntime();
  return anna.storage.get({ scope: "user", key }) as Promise<Stored<T>>;
}

async function setStored<T>(key: string, value: T, previous?: Stored): Promise<void> {
  const { anna } = await getRuntime();
  const params: { scope: "user"; key: string; value: T; if_match?: string } = { scope: "user", key, value };
  if (previous?.exists) {
    if (!previous.etag) throw new Error("Anna returned no ETag. Reload the campaign before saving.");
    params.if_match = previous.etag;
  }
  await anna.storage.set(params);
}

async function saveIndexEntry(campaign: CampaignRecord): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const previous = await getStored<{ campaigns: Array<Record<string, unknown>> }>(INDEX_KEY);
    const index = previous.exists && Array.isArray(previous.value?.campaigns) ? previous.value : { campaigns: [] };
    const campaigns = index.campaigns.filter((item) => item.id !== campaign.id);
    campaigns.unshift({ id: campaign.id, name: campaign.name, updated_at: campaign.updated_at, game_id: campaign.game_id });
    try { await setStored(INDEX_KEY, { campaigns: campaigns.slice(0, 40) }, previous); return; }
    catch (error) { if (attempt || !String((error as Error)?.message || error).includes("precondition")) throw error; }
  }
}

export async function saveCampaignRecord(campaign: CampaignRecord): Promise<void> {
  const key = campaignKey(campaign.id);
  const previous = await getStored<CampaignRecord>(key);
  await setStored(key, campaign, previous);
  await saveIndexEntry(campaign);
}

export async function getCampaignRecord(id: string): Promise<CampaignRecord | null> {
  const stored = await getStored<CampaignRecord>(campaignKey(id));
  return stored.exists && stored.value?.id === id ? stored.value : null;
}

function snapshotFromCampaign(campaign: CampaignRecord): TurnSnapshot[] {
  const turns = new Map<number, Array<Record<string, any>>>();
  for (const event of campaign.events || []) {
    const turn = Number(event.turn || 0);
    turns.set(turn, [...(turns.get(turn) || []), event]);
  }
  return [...turns.entries()].sort(([a], [b]) => a - b).map(([turn, events]) => {
    const narration = [...events].reverse().find((event) => event.kind === "narration");
    const action = events.find((event) => event.kind === "action");
    const check = events.find((event) => event.kind === "check");
    const snapshot = narration?.snapshot && typeof narration.snapshot === "object"
      ? narration.snapshot as Record<string, any>
      : {};
    const rawParty = Array.isArray(snapshot.party) ? snapshot.party : campaign.party || [];
    const party = { characters: Object.fromEntries(rawParty.map((member: Record<string, any>) => [String(member.name || "Adventurer"), {
      role: String(member.role || "Adventurer"),
      class: String(member.class || "Adventurer"),
      hp: Number(member.hp ?? 0),
      max_hp: Number(member.max_hp ?? member.hp ?? 0),
      conditions: Array.isArray(member.conditions) ? member.conditions : [],
      armors: Array.isArray(member.armors) ? member.armors : [],
      spells: Array.isArray(member.spells) ? member.spells : [],
      weapons: Array.isArray(member.weapons) ? member.weapons : [],
      magicitems: Array.isArray(member.magicitems) ? member.magicitems : [],
      skills: Array.isArray(member.skills) ? member.skills : [],
    }])) };
    const metadata = snapshot.metadata && typeof snapshot.metadata === "object"
      ? snapshot.metadata as Record<string, any>
      : snapshot;
    const timestamp = String(narration?.created_at || events[0]?.created_at || campaign.updated_at || new Date().toISOString());
    return {
      scene: String(snapshot.scene_summary || narration?.scene_title || (turn === Number(campaign.turn) ? campaign.scene_title : "The scene unfolds")),
      description: String(snapshot.description || (typeof action?.text === "string" ? "Party action: " + action.text : "")) || undefined,
      narrative: String(snapshot.narrative || narration?.text || ""),
      npc_name: snapshot.npc_name || undefined,
      dialogue: Array.isArray(snapshot.dialogue) ? snapshot.dialogue : [],
      party,
      party_breakdown: snapshot.party_breakdown || campaign.party_breakdown,
      intent: snapshot.intent || (turn === 0 ? "SETUP" : campaign.intent || "CAMPAIGN"),
      created_dt: timestamp,
      metadata: {
        invocation_id: "anna-turn-" + turn,
        chapter: metadata.chapter,
        section: metadata.section,
        assets: metadata.assets,
        gm_notes: metadata.gm_notes,
        suggested_actions: metadata.suggested_actions || narration?.suggested_actions || (turn === Number(campaign.turn) ? campaign.suggested_actions : []),
        math_breakdown: metadata.math_breakdown || (typeof check?.text === "string" ? check.text : undefined),
        next_scene_suggestions: metadata.next_scene_suggestions || [],
        combat_log: metadata.combat_log || [],
        requires_roll: Boolean(metadata.requires_roll || check),
      },
    };
  });
}

function toCampaign(campaign: CampaignRecord): Campaign {
  return {
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    summary: campaign.quest_log?.join(" · ") || campaign.premise,
    progress: Number.isFinite(campaign.progress) ? campaign.progress : Math.min(100, Math.round((Number(campaign.turn || 0) / 20) * 100)),
    updated_at: campaign.updated_at,
    created_at: campaign.created_at,
    state: snapshotFromCampaign(campaign),
  };
}

const classSpecs: Array<[string, string, string, string, string, string, string, string, string[]]> = [
  ["Barbarian", "d12", "12 + Constitution", "Strength · Constitution", "None", "Light · Medium · Shields", "Simple · Martial", "Animal Handling, Athletics, Intimidation, Nature, Perception, Survival", ["Vanguard", "Pathbreaker", "Guardian"]],
  ["Bard", "d8", "8 + Constitution", "Dexterity · Charisma", "Charisma", "Light", "Simple · Hand crossbows · Rapiers", "Acrobatics, Deception, Insight, Performance, Persuasion, Sleight of Hand", ["Skald", "Envoy", "Lorekeeper"]],
  ["Cleric", "d8", "8 + Constitution", "Wisdom · Charisma", "Wisdom", "Light · Medium · Shields", "Simple", "History, Insight, Medicine, Persuasion, Religion", ["Healer", "Warden", "Lightbearer"]],
  ["Druid", "d8", "8 + Constitution", "Intelligence · Wisdom", "Wisdom", "Light · Medium · Shields", "Clubs · Daggers · Staves", "Animal Handling, Insight, Medicine, Nature, Perception, Survival", ["Warden", "Shapeshifter", "Guide"]],
  ["Fighter", "d10", "10 + Constitution", "Strength · Constitution", "Varies by path", "All armor · Shields", "Simple · Martial", "Acrobatics, Animal Handling, Athletics, History, Insight, Perception", ["Champion", "Tactician", "Sentinel"]],
  ["Monk", "d8", "8 + Constitution", "Strength · Dexterity", "None", "None", "Simple · Short blades", "Acrobatics, Athletics, Insight, Religion, Stealth", ["Wayfarer", "Duelist", "Disciple"]],
  ["Paladin", "d10", "10 + Constitution", "Wisdom · Charisma", "Charisma", "All armor · Shields", "Simple · Martial", "Athletics, Insight, Medicine, Persuasion, Religion", ["Oathkeeper", "Anchor", "Vindicator"]],
  ["Ranger", "d10", "10 + Constitution", "Strength · Dexterity", "Wisdom", "Light · Medium · Shields", "Simple · Martial", "Animal Handling, Athletics, Insight, Nature, Perception, Stealth, Survival", ["Trail Guide", "Beast Friend", "Skirmisher"]],
  ["Rogue", "d8", "8 + Constitution", "Dexterity · Intelligence", "Varies by path", "Light", "Simple · Hand crossbows · Rapiers", "Acrobatics, Deception, Insight, Investigation, Perception, Sleight of Hand, Stealth", ["Scout", "Infiltrator", "Trickster"]],
  ["Sorcerer", "d6", "6 + Constitution", "Constitution · Charisma", "Charisma", "None", "Simple", "Arcana, Deception, Insight, Intimidation, Persuasion", ["Stormcaller", "Wildspark", "Spellweaver"]],
  ["Warlock", "d8", "8 + Constitution", "Wisdom · Charisma", "Charisma", "Light", "Simple", "Arcana, Deception, History, Intimidation, Investigation", ["Pactbound", "Seeker", "Hexblade"]],
  ["Wizard", "d6", "6 + Constitution", "Intelligence · Wisdom", "Intelligence", "None", "Simple", "Arcana, History, Insight, Investigation, Medicine, Religion", ["Arcanist", "Sage", "Battle Mage"]],
];

export async function getClasses(): Promise<ClassProfile[]> {
  return invokeTool<ClassProfile[]>("get_class_profiles");
}

export async function getCampaigns(): Promise<CampaignSummary[]> {
  const stored = await getStored<{ campaigns: Array<{ id: string }> }>(INDEX_KEY);
  const ids = stored.exists && Array.isArray(stored.value?.campaigns) ? stored.value.campaigns.map((item) => item.id) : [];
  const values = await Promise.all(ids.slice(0, 40).map((id) => getCampaignRecord(id)));
  return values.filter((item): item is CampaignRecord => Boolean(item)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((item) => ({
    campaign_id: item.id, campaign_name: item.name, summary: item.quest_log?.at(-1) || item.premise,
    progress: Number.isFinite(item.progress) ? item.progress : Math.min(100, Math.round((Number(item.turn || 0) / 20) * 100)), updated_at: item.updated_at,
    scene: item.scene_title,
  }));
}

export async function getCampaign(campaignId: string, _includeHistory = false): Promise<Campaign> {
  const record = await getCampaignRecord(campaignId);
  if (!record) throw new Error("404 campaign not found");
  return toCampaign(record);
}

export async function createCampaign(args: { campaignId: string; name: string; gameId: string; premise: string; party: Array<Record<string, unknown>> }): Promise<CampaignRecord> {
  const existing = await getCampaignRecord(args.campaignId);
  if (existing) return existing;
  const campaign = await invokeTool<CampaignRecord>("create_campaign", {
    campaign_id: args.campaignId,
    name: args.name,
    game_id: args.gameId,
    premise: args.premise,
    party: args.party,
  });
  await saveCampaignRecord(campaign);
  return campaign;
}

export async function deleteCampaign(campaignId: string): Promise<void> {
  const record = await getStored<CampaignRecord>(campaignKey(campaignId));
  if (record.exists) {
    if (!record.etag) throw new Error("Anna returned no ETag. Reload the campaign before deleting it.");
    const { anna } = await getRuntime();
    await anna.storage.delete({
      scope: "user",
      key: campaignKey(campaignId),
      if_match: record.etag,
    });
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const previous = await getStored<{ campaigns: Array<{ id: string }> }>(INDEX_KEY);
    if (!previous.exists || !previous.value || !Array.isArray(previous.value.campaigns)) return;
    try {
      await setStored(INDEX_KEY, { campaigns: previous.value.campaigns.filter((item) => item.id !== campaignId) }, previous);
      return;
    } catch (error) { if (attempt || !String((error as Error)?.message || error).includes("precondition")) throw error; }
  }
}

export async function getLiveToken(opts?: { type?: "text" | "audio"; emotion?: string; voiceName?: string }): Promise<{ token: string; model: string; websocket_url: string }> {
  return invokeTool("voice_token", {
    type: opts?.type ?? "text",
    emotion: opts?.emotion ?? "",
    voice_name: opts?.voiceName ?? "",
  });
}

export async function getHistoricalEvents(campaignId: string, invocationId: string): Promise<SessionEvent[]> {
  const campaign = await getCampaignRecord(campaignId);
  if (!campaign) return [];
  const turn = Number(invocationId.replace(/^anna-turn-/, ""));
  return campaign.events.filter((event) => Number(event.turn || 0) === turn).map((event, index) => ({
    id: String(event.id || `${campaignId}-${turn}-${index}`),
    invocation_id: invocationId,
    timestamp: Math.floor(new Date(String(event.created_at || Date.now())).getTime() / 1000),
    author: event.kind === "action" ? "user" : "dnd_game_master_agent",
    content: { parts: [{ text: String(event.text || "") }] },
  }));
}

export { campaignKey };
