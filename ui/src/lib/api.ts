// Anna App adapter for the existing React client.
// Every game request runs through the bundled Executa; durable campaign state
// stays in this app's own Anna storage scope (`app`, the default).
//
// Storage layout (v2). Each value stays small and bounded, whatever the campaign length:
//   dnd-dungeon-master/v2/index                      campaign list (id, name, scene, progress)
//   dnd-dungeon-master/v2/campaign/{id}/state        compact state sent to the Executa
//   dnd-dungeon-master/v2/campaign/{id}/pending      the draft awaiting approval
//   dnd-dungeon-master/v2/campaign/{id}/turn/{n}     one committed turn: events + snapshot
//   dnd-dungeon-master/v2/campaign/{id}/trace/{n}    that turn's agent trace
// A turn commits in this order: turn/{n}, trace/{n}, then state with if_match (the
// commit point), then the index, then the pending draft is deleted. A crash before the
// state write leaves an orphan turn record that the next commit overwrites.
// Campaigns saved by 0.2.x as one `dnd-dungeon-master/campaign/{id}` value in the shared
// `user` scope are migrated on first open. The app only reads that scope (the manifest
// declares `user: "r"`), so migrated or deleted legacy campaigns are hidden through the
// v2 index's `retired_legacy` list instead of being deleted.
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
const V2 = `${PREFIX}/v2`;
const INDEX_KEY = `${V2}/index`;
const stateKey = (id: string) => `${V2}/campaign/${id}/state`;
const pendingKey = (id: string) => `${V2}/campaign/${id}/pending`;
const turnKey = (id: string, turn: number) => `${V2}/campaign/${id}/turn/${turn}`;
const traceKey = (id: string, turn: number) => `${V2}/campaign/${id}/trace/${turn}`;
const LEGACY_INDEX_KEY = `${PREFIX}/campaign-index`;
const legacyCampaignKey = (id: string) => `${PREFIX}/campaign/${id}`;

/** Tool job budgets. The Executa sizes its model calls to the same deadlines. */
const SETUP_JOB_MS = 240_000;
const DRAFT_JOB_MS = 300_000;
const SYNC_MAX_MS = 90_000;

type Stored<T = unknown> = { exists: boolean; value?: T; etag?: string };
type Scope = "user" | "app";
type AnyRecord = Record<string, any>;

/** Compact campaign state: what the Executa reads and returns. Bounded in size. */
export type CampaignState = {
  id: string;
  name: string;
  game_id?: string | null;
  premise: string;
  created_at: string;
  updated_at: string;
  turn: number;
  scene_title: string;
  progress?: number;
  quest_log: string[];
  party: AnyRecord[];
  party_breakdown?: Record<string, number>;
  metadata?: AnyRecord;
  intent?: string;
  suggested_actions: string[];
  state_notes: AnyRecord[];
  recent_events: AnyRecord[];
  last_draft_id?: string | null;
  schema?: number;
};

/** One committed turn: its events and the snapshot the reader shows. */
export type TurnRecord = {
  turn: number;
  created_at: string;
  author?: string;
  scene_title?: string;
  draft_id?: string;
  events: AnyRecord[];
  snapshot: AnyRecord;
  evaluation?: AnyRecord | null;
};

export type Draft = AnyRecord;

/** One `executa/progress` event delivered by a tool job. */
export type ToolProgress = { seq: number; ts?: number | null; type: string; data: AnyRecord };

type IndexEntry = {
  id: string;
  name: string;
  game_id?: string | null;
  updated_at: string;
  scene?: string;
  progress?: number;
  summary?: string;
};

type JobSnapshot = {
  jobId: string;
  state: string;
  result?: unknown;
  error?: { code?: string; message?: string } | null;
  progress?: ToolProgress[];
  lastSeq?: number;
};
type JobSummary = { jobId: string; state: string; clientTag?: string; [key: string]: unknown };

type ToolCallArgs = { tool_id: string; method: string; args: Record<string, unknown>; timeoutMs?: number; clientTag?: string };

type AnnaRuntime = {
  storage: {
    get(args: { scope?: Scope; key: string }): Promise<Stored>;
    set(args: { scope?: Scope; key: string; value: unknown; if_match?: string }): Promise<unknown>;
    delete(args: { scope?: Scope; key: string; if_match?: string }): Promise<unknown>;
  };
  tools: {
    invoke(args: ToolCallArgs, opts?: { timeoutMs?: number }): Promise<unknown>;
    invokeAsyncAwait?(
      args: ToolCallArgs,
      opts?: { onProgress?: (event: ToolProgress) => void; signal?: AbortSignal; timeoutMs?: number },
    ): Promise<unknown>;
    getJob?(args: { jobId: string; sinceSeq?: number }): Promise<JobSnapshot>;
    listJobs?(args: { clientTag?: string; limit?: number }): Promise<{ jobs?: JobSummary[] }>;
  };
  llm?: { catalog?(args: { serviceType: string }): Promise<{ models?: TtsModel[] }> };
  audio?: {
    speak?(args: { text: string; model?: string; voice?: string; delivery?: "inline" | "url" }): Promise<{ audioBase64?: string; url?: string; mimeType?: string }>;
    transcribe?(args: { audioBase64: string; format: string; language?: string }): Promise<{ text?: string }>;
  };
  window?: { report_error?(args: { message: string; stack?: string }): Promise<unknown> };
};

type TtsModel = {
  name?: string;
  id?: string;
  isUserPreferred?: boolean;
  capabilities?: {
    voices?: Array<{ id: string; label?: string; gender?: string; languages?: string[] }>;
    defaultVoice?: string;
    maxCharsPerCall?: number;
  };
};

declare global {
  interface Window {
    __ANNA_TOOL_IDS__?: Record<string, string>;
  }
}

const localStorageApi = {
  async get({ key }: { scope?: Scope; key: string }): Promise<Stored> {
    const raw = localStorage.getItem(`${PREFIX}:${key}`);
    return raw === null ? { exists: false } : JSON.parse(raw) as Stored;
  },
  async set({ key, value, if_match }: { scope?: Scope; key: string; value: unknown; if_match?: string }) {
    const current = await this.get({ key });
    if (if_match && (!current.exists || current.etag !== if_match)) {
      throw new Error("precondition_failed: this campaign changed in another window.");
    }
    if (!if_match && current.exists) throw new Error("precondition_failed: this campaign already exists.");
    const etag = crypto.randomUUID();
    localStorage.setItem(`${PREFIX}:${key}`, JSON.stringify({ exists: true, value, etag }));
    return { ok: true, etag };
  },
  async delete({ key, if_match }: { scope?: Scope; key: string; if_match?: string }) {
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
        runtimePromise = null;
        throw new Error("Could not connect to Anna. Please reload the app and try again.");
      }
    })();
  }
  return runtimePromise;
}

const GENERIC_ERROR = "Something went wrong. Please try again.";

/** Host and tool-job error codes that have a clearer message than their text. */
const MESSAGES_BY_CODE: Record<string, string> = {
  agent_unavailable: "Your Anna Agent is offline. Start it and try again.",
  tool_timeout: "The Dungeon Master took too long to answer. Please try again.",
  wait_timeout: "The Dungeon Master is still working. Reopen the campaign in a moment to pick up the result.",
  cancelled: "The request was cancelled.",
  job_not_found: "That request expired before it finished. Please try again.",
  rate_limited: "Too many requests at once. Wait a moment and try again.",
  state_too_large: "This save is too large to store.",
  precondition_failed: "This campaign changed in another window. Reload and try again.",
  permission_denied: "This app is missing a permission. Update or reinstall it from the App Store.",
  APP_QUOTA_EXCEEDED: "Your Anna AI quota is used up. Try again later.",
};

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = error as AnyRecord;
  return String(value.code || value.error?.code || "");
}

/**
 * Turn anything thrown by the Anna host, the Executa or the browser into one
 * plain sentence. The host reports tool failures as a stringified dict such as
 * `invoke error: {'code': -32603, 'message': '…'}`; only the message is shown.
 */
export function friendlyError(error: unknown, fallback = GENERIC_ERROR): string {
  const byCode = MESSAGES_BY_CODE[errorCode(error)];
  if (byCode) return byCode;
  let text = "";
  if (typeof error === "string") text = error;
  else if (error && typeof error === "object") {
    const value = error as AnyRecord;
    text = String(value.error?.message || value.message || value.reason || "");
  }
  const nested = text.match(/["']message["']\s*:\s*(["'])((?:\\.|(?!\1).)*)\1/);
  if (nested) text = nested[2].replace(/\\(["'])/g, "$1");
  text = text.replace(/^\s*(?:invoke error|tool error|error)\s*:\s*/i, "").trim();
  const lower = text.toLowerCase();
  if (!text || text === "[object Object]") return fallback;
  if (lower.includes("precondition")) return MESSAGES_BY_CODE.precondition_failed;
  if (lower.includes("timed out") || lower.includes("timeout")) return "The Dungeon Master took too long to answer. Please try again.";
  if (lower.includes("failed to fetch") || lower.includes("networkerror") || lower.includes("network error")) return "The connection was interrupted. Check your network and try again.";
  if (lower.includes("json") || lower.includes("model response") || lower.includes("unexpected token")) return "The Dungeon Master's reply could not be read. Please try again.";
  if (lower.includes("notallowederror") || lower.includes("permission denied")) return "Microphone access was blocked. Allow it in your browser to use voice.";
  if (lower.includes("rate limit") || lower.includes("quota") || lower.includes("429")) return "The service is busy right now. Please wait a moment and try again.";
  // Anything that still looks like a payload, stack or code is not for players.
  if (/[{}\[\]]|-32\d{3}|traceback|exception|\bat \S+:\d+/i.test(text) || text.length > 280) return fallback;
  return text;
}

/** Tell the Anna host about a render crash (shown in the developer console). Best effort. */
export function reportError(error: unknown, componentStack?: string): void {
  void getRuntime().then(({ anna, preview }) => {
    if (preview || typeof anna.window?.report_error !== "function") return;
    const value = error as Error;
    const stack = [value?.stack, componentStack].filter(Boolean).join("\n").slice(0, 8000);
    return anna.window.report_error({ message: String(value?.message || error).slice(0, 500), stack });
  }).catch(() => undefined);
}

async function guarded<T>(work: () => Promise<T>, fallback?: string): Promise<T> {
  try { return await work(); }
  catch (error) {
    console.error(error);
    throw new Error(friendlyError(error, fallback));
  }
}

function unwrap<T>(value: unknown): T {
  let result = value as any;
  for (let i = 0; i < 4; i++) {
    if (result?.success === false) {
      const error = result.error;
      throw new Error((typeof error === "string" ? error : error?.message) || result.message || "The D&D tool could not complete that request.");
    }
    if (result?.success === true && Object.hasOwn(result, "data")) { result = result.data; continue; }
    if (result?.data?.success === true && Object.hasOwn(result.data, "data")) { result = result.data.data; continue; }
    // A job snapshot or host envelope may wrap the plugin payload in `result`.
    if (result?.result && typeof result.result === "object" && typeof result.result.success === "boolean") { result = result.result; continue; }
    break;
  }
  return result as T;
}

const toolId = () => window.__ANNA_TOOL_IDS__?.[TOOL_HANDLE] || DEV_TOOL_ID;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "cancelled", "expired"]);

export type InvokeOptions = {
  /** Run as an Anna tool job: survives reloads, streams progress, no 90 s cap. */
  async?: boolean;
  /** Tag used to find this job again after a reload. */
  clientTag?: string;
  timeoutMs?: number;
  onProgress?: (event: ToolProgress) => void;
  signal?: AbortSignal;
};

async function runJob(anna: AnnaRuntime, method: string, args: Record<string, unknown>, options: InvokeOptions): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DRAFT_JOB_MS;
  if (typeof anna.tools.invokeAsyncAwait === "function") {
    try {
      return await anna.tools.invokeAsyncAwait(
        { tool_id: toolId(), method, args, timeoutMs, clientTag: options.clientTag },
        // The wall clock outlives the job deadline so a slow queue still reports the real outcome.
        { onProgress: options.onProgress, signal: options.signal, timeoutMs: timeoutMs + 60_000 },
      );
    } catch (error) {
      if (errorCode(error) !== "not_implemented") throw error;
    }
  }
  // Hosts without tool jobs: one synchronous call at the platform maximum.
  return anna.tools.invoke({ tool_id: toolId(), method, args, timeoutMs: SYNC_MAX_MS }, { timeoutMs: SYNC_MAX_MS + 5_000 });
}

export async function invokeTool<T>(method: string, args: Record<string, unknown> = {}, options: InvokeOptions = {}): Promise<T> {
  const { anna, preview } = await getRuntime();
  return guarded(async () => {
    if (preview) return previewInvoke(method, args, options) as T;
    const raw = options.async
      ? await runJob(anna, method, args, options)
      : await anna.tools.invoke(
        { tool_id: toolId(), method, args, ...(options.timeoutMs ? { timeoutMs: Math.min(options.timeoutMs, SYNC_MAX_MS) } : {}) },
        options.timeoutMs ? { timeoutMs: Math.min(options.timeoutMs, SYNC_MAX_MS) + 5_000 } : undefined,
      );
    const result = unwrap<T>(raw);
    if (result === null || result === undefined) throw new Error("");
    return result;
  });
}

/** The newest job with this client tag, or null when the host has none (or no job API). */
async function findLatestJob(anna: AnnaRuntime, clientTag: string): Promise<JobSummary | null> {
  if (typeof anna.tools.listJobs !== "function") return null;
  try {
    const listed = await anna.tools.listJobs({ clientTag, limit: 5 });
    const jobs = (Array.isArray(listed?.jobs) ? listed.jobs : []).filter((job) => job?.jobId && (!job.clientTag || job.clientTag === clientTag));
    const time = (job: JobSummary) => {
      const raw = job.createdAt ?? job.created_at ?? job.createdMs ?? job.submittedAt ?? 0;
      const value = typeof raw === "number" ? raw : new Date(String(raw)).getTime();
      return Number.isFinite(value) ? value : 0;
    };
    return jobs.sort((a, b) => time(b) - time(a))[0] ?? null;
  } catch (error) {
    if (errorCode(error) !== "not_implemented") console.warn("Could not list tool jobs.", error);
    return null;
  }
}

/** Follow a job by polling until it ends; resolves with the plugin result. */
async function followJob(anna: AnnaRuntime, jobId: string, onProgress?: (event: ToolProgress) => void): Promise<unknown> {
  if (typeof anna.tools.getJob !== "function") throw new Error("This Anna version cannot resume a running turn.");
  let since = 0;
  for (;;) {
    const snapshot = await anna.tools.getJob({ jobId, sinceSeq: since });
    for (const event of snapshot.progress || []) {
      if (typeof event?.seq !== "number" || event.seq <= since) continue;
      since = event.seq;
      try { onProgress?.(event); } catch { /* progress is best-effort */ }
    }
    if (snapshot.state === "succeeded") return snapshot.result ?? {};
    if (TERMINAL_JOB_STATES.has(snapshot.state)) {
      const error = new Error(snapshot.error?.message || `The request ended as ${snapshot.state}.`) as Error & { code?: string };
      error.code = snapshot.error?.code || (snapshot.state === "expired" ? "tool_timeout" : snapshot.state === "cancelled" ? "cancelled" : "tool_failed");
      throw error;
    }
    await sleep(2_000);
  }
}

/**
 * Adopt a job that is still running or that succeeded without its result being
 * saved. Returns undefined when there is nothing to adopt.
 */
async function adoptJob(clientTag: string, onProgress?: (event: ToolProgress) => void, onRunning?: () => void): Promise<unknown> {
  const { anna, preview } = await getRuntime();
  if (preview) return undefined;
  const job = await findLatestJob(anna, clientTag);
  if (!job) return undefined;
  if (TERMINAL_JOB_STATES.has(job.state) && job.state !== "succeeded") return undefined;
  if (!TERMINAL_JOB_STATES.has(job.state)) onRunning?.();
  return guarded(async () => unwrap(await followJob(anna, job.jobId, onProgress)));
}

// ---------------------------------------------------------------------------- storage

function isPrecondition(error: unknown): boolean {
  return errorCode(error) === "precondition_failed" || /precondition|another window/i.test(String((error as Error)?.message || error));
}

// App-scoped keys omit `scope` (the app's own bucket); only legacy reads pass "user".
async function rawGet<T>(key: string, scope?: Scope): Promise<Stored<T>> {
  const { anna } = await getRuntime();
  const stored = await anna.storage.get(scope ? { scope, key } : { key }) as Stored<T>;
  return stored && typeof stored === "object" ? stored : { exists: false };
}

async function getStored<T>(key: string): Promise<Stored<T>> {
  return guarded(() => rawGet<T>(key), "Your saved campaigns could not be loaded. Please try again.");
}

/** Read a 0.2.x value from the shared user scope. Missing or unreadable means "none". */
async function getLegacy<T>(key: string): Promise<Stored<T>> {
  try { return await rawGet<T>(key, "user"); }
  catch (error) {
    console.warn("Could not read a 0.2.x save.", error);
    return { exists: false };
  }
}

/** Conditional write: create when `previous` is absent, else replace only that version. */
async function setStored<T>(key: string, value: T, previous?: Stored): Promise<void> {
  const { anna } = await getRuntime();
  const params: { key: string; value: T; if_match?: string } = { key, value };
  if (previous?.exists) {
    if (!previous.etag) throw new Error("Anna returned no ETag. Reload the campaign before saving.");
    params.if_match = previous.etag;
  }
  await guarded(() => anna.storage.set(params), "Your progress could not be saved. Please try again.");
}

/** Unconditional write, for records owned by a single commit (turns, traces, pending). */
async function putStored<T>(key: string, value: T): Promise<void> {
  const { anna } = await getRuntime();
  await guarded(async () => {
    try {
      await anna.storage.set({ key, value });
      return;
    } catch (error) {
      if (!isPrecondition(error)) throw error;
    }
    const current = await rawGet(key);
    await anna.storage.set({ key, value, ...(current.exists && current.etag ? { if_match: current.etag } : {}) });
  }, "Your progress could not be saved. Please try again.");
}

async function removeStored(key: string): Promise<void> {
  try {
    const { anna } = await getRuntime();
    await anna.storage.delete({ key });
  } catch (error) {
    console.warn("Could not delete " + key, error);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

type IndexValue = { campaigns: IndexEntry[]; retired_legacy: string[] };

function readIndex(stored: Stored<Partial<IndexValue>>): IndexValue {
  const value = stored.exists && stored.value ? stored.value : {};
  return {
    campaigns: Array.isArray(value.campaigns) ? value.campaigns.filter((item) => item?.id) : [],
    retired_legacy: Array.isArray(value.retired_legacy) ? value.retired_legacy.map(String) : [],
  };
}

/** Retry a read-modify-write of the index once on a concurrent change. */
async function updateIndex(change: (index: IndexValue) => IndexValue): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const previous = await getStored<Partial<IndexValue>>(INDEX_KEY);
    const next = change(readIndex(previous));
    const value: IndexValue = {
      campaigns: next.campaigns.slice(0, 40),
      retired_legacy: [...new Set(next.retired_legacy)].slice(-200),
    };
    try { await setStored(INDEX_KEY, value, previous); return; }
    catch (error) { if (attempt || !isPrecondition(error)) throw error; }
  }
}

function indexEntry(state: CampaignState): IndexEntry {
  return {
    id: state.id,
    name: state.name,
    game_id: state.game_id,
    updated_at: state.updated_at,
    scene: state.scene_title,
    progress: campaignProgress(state),
    summary: state.quest_log?.at(-1) || state.premise,
  };
}

async function saveIndexEntry(state: CampaignState): Promise<void> {
  await updateIndex((index) => ({
    ...index,
    campaigns: [indexEntry(state), ...index.campaigns.filter((item) => item.id !== state.id)],
  }));
}

function campaignProgress(state: { progress?: number; turn?: number }): number {
  return Number.isFinite(state.progress) ? Number(state.progress) : Math.min(100, Math.round((Number(state.turn || 0) / 20) * 100));
}

const turnCache = new Map<string, TurnRecord>();

async function getTurnRecord(campaignId: string, turn: number): Promise<TurnRecord | null> {
  const key = turnKey(campaignId, turn);
  const cached = turnCache.get(key);
  if (cached) return cached;
  const stored = await getStored<TurnRecord>(key);
  if (!stored.exists || !stored.value || Number(stored.value.turn) !== turn) return null;
  turnCache.set(key, stored.value);
  return stored.value;
}

// ---------------------------------------------------------------------------- legacy migration

type LegacyRecord = AnyRecord & { id: string; events?: AnyRecord[]; pending?: AnyRecord | null; trace?: AnyRecord[] };

function compactEvent(event: AnyRecord): AnyRecord {
  const compact: AnyRecord = { kind: String(event.kind || "note"), turn: Number(event.turn || 0), text: String(event.text || "").slice(0, 700) };
  if (event.scene_title) compact.scene_title = String(event.scene_title).slice(0, 180);
  if (event.speaker) compact.speaker = String(event.speaker).slice(0, 100);
  return compact;
}

/** Rewrite a 0.2.x single-value campaign into the v2 layout. Returns the new state, or null. */
async function migrateLegacy(campaignId: string): Promise<Stored<CampaignState> | null> {
  const legacy = await getLegacy<LegacyRecord>(legacyCampaignKey(campaignId));
  const record = legacy.value;
  if (!legacy.exists || !record || record.id !== campaignId) return null;
  const events = Array.isArray(record.events) ? record.events : [];
  const byTurn = new Map<number, AnyRecord[]>();
  for (const event of events) {
    const turn = Number(event.turn || 0);
    byTurn.set(turn, [...(byTurn.get(turn) || []), event]);
  }
  await mapLimit([...byTurn.entries()], 4, async ([turn, turnEvents]) => {
    const narration = [...turnEvents].reverse().find((event) => event.kind === "narration");
    const turnRecord: TurnRecord = {
      turn,
      created_at: String(narration?.created_at || turnEvents[0]?.created_at || record.updated_at),
      author: narration?.author,
      scene_title: narration?.scene_title,
      events: turnEvents.map(({ snapshot: _snapshot, trace: _trace, ...rest }) => rest),
      snapshot: narration?.snapshot && typeof narration.snapshot === "object" ? narration.snapshot : {},
    };
    await putStored(turnKey(campaignId, turn), turnRecord);
    const trace = narration?.trace ?? (turn === 0 ? record.trace : undefined);
    if (Array.isArray(trace) && trace.length) await putStored(traceKey(campaignId, turn), trace);
  });
  const state: CampaignState = {
    id: record.id,
    name: String(record.name || "A New Adventure"),
    game_id: record.game_id ?? null,
    premise: String(record.premise || ""),
    created_at: String(record.created_at || new Date().toISOString()),
    updated_at: String(record.updated_at || new Date().toISOString()),
    turn: Number(record.turn || 0),
    scene_title: String(record.scene_title || "The Adventure"),
    progress: record.progress,
    quest_log: (Array.isArray(record.quest_log) ? record.quest_log : []).slice(-12),
    party: Array.isArray(record.party) ? record.party : [],
    party_breakdown: record.party_breakdown,
    metadata: record.metadata,
    intent: record.intent,
    suggested_actions: Array.isArray(record.suggested_actions) ? record.suggested_actions : [],
    state_notes: (Array.isArray(record.state_notes) ? record.state_notes : []).slice(-20),
    recent_events: events.slice(-10).map(compactEvent),
    last_draft_id: null,
    schema: 2,
  };
  if (record.pending && typeof record.pending === "object") {
    await putStored(pendingKey(campaignId), { ...record.pending, base_turn: record.pending.base_turn ?? state.turn });
  }
  try { await setStored(stateKey(campaignId), state); }
  catch (error) { if (!isPrecondition(error)) throw error; }  // another window migrated it first
  await updateIndex((index) => ({
    campaigns: [indexEntry(state), ...index.campaigns.filter((item) => item.id !== state.id)],
    retired_legacy: [...index.retired_legacy, campaignId],
  })).catch((error) => console.warn("Could not update the campaign index.", error));
  const migrated = await getStored<CampaignState>(stateKey(campaignId));
  return migrated.exists ? migrated : null;
}

const migrations = new Map<string, Promise<Stored<CampaignState> | null>>();

async function loadState(campaignId: string): Promise<Stored<CampaignState> | null> {
  const stored = await getStored<CampaignState>(stateKey(campaignId));
  if (stored.exists && stored.value?.id === campaignId) return stored;
  // History and pending restore load together on open; share one migration.
  let migration = migrations.get(campaignId);
  if (!migration) {
    migration = migrateLegacy(campaignId).finally(() => migrations.delete(campaignId));
    migrations.set(campaignId, migration);
  }
  return migration;
}

// ---------------------------------------------------------------------------- history

function snapshotFromTurn(record: TurnRecord, state: CampaignState): TurnSnapshot {
  const turn = Number(record.turn || 0);
  const events = Array.isArray(record.events) ? record.events : [];
  const narration = [...events].reverse().find((event) => event.kind === "narration");
  const action = events.find((event) => event.kind === "action");
  const check = events.find((event) => event.kind === "check");
  const snapshot: AnyRecord = record.snapshot && typeof record.snapshot === "object" ? record.snapshot : {};
  const isLatest = turn === Number(state.turn);
  const rawParty: AnyRecord[] = Array.isArray(snapshot.party) && snapshot.party.length ? snapshot.party : state.party || [];
  const party = { characters: Object.fromEntries(rawParty.map((member) => [String(member.name || "Adventurer"), {
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
  const metadata: AnyRecord = snapshot.metadata && typeof snapshot.metadata === "object" ? snapshot.metadata : snapshot;
  const timestamp = String(record.created_at || narration?.created_at || state.updated_at || new Date().toISOString());
  return {
    scene: String(snapshot.scene_summary || record.scene_title || narration?.scene_title || (isLatest ? state.scene_title : "The scene unfolds")),
    description: String(snapshot.description || (typeof action?.text === "string" ? "Party action: " + action.text : "")) || undefined,
    narrative: String(snapshot.narrative || narration?.text || ""),
    npc_name: snapshot.npc_name || undefined,
    dialogue: Array.isArray(snapshot.dialogue) ? snapshot.dialogue : [],
    party,
    party_breakdown: snapshot.party_breakdown && Object.keys(snapshot.party_breakdown).length ? snapshot.party_breakdown : state.party_breakdown as any,
    intent: snapshot.intent || (turn === 0 ? "SETUP" : state.intent || "CAMPAIGN"),
    created_dt: timestamp,
    metadata: {
      invocation_id: "anna-turn-" + turn,
      chapter: metadata.chapter,
      section: metadata.section,
      assets: metadata.assets,
      gm_notes: metadata.gm_notes,
      suggested_actions: metadata.suggested_actions || narration?.suggested_actions || (isLatest ? state.suggested_actions : []),
      math_breakdown: metadata.math_breakdown || (typeof check?.text === "string" ? check.text : undefined),
      next_scene_suggestions: metadata.next_scene_suggestions || [],
      combat_log: metadata.combat_log || [],
      requires_roll: Boolean(metadata.requires_roll || check),
    },
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
  // The Executa wraps the list in an object: the Anna host drops bare-list results.
  const result = await invokeTool<{ classes: ClassProfile[] } | ClassProfile[]>("get_class_profiles");
  const classes = Array.isArray(result) ? result : result?.classes;
  if (!Array.isArray(classes) || !classes.length) throw new Error("Please try again.");
  return classes;
}

export async function getCampaigns(): Promise<CampaignSummary[]> {
  const [current, legacy] = await Promise.all([
    getStored<Partial<IndexValue>>(INDEX_KEY),
    getLegacy<{ campaigns: IndexEntry[] }>(LEGACY_INDEX_KEY),
  ]);
  const { campaigns: entries, retired_legacy } = readIndex(current);
  const known = new Set([...entries.map((item) => item.id), ...retired_legacy]);
  // 0.2.x campaigns stay listed until their first open migrates them (or they are deleted).
  const legacyEntries = legacy.exists && Array.isArray(legacy.value?.campaigns)
    ? legacy.value.campaigns.filter((item) => item?.id && !known.has(item.id))
    : [];
  return [...entries, ...legacyEntries]
    .filter((item) => item?.id)
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .map((item) => ({
      campaign_id: item.id,
      campaign_name: item.name,
      summary: item.summary ?? null,
      progress: item.progress ?? null,
      updated_at: item.updated_at,
      scene: item.scene,
    }));
}

export async function getCampaign(campaignId: string, _includeHistory = false): Promise<Campaign> {
  const stored = await loadState(campaignId);
  if (!stored?.value) throw new Error("404 campaign not found");
  const state = stored.value;
  const turns = Array.from({ length: Number(state.turn || 0) + 1 }, (_, turn) => turn);
  const records = await mapLimit(turns, 6, (turn) => getTurnRecord(campaignId, turn));
  return {
    campaign_id: state.id,
    campaign_name: state.name,
    summary: state.quest_log?.join(" · ") || state.premise,
    progress: campaignProgress(state),
    updated_at: state.updated_at,
    created_at: state.created_at,
    state: records.filter((record): record is TurnRecord => Boolean(record)).map((record) => snapshotFromTurn(record, state)),
  };
}

// ---------------------------------------------------------------------------- game flow

type SetupResult = { state: CampaignState; turn_record: TurnRecord; trace?: AnyRecord[] };

async function commitSetup(campaignId: string, result: SetupResult): Promise<CampaignState> {
  if (!result?.state?.id || !result.turn_record) throw new Error("The opening scene could not be read. Please try again.");
  const state = { ...result.state, id: campaignId };
  await putStored(turnKey(campaignId, 0), result.turn_record);
  if (Array.isArray(result.trace) && result.trace.length) {
    await putStored(traceKey(campaignId, 0), result.trace).catch((error) => console.warn("Could not save the setup trace.", error));
  }
  try {
    await setStored(stateKey(campaignId), state);
  } catch (error) {
    const existing = await loadState(campaignId);
    if (existing?.value) return existing.value;  // another window finished setup first
    throw error;
  }
  turnCache.set(turnKey(campaignId, 0), result.turn_record);
  await saveIndexEntry(state).catch((error) => console.warn("Could not update the campaign index.", error));
  return state;
}

export async function createCampaign(
  args: { campaignId: string; name: string; gameId: string; premise: string; party: Array<Record<string, unknown>> },
  options: { onProgress?: (event: ToolProgress) => void } = {},
): Promise<CampaignState> {
  const existing = await loadState(args.campaignId);
  if (existing?.value) return existing.value;
  const clientTag = `setup:${args.campaignId}`;
  // A reload during setup re-adopts the job instead of paying for a second one.
  const adopted = await adoptJob(clientTag, options.onProgress);
  const result = adopted !== undefined
    ? adopted as SetupResult
    : await invokeTool<SetupResult>("create_campaign", {
      campaign_id: args.campaignId,
      name: args.name,
      game_id: args.gameId,
      premise: args.premise,
      party: args.party,
    }, { async: true, clientTag, timeoutMs: SETUP_JOB_MS, onProgress: options.onProgress });
  return commitSetup(args.campaignId, result);
}

function isLivePending(draft: Draft | undefined, state: CampaignState): draft is Draft {
  return Boolean(draft)
    && draft!.campaign_id === state.id
    && !draft!.blocked
    && draft!.id !== state.last_draft_id
    && (draft!.base_turn === undefined || draft!.base_turn === null || Number(draft!.base_turn) === Number(state.turn));
}

/** The saved draft awaiting approval; stale drafts (already resolved or for an older turn) are cleared. */
export async function getPendingDraft(campaignId: string): Promise<Draft | null> {
  // State first: loading it may migrate a legacy save, which writes the pending key.
  const stored = await loadState(campaignId);
  const pending = await getStored<Draft>(pendingKey(campaignId));
  if (!pending.exists || !pending.value) return null;
  if (!stored?.value || !isLivePending(pending.value, stored.value)) {
    if (stored?.value) await removeStored(pendingKey(campaignId));
    return null;
  }
  return pending.value;
}

/** Whether an in-memory draft can still be approved (not resolved, not for an older turn). */
export async function isDraftLive(campaignId: string, draft: Draft | null | undefined): Promise<boolean> {
  if (!draft) return false;
  const stored = await loadState(campaignId);
  return Boolean(stored?.value && isLivePending(draft, stored.value));
}

export async function draftTurn(
  campaignId: string,
  action: string,
  dice: Record<string, unknown>,
  options: { onProgress?: (event: ToolProgress) => void; signal?: AbortSignal } = {},
): Promise<Draft> {
  const stored = await loadState(campaignId);
  if (!stored?.value) throw new Error("The saved campaign could not be found. Resume it again to continue.");
  if (await getPendingDraft(campaignId)) throw new Error("Resolve the pending turn before sending another action.");
  const draft = await invokeTool<Draft>("draft_turn", { campaign: stored.value, action, dice }, {
    async: true, clientTag: `draft:${campaignId}`, timeoutMs: DRAFT_JOB_MS, ...options,
  });
  if (!draft.blocked) {
    // The draft is already paid for: if saving it fails, still show it. Approving it later
    // passes it to resolveTurn as the fallback, and a reload re-adopts the finished job.
    try { await putStored(pendingKey(campaignId), draft); }
    catch (error) { console.warn("Could not save the pending draft; keeping it in memory.", error); }
  }
  return draft;
}

/** Approve or reject the pending draft and commit the result. */
export async function resolveTurn(campaignId: string, approved: boolean, fallbackDraft?: Draft | null): Promise<void> {
  const stored = await loadState(campaignId);
  if (!stored?.value) throw new Error("The saved campaign could not be found. Resume it again to continue.");
  const pending = await getStored<Draft>(pendingKey(campaignId));
  const draft = pending.exists && pending.value ? pending.value : fallbackDraft;
  if (!draft) throw new Error("The pending draft is no longer available.");
  const result = await invokeTool<{ state: CampaignState; turn_record: TurnRecord | null }>(
    "resolve_turn", { campaign: stored.value, draft, approved }, { timeoutMs: 30_000 },
  );
  if (!result?.state?.id) throw new Error("The turn could not be resolved. Please try again.");
  const record = result.turn_record;
  if (record) {
    await putStored(turnKey(campaignId, record.turn), record);
    if (Array.isArray(draft.trace) && draft.trace.length) {
      await putStored(traceKey(campaignId, record.turn), draft.trace).catch((error) => console.warn("Could not save the turn trace.", error));
    }
  }
  await setStored(stateKey(campaignId), result.state, stored);  // commit point
  if (record) turnCache.set(turnKey(campaignId, record.turn), record);
  await saveIndexEntry(result.state).catch((error) => console.warn("Could not update the campaign index.", error));
  await removeStored(pendingKey(campaignId));
}

export type RecoveredRun = { kind: "none" } | { kind: "setup" } | { kind: "draft"; draft: Draft };

/**
 * After a reload, pick up a setup or draft job that is still running or that
 * finished while the page was away. `onRunning` fires before waiting on a live job.
 */
export async function recoverRun(
  campaignId: string,
  options: { onProgress?: (event: ToolProgress) => void; onRunning?: (kind: "setup" | "draft") => void } = {},
): Promise<RecoveredRun> {
  const stored = await loadState(campaignId);
  if (!stored?.value) {
    const result = await adoptJob(`setup:${campaignId}`, options.onProgress, () => options.onRunning?.("setup"));
    if (result === undefined) return { kind: "none" };
    await commitSetup(campaignId, result as SetupResult);
    return { kind: "setup" };
  }
  const pending = await getStored<Draft>(pendingKey(campaignId));
  if (pending.exists) return { kind: "none" };
  const result = await adoptJob(`draft:${campaignId}`, options.onProgress, () => options.onRunning?.("draft"));
  if (result === undefined) return { kind: "none" };
  const draft = result as Draft;
  const fresh = await loadState(campaignId);
  if (!fresh?.value || !isLivePending(draft, fresh.value)) return { kind: "none" };
  await putStored(pendingKey(campaignId), draft);
  return { kind: "draft", draft };
}

export async function deleteCampaign(campaignId: string): Promise<void> {
  // Drop the list entry first so a partial delete never shows a broken campaign. A 0.2.x
  // save cannot be deleted from the read-only user scope, so it is hidden instead.
  await updateIndex((index) => ({
    campaigns: index.campaigns.filter((item) => item.id !== campaignId),
    retired_legacy: [...index.retired_legacy, campaignId],
  }));
  const stored = await getStored<CampaignState>(stateKey(campaignId));
  const lastTurn = Number(stored.value?.turn || 0);
  await removeStored(stateKey(campaignId));
  const keys = [pendingKey(campaignId)];
  for (let turn = 0; turn <= lastTurn; turn++) keys.push(turnKey(campaignId, turn), traceKey(campaignId, turn));
  await mapLimit(keys, 6, removeStored);
  for (const key of keys) turnCache.delete(key);
}

// ---------------------------------------------------------------------------- voice
// Speech runs on Anna's own audio API: no API key, billed to the user's Anna quota.

let ttsModelPromise: Promise<TtsModel | null> | null = null;

/** The user's preferred catalogue TTS model, falling back to the first usable one. */
function getTtsModel(): Promise<TtsModel | null> {
  ttsModelPromise ??= (async () => {
    const { anna, preview } = await getRuntime();
    if (preview || typeof anna.llm?.catalog !== "function") return null;
    const catalog = await anna.llm.catalog({ serviceType: "tts" });
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    const usable = models.filter((model) => model?.capabilities?.voices?.length || model?.capabilities?.defaultVoice);
    return usable.find((model) => model.isUserPreferred) ?? usable[0] ?? null;
  })().catch((error) => {
    console.warn("Could not read the speech catalogue.", error);
    ttsModelPromise = null;
    return null;
  });
  return ttsModelPromise;
}

/** Whether the host offers speech. Any failure simply means "no voice". */
export async function getVoiceAvailable(): Promise<boolean> {
  return Boolean(await getTtsModel());
}

/** Longest text one speech call accepts. */
export async function getSpeechChunkLimit(): Promise<number> {
  const limit = Number((await getTtsModel())?.capabilities?.maxCharsPerCall);
  return Number.isFinite(limit) && limit >= 100 ? limit : 1000;
}

/** Gender and stable hash of the speaker name encoded by `resolveVoiceName` (for example, "female:123"). */
function parseVoiceHint(hint?: string): { gender: string; speakerHash: number } {
  const [gender = "any", hashText] = String(hint || "").split(":");
  return { gender, speakerHash: Number(hashText) };
}

/** Voice candidates for a speaker, preferring voices matching their gender. */
function voiceCandidates(model: TtsModel, hint?: string): string[] {
  const voices = model.capabilities?.voices ?? [];
  const { gender } = parseVoiceHint(hint);
  const matching = gender === "female" || gender === "male"
    ? voices.filter((voice) => String(voice.gender || "").toLowerCase() === gender)
    : [];
  const pool = matching.length ? [...matching, ...voices.filter((voice) => !matching.includes(voice))] : voices;
  return [...new Set([
    ...pool.map((voice) => voice.id),
    model.capabilities?.defaultVoice,
  ].filter((id): id is string => Boolean(id)))];
}

/** The hint carries a hash of the speaker's string name; use it to choose an initial voice. */
function pickVoice(model: TtsModel, hint?: string, candidates = voiceCandidates(model, hint)): string | undefined {
  const { gender, speakerHash } = parseVoiceHint(hint);
  if (!candidates.length) return model.capabilities?.defaultVoice;
  if (!Number.isFinite(speakerHash)) return model.capabilities?.defaultVoice ?? candidates[0];
  const voices = model.capabilities?.voices ?? [];
  const matching = gender === "female" || gender === "male"
    ? voices.filter((voice) => String(voice.gender || "").toLowerCase() === gender)
    : [];
  const primary = matching.length ? matching.map((voice) => voice.id) : voices.map((voice) => voice.id);
  const pool = primary.length ? primary : candidates;
  return pool[Math.abs(speakerHash) % pool.length];
}

function savedVoiceKey(model: TtsModel, hint?: string): string | null {
  if (!hint) return null;
  const modelKey = model.name ?? model.id;
  if (!modelKey) return null;
  return `${PREFIX}:tts-voice:${encodeURIComponent(modelKey)}:${encodeURIComponent(hint)}`;
}

function getSavedVoice(model: TtsModel, hint: string | undefined): string | undefined {
  const key = savedVoiceKey(model, hint);
  if (!key || typeof localStorage === "undefined") return undefined;
  try {
    const voice = localStorage.getItem(key) ?? undefined;
    return voice || undefined;
  } catch {
    return undefined;
  }
}

function saveVoice(model: TtsModel, hint: string | undefined, voice: string | undefined): void {
  const key = savedVoiceKey(model, hint);
  if (!key || !voice || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, voice);
  } catch {
    // Voice persistence is best effort; playback should still succeed.
  }
}

function errorData(error: unknown): AnyRecord {
  const value = error as AnyRecord | null;
  return (value?.data || value?.error?.data || {}) as AnyRecord;
}

function allowedVoiceIds(error: unknown): string[] {
  const allowed = errorData(error).allowed;
  if (!Array.isArray(allowed)) return [];
  return [...new Set(allowed.map((voice) => {
    if (typeof voice === "string") return voice;
    if (voice && typeof voice === "object") return String((voice as AnyRecord).id || "");
    return "";
  }).filter(Boolean))];
}

/** Pick one untried alternate, preferring an API-provided allow-list and matching gender. */
function retryVoice(
  model: TtsModel,
  hint: string | undefined,
  rejected: string | undefined,
  allowed: string[],
  excluded: Set<string>,
): string | undefined {
  const voices = model.capabilities?.voices ?? [];
  const ids = allowed.length ? allowed : voices.map((voice) => voice.id);
  const { gender, speakerHash } = parseVoiceHint(hint);
  const matching = gender === "female" || gender === "male"
    ? ids.filter((id) => String(voices.find((voice) => voice.id === id)?.gender || "").toLowerCase() === gender)
    : [];
  const pool = (matching.length ? [...matching, ...ids.filter((id) => !matching.includes(id))] : ids)
    .filter((id) => id !== rejected && id !== model.capabilities?.defaultVoice && !excluded.has(id));
  if (!pool.length) return undefined;
  return Number.isFinite(speakerHash) ? pool[Math.abs(speakerHash) % pool.length] : pool[0];
}

function isUnsupportedVoiceError(error: unknown): boolean {
  const value = error as AnyRecord | null;
  const message = typeof error === "string"
    ? error
    : String(value?.message || value?.error?.message || value?.reason || error || "");
  const code = errorCode(error).toUpperCase();
  return code === "AUDIO_VOICE_INVALID" || code === "-32145" || /AUDIO_VOICE_INVALID|voice.{0,80}(?:not supported|unsupported)|(?:not supported|unsupported).{0,80}voice/i.test(message);
}

function base64ToBytes(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(binary);
}

/** Synthesize one chunk of speech; resolves with encoded audio bytes for decodeAudioData. */
export async function speakText(text: string, voiceHint?: string): Promise<ArrayBuffer> {
  const { anna } = await getRuntime();
  const model = await getTtsModel();
  if (!model || typeof anna.audio?.speak !== "function") throw new Error("Voice is not available in this Anna workspace.");
  return guarded(async () => {
    const candidates = voiceCandidates(model, voiceHint);
    const savedVoice = getSavedVoice(model, voiceHint);
    const firstVoice = savedVoice ?? pickVoice(model, voiceHint, candidates);
    const defaultVoice = model.capabilities?.defaultVoice;
    let out: { audioBase64?: string; url?: string; mimeType?: string } | undefined;
    let successfulVoice = firstVoice;
    const attempted = new Set<string>();
    let allowed: string[] = [];

    const attempt = async (voice: string | undefined): Promise<boolean> => {
      if (voice) attempted.add(voice);
      try {
        out = await anna.audio!.speak!({
          text,
          model: model.name ?? model.id,
          voice,
          delivery: "inline",
        });
        successfulVoice = voice;
        return true;
      } catch (error) {
        if (!isUnsupportedVoiceError(error)) throw error;
        allowed = allowedVoiceIds(error);
        return false;
      }
    };

    const firstSucceeded = await attempt(firstVoice);
    if (!firstSucceeded) {
      // AUDIO_VOICE_INVALID may include the exact valid ids in data.allowed.
      // Use that list to pick one alternate, keeping retries bounded.
      const alternate = retryVoice(model, voiceHint, firstVoice, allowed, attempted);
      if (alternate) {
        await attempt(alternate);
      }
    }

    if (!out && defaultVoice && !attempted.has(defaultVoice)) {
      await attempt(defaultVoice);
    }

    if (!out) {
      // The catalogue may not match the backend's accepted voice IDs. Give the
      // backend one chance to use its own default by omitting `voice` entirely.
      out = await anna.audio!.speak!({
        text,
        model: model.name ?? model.id,
        delivery: "inline",
      });
      successfulVoice = undefined;
    }
    saveVoice(model, voiceHint, successfulVoice);
    if (out?.audioBase64) return base64ToBytes(out.audioBase64);
    if (out?.url) {
      const response = await fetch(out.url);
      if (!response.ok) throw new Error("The voice line could not be downloaded.");
      return response.arrayBuffer();
    }
    throw new Error("Anna returned no audio for that line.");
  }, "The voice line could not be played. Please try again.");
}

/** Transcribe a recorded clip (webm/ogg/mp4 from MediaRecorder). */
export async function transcribeAudio(clip: Blob): Promise<string> {
  const { anna, preview } = await getRuntime();
  if (preview || typeof anna.audio?.transcribe !== "function") throw new Error("Voice is not available in this Anna workspace.");
  const format = /ogg/.test(clip.type) ? "ogg" : /mp4|aac|m4a/.test(clip.type) ? "mp4" : /wav/.test(clip.type) ? "wav" : "webm";
  return guarded(async () => {
    const result = await anna.audio!.transcribe!({ audioBase64: await blobToBase64(clip), format });
    return String(result?.text || "").trim();
  }, "Your voice could not be transcribed. Please try again.");
}

const toSeconds = (value: unknown, fallback: number) => {
  const ms = new Date(String(value ?? "")).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : fallback;
};

/**
 * Expand an Executa trace into timeline events. Tool entries become a call
 * event and a result event, matching the ADK stream the original client shows.
 * Event ids derive from the trace entry id, so a live progress entry and the
 * same entry in the finished draft render once.
 */
export function traceToEvents(trace: unknown, invocationId: string, timestamp: number): SessionEvent[] {
  const entries = Array.isArray(trace) ? trace as AnyRecord[] : [];
  const events: SessionEvent[] = [];
  entries.forEach((entry, index) => {
    const author = String(entry.agent || "dnd_game_master_agent");
    const at = toSeconds(entry.created_at, timestamp + index + 1);
    const id = invocationId + "-trace-" + (entry.id ? String(entry.id) : index);
    if (entry.kind !== "tool") {
      events.push({ id, invocation_id: invocationId, timestamp: at, author, content: { parts: [{ text: String(entry.detail || author) }] } });
      return;
    }
    const args = entry.args && typeof entry.args === "object" ? entry.args : {};
    events.push({ id: id + "-call", invocation_id: invocationId, timestamp: at, author, content: { parts: [{ function_call: { name: author, args } }] } });
    events.push({
      id: id + "-result",
      invocation_id: invocationId,
      timestamp: at,
      author,
      content: { parts: [{ function_response: { name: author, response: entry.result ?? { detail: String(entry.detail || "") } } }] },
    });
  });
  return events;
}

/** Timeline events for one live progress event from a tool job. */
export function progressToEvents(event: ToolProgress, invocationId: string): SessionEvent[] {
  const entry = event?.data?.entry;
  if (!entry || typeof entry !== "object") return [];
  return traceToEvents([{ id: `live-${event.seq}`, ...entry }], invocationId, Math.floor(Date.now() / 1000));
}

export async function getHistoricalEvents(campaignId: string, invocationId: string): Promise<SessionEvent[]> {
  const turn = Number(invocationId.replace(/^anna-turn-/, ""));
  if (!Number.isInteger(turn) || turn < 0) return [];
  const [record, trace] = await Promise.all([
    getTurnRecord(campaignId, turn),
    getStored<AnyRecord[]>(traceKey(campaignId, turn)),
  ]);
  if (!record) return [];
  const turnEvents = Array.isArray(record.events) ? record.events : [];
  const action = turnEvents.find((event) => event.kind === "action");
  const narration = [...turnEvents].reverse().find((event) => event.kind === "narration");
  const start = toSeconds(action?.created_at ?? narration?.created_at ?? record.created_at, Math.floor(Date.now() / 1000));
  const events: SessionEvent[] = [];
  if (action) {
    events.push({ id: String(action.id || `${invocationId}-player`), invocation_id: invocationId, timestamp: start, author: "user", content: { parts: [{ text: String(action.text || "") }] } });
  }
  events.push(...traceToEvents(trace.exists ? trace.value : [], invocationId, start));
  if (narration) {
    events.push({
      id: String(narration.id || `${invocationId}-narration`),
      invocation_id: invocationId,
      timestamp: toSeconds(narration.created_at, start + events.length),
      author: String(narration.author || record.author || (turn === 0 ? "setup_agent" : "dnd_game_master_agent")),
      content: { parts: [{ text: String(narration.text || "") }] },
    });
  }
  return events;
}

// ---------------------------------------------------------------------------- local preview

const previewEntries = (labels: Array<[string, string, string]>) => labels.map(([agent, kind, detail]) => ({
  id: crypto.randomUUID(), agent, kind, detail, created_at: new Date().toISOString(),
}));

function emitPreviewProgress(trace: AnyRecord[], options: InvokeOptions) {
  trace.forEach((entry, index) => {
    try { options.onProgress?.({ seq: index + 1, type: "tool_update", data: { entry } }); } catch { /* ignore */ }
  });
}

/** Offline stand-in for the Executa (`?preview=1` on localhost), returning the same shapes. */
function previewInvoke(method: string, args: Record<string, any>, options: InvokeOptions = {}): any {
  const now = new Date().toISOString();
  if (method === "get_class_profiles") {
    const classes = classSpecs.map(([name, hit_dice, hp_at_1st_level, prof_saving_throws, spellcasting_ability, prof_armor, prof_weapons, skills, roles]) => ({
      name, slug: name.toLowerCase(), desc: name + " adventurer", hit_dice, hp_at_1st_level,
      prof_armor, prof_weapons, prof_saving_throws, prof_skills: "Choose 2 from " + skills,
      spellcasting_ability, subtypes_name: "Archetype",
      archetypes: roles.map((role) => ({ name: role, slug: role.toLowerCase().replaceAll(" ", "-"), desc: role + " archetype" })),
    }));
    return { classes };
  }
  if (method === "create_campaign") {
    const party = (args.party as AnyRecord[]).map((member) => ({ ...member, id: crypto.randomUUID(), hp: 12, max_hp: 12, armor_class: 12 }));
    const narration = { id: crypto.randomUUID(), kind: "narration", turn: 0, scene_title: "Port Nyanzaru", text: "Heat shimmers above the harbor stones as your party reaches Port Nyanzaru. Bright sails crowd the bay, traders call from the waterfront, and rumors of a death curse move through the city. A local guide waits beneath a canvas awning, watching your group with wary interest.", author: "setup_agent", created_at: now };
    const suggested = ["Ask about the death curse", "Find a guide for the jungle", "Gather rumors at the harbor"];
    const trace = previewEntries([["fetch_campaign_files", "tool", "Retrieved 3 indexed adventure excerpts."], ["setup_executor", "agent", "Prepared a setup response."], ["setup_checker", "evaluator", "Setup structure validated."]]);
    emitPreviewProgress(trace, options);
    const state: CampaignState = {
      id: args.campaign_id || crypto.randomUUID(), name: args.name, game_id: args.game_id, premise: args.premise,
      created_at: now, updated_at: now, turn: 0, scene_title: "Port Nyanzaru", party,
      quest_log: ["Investigate the death curse and follow its trail into Chult."], state_notes: [],
      suggested_actions: suggested, recent_events: [compactEvent(narration)], last_draft_id: null, schema: 2,
      metadata: { suggested_actions: suggested },
    };
    return { state, turn_record: { turn: 0, created_at: now, author: "setup_agent", scene_title: "Port Nyanzaru", events: [narration], snapshot: { intent: "SETUP", scene_summary: "Port Nyanzaru", narrative: narration.text, party, metadata: { suggested_actions: suggested } } }, trace };
  }
  const campaign = args.campaign as CampaignState | undefined;
  if (method === "draft_turn" && campaign) {
    const trace = previewEntries([["input_guardrail", "guardrail", "Input passed."], ["intent_classifier", "agent", "Routed to CAMPAIGN."], ["campaign_executor", "agent", "Drafting specialist response."], ["campaign_evaluator", "evaluator", "The draft answers the player."]]);
    emitPreviewProgress(trace, options);
    const narrative = "The guide points toward a trail leading inland. Beyond the harbor, the green wall of Chult rises beneath a haze of heat. A runner pushes through the crowd with a warning: the death curse has reached another household, and the party's lead may be the only one that points toward its source.";
    return {
      id: crypto.randomUUID(), campaign_id: campaign.id, base_turn: campaign.turn, action: args.action, intent: "CAMPAIGN",
      scene_title: "At the Harbor Gate", scene_summary: "At the Harbor Gate", narration: narrative, narrative,
      suggested_actions: ["Ask about the death curse", "Find a guide for the jungle", "Gather rumors at the harbor"],
      math_breakdown: (args.dice as any)?.d20 ? `Wisdom check · DC 12 — the party rolled a d20: ${(args.dice as any).d20}` : "",
      state_changes: [{ kind: "clue", text: "A guide has offered to lead the party into Chult." }],
      trace, last_agent: ["input_guardrail", "intent_classifier", "campaign_executor", "campaign_evaluator"],
      evaluation: { grade: "pass", comment: "Preview draft." }, created_at: now,
    };
  }
  if (method === "resolve_turn" && campaign) {
    const draft = args.draft as AnyRecord;
    const state: CampaignState = structuredClone(campaign);
    state.updated_at = now;
    state.last_draft_id = draft.id;
    if (!args.approved) return { state, turn_record: null };
    const turn = Number(state.turn || 0) + 1;
    const events: AnyRecord[] = [
      { id: crypto.randomUUID(), kind: "action", turn, text: draft.action, created_at: now },
      { id: crypto.randomUUID(), kind: "narration", turn, scene_title: draft.scene_title, suggested_actions: draft.suggested_actions, text: draft.narrative, author: "campaign_executor", created_at: now },
    ];
    if (draft.math_breakdown) events.push({ id: crypto.randomUUID(), kind: "check", turn, text: draft.math_breakdown, created_at: now });
    state.recent_events = [...state.recent_events, ...events.map(compactEvent)].slice(-10);
    state.state_notes = [...state.state_notes, ...(draft.state_changes || []).map((change: AnyRecord) => ({ ...change, turn }))].slice(-20);
    state.scene_title = draft.scene_title;
    state.suggested_actions = draft.suggested_actions || [];
    state.turn = turn;
    const snapshot = { intent: draft.intent, scene_summary: draft.scene_title, narrative: draft.narrative, suggested_actions: draft.suggested_actions, math_breakdown: draft.math_breakdown, party: state.party };
    return { state, turn_record: { turn, created_at: now, author: "campaign_executor", scene_title: draft.scene_title, draft_id: draft.id, events, snapshot } };
  }
  throw new Error("The local preview could not complete that request.");
}
