"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useGame } from "@/context/GameContext";
import { GAME_CATALOG } from "@/lib/games";
import { createCampaign, getCampaignRecord, invokeTool, saveCampaignRecord, type CampaignRecord } from "@/lib/api";
import type { SessionEvent, TurnSnapshot } from "@/lib/types";

export type RunStatus = "idle" | "running" | "awaiting_approval" | "rejecting" | "error";
export interface DiceRolls { d20?: number | null; d100?: number | null }

interface ConsoleState {
  activeIndex: number;
  viewPending: boolean;
  runStatus: RunStatus;
  events: SessionEvent[];
  pendingDraft: string | null;
  composerDraft: string;
  error: string | null;
  streamDelaying: boolean;
  readerTab: "scene" | "timeline";
}
const initialState: ConsoleState = {
  activeIndex: -1, viewPending: false, runStatus: "idle", events: [], pendingDraft: null,
  composerDraft: "", error: null, streamDelaying: false, readerTab: "scene",
};
type Action =
  | { type: "SELECT_TURN"; index: number }
  | { type: "SELECT_PENDING" }
  | { type: "SET_COMPOSER"; text: string }
  | { type: "RUN_START"; events?: SessionEvent[] }
  | { type: "AWAIT_APPROVAL"; draft: string; events: SessionEvent[] }
  | { type: "RUN_DONE" }
  | { type: "REJECTING" }
  | { type: "REJECTED" }
  | { type: "RUN_ERROR"; message: string }
  | { type: "SET_READER_TAB"; tab: "scene" | "timeline" };
function reducer(state: ConsoleState, action: Action): ConsoleState {
  switch (action.type) {
    case "SELECT_TURN": return { ...state, activeIndex: action.index, viewPending: false };
    case "SELECT_PENDING": return { ...state, viewPending: true };
    case "SET_COMPOSER": return { ...state, composerDraft: action.text };
    case "RUN_START": return { ...state, runStatus: "running", viewPending: true, events: action.events ?? [], pendingDraft: null, error: null };
    case "AWAIT_APPROVAL": return { ...state, runStatus: "awaiting_approval", viewPending: true, pendingDraft: action.draft, events: action.events, error: null };
    case "RUN_DONE": return { ...state, runStatus: "idle", viewPending: false, events: [], pendingDraft: null, error: null };
    case "REJECTING": return { ...state, runStatus: "rejecting", pendingDraft: null };
    case "REJECTED": return { ...state, runStatus: "idle", viewPending: false, events: [], pendingDraft: null, error: null };
    case "RUN_ERROR": return { ...state, runStatus: "error", viewPending: false, error: action.message };
    case "SET_READER_TAB": return { ...state, readerTab: action.tab };
    default: return state;
  }
}

interface ConsoleContextValue {
  campaignId: string | null;
  campaignName: string;
  history: TurnSnapshot[];
  historyLoading: boolean;
  progress: number | null;
  summary: string | null;
  activeIndex: number;
  activeSnapshot: TurnSnapshot | null;
  pending: boolean;
  viewPending: boolean;
  runStatus: RunStatus;
  events: SessionEvent[];
  pendingDraft: string | null;
  composerDraft: string;
  error: string | null;
  streamDelaying: boolean;
  submitTurn: (args: { text: string; dice?: DiceRolls }) => void;
  approve: () => void;
  reject: () => void;
  reconnectStream: () => void;
  selectTurn: (index: number) => void;
  selectPending: () => void;
  setComposerDraft: (text: string) => void;
  readerTab: "scene" | "timeline";
  setReaderTab: (tab: "scene" | "timeline") => void;
}
const ConsoleContext = createContext<ConsoleContextValue | null>(null);

interface ConsoleProviderProps {
  history: TurnSnapshot[];
  historyLoading: boolean;
  progress: number | null;
  summary: string | null;
  reloadHistory: () => void;
  campaignId: string | null;
  children: ReactNode;
}

function toDraftSnapshot(draft: Record<string, any>): string {
  return JSON.stringify({
    scene_summary: draft.scene_summary || draft.scene_title,
    narrative: draft.narrative || draft.narration,
    description: draft.description,
    suggested_actions: draft.suggested_actions || [],
    next_scene_suggestions: draft.next_scene_suggestions || [],
    chapter: draft.chapter,
    section: draft.section,
    gm_notes: draft.gm_notes,
    assets: draft.assets || [],
    combat_log: draft.combat_log || [],
    math_breakdown: draft.math_breakdown,
    requires_roll: draft.requires_roll,
    dialogue: draft.dialogue || [],
    npc_name: draft.npc_name,
    party: draft.party || [],
    party_breakdown: draft.party_breakdown,
    intent: draft.intent || "CAMPAIGN",
  });
}

function pendingEvents(action: string, draft: Record<string, any>, invocationId: string): SessionEvent[] {
  const timestamp = Math.floor(Date.now() / 1000);
  const trace: any[] = Array.isArray(draft.trace) ? draft.trace : [];
  const events: SessionEvent[] = [
    { id: invocationId + "-player", invocation_id: invocationId, timestamp, author: "user", content: { parts: [{ text: action }] } },
  ];
  trace.forEach((entry, index) => {
    const detail = String(entry.detail || entry.agent || "Working");
    const part = entry.kind === "tool"
      ? { function_call: { name: String(entry.agent || "tool"), args: {} } }
      : { text: detail };
    events.push({
      id: invocationId + "-trace-" + index,
      invocation_id: invocationId,
      timestamp: timestamp + index + 1,
      author: String(entry.agent || "dnd_game_master_agent"),
      content: { parts: [part] },
    });
  });
  events.push(
    { id: invocationId + "-draft", invocation_id: invocationId, timestamp: timestamp + trace.length + 1, author: String(draft.last_agent?.at(-2) || "dnd_game_master_agent"), content: { parts: [{ text: String(draft.narrative || draft.narration || "The Dungeon Master has prepared a draft.") }] } },
    { id: invocationId + "-approval", invocation_id: invocationId, timestamp: timestamp + trace.length + 2, author: "hitl_approval", content: { parts: [{ function_call: { name: "adk_request_input", args: { draft_id: draft.id } } }] } },
  );
  return events;
}

export function ConsoleProvider({ history, historyLoading, progress, summary, reloadHistory, campaignId, children }: ConsoleProviderProps) {
  const { state: game, dispatch: gameDispatch } = useGame();
  const [state, dispatch] = useReducer(reducer, initialState);
  const [pendingObject, setPendingObject] = useState<Record<string, any> | null>(null);
  const busyRef = useRef(false);
  const autoStartedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (history.length && state.runStatus === "idle") dispatch({ type: "SELECT_TURN", index: history.length - 1 });
  }, [history.length, state.runStatus]);

  const campaignName = useMemo(() => {
    const entry = GAME_CATALOG.find((item) => item.id === game.selectedGameId);
    return entry?.title ?? game.selectedGameId ?? campaignId ?? "the adventure";
  }, [game.selectedGameId, campaignId]);

  useEffect(() => {
    if (!game.autoStart || !campaignId || autoStartedForRef.current === campaignId || busyRef.current) return;
    autoStartedForRef.current = campaignId;
    gameDispatch({ type: "CONSUME_AUTOSTART" });
    const entry = GAME_CATALOG.find((item) => item.id === game.selectedGameId);
    if (!entry) {
      dispatch({ type: "RUN_ERROR", message: "Choose an adventure before beginning." });
      return;
    }
    busyRef.current = true;
    // The setup agent runs inside one tool call (no stream), so seed the live
    // timeline with its kickoff instead of leaving the pending view blank.
    const invocationId = `anna-setup-${campaignId}`;
    const timestamp = Math.floor(Date.now() / 1000);
    dispatch({
      type: "RUN_START",
      events: [
        { id: invocationId + "-player", invocation_id: invocationId, timestamp, author: "user", content: { parts: [{ text: `Begin ${entry.title}` }] } },
        { id: invocationId + "-setup", invocation_id: invocationId, timestamp: timestamp + 1, author: "setup_executor", content: { parts: [{ text: "Gathering the story, party classes and opening scene…" }] } },
      ],
    });
    void createCampaign({
      campaignId,
      name: entry.title,
      gameId: entry.id,
      premise: entry.blurb,
      party: game.party.filter((member) => member.name.trim()).map((member) => ({
        name: member.name.trim(), class: member.className, role: member.role || member.className,
        skills: member.skills || [], ancestry: "Human",
      })),
    }).then(() => {
      reloadHistory();
      dispatch({ type: "RUN_DONE" });
    }).catch((error: unknown) => {
      dispatch({ type: "RUN_ERROR", message: error instanceof Error ? error.message : "The campaign could not be created." });
    }).finally(() => { busyRef.current = false; });
  }, [game.autoStart, game.selectedGameId, game.party, campaignId, gameDispatch, reloadHistory]);

  const restorePending = useCallback(async () => {
    if (!campaignId) return;
    const campaign = await getCampaignRecord(campaignId);
    if (!campaign?.pending) return;
    const draft = campaign.pending as Record<string, any>;
    const invocationId = `anna-${draft.id || campaignId}`;
    setPendingObject(draft);
    dispatch({ type: "AWAIT_APPROVAL", draft: toDraftSnapshot(draft), events: pendingEvents(String(draft.action || ""), draft, invocationId) });
  }, [campaignId]);

  useEffect(() => {
    if (!campaignId || game.autoStart) return;
    let cancelled = false;
    void restorePending().catch((error: unknown) => {
      if (!cancelled) dispatch({ type: "RUN_ERROR", message: error instanceof Error ? error.message : "Could not restore the pending turn." });
    });
    return () => { cancelled = true; };
  }, [campaignId, game.autoStart, restorePending]);

  const submitTurn = useCallback(async ({ text, dice }: { text: string; dice?: DiceRolls }) => {
    if (busyRef.current || (state.runStatus !== "idle" && state.runStatus !== "error")) return;
    const action = text.trim();
    if (!action || !campaignId) {
      if (!campaignId) dispatch({ type: "RUN_ERROR", message: "No campaign selected." });
      return;
    }
    busyRef.current = true;
    dispatch({ type: "RUN_START" });
    try {
      const campaign = await getCampaignRecord(campaignId);
      if (!campaign) throw new Error("The saved campaign could not be found. Resume it again to continue.");
      if (campaign.pending) throw new Error("Resolve the pending turn before sending another action.");
      const draft = await invokeTool<Record<string, any>>("draft_turn", { campaign, action, dice: dice || {} });
      if (draft.blocked) {
        dispatch({ type: "RUN_ERROR", message: String(draft.narrative || "That request is outside this adventure.") });
        return;
      }
      const updated = { ...campaign, pending: draft, updated_at: new Date().toISOString() };
      await saveCampaignRecord(updated);
      setPendingObject(draft);
      dispatch({ type: "AWAIT_APPROVAL", draft: toDraftSnapshot(draft), events: pendingEvents(action, draft, `anna-${draft.id}`) });
    } catch (error) {
      dispatch({ type: "RUN_ERROR", message: error instanceof Error ? error.message : "The Dungeon Master could not draft this turn." });
    } finally { busyRef.current = false; }
  }, [campaignId, state.runStatus]);

  const resolve = useCallback(async (approved: boolean) => {
    if (!campaignId || busyRef.current || state.runStatus !== "awaiting_approval") return;
    busyRef.current = true;
    dispatch({ type: approved ? "RUN_START" : "REJECTING" });
    try {
      const campaign = await getCampaignRecord(campaignId);
      const draft = campaign?.pending || pendingObject;
      if (!campaign || !draft) throw new Error("The pending draft is no longer available.");
      const updated = await invokeTool<CampaignRecord>("resolve_turn", { campaign, draft, approved });
      await saveCampaignRecord(updated);
      setPendingObject(null);
      reloadHistory();
      dispatch({ type: approved ? "RUN_DONE" : "REJECTED" });
    } catch (error) {
      dispatch({ type: "RUN_ERROR", message: error instanceof Error ? error.message : "The draft could not be resolved." });
    } finally { busyRef.current = false; }
  }, [campaignId, pendingObject, reloadHistory, state.runStatus]);

  const selectTurn = useCallback((index: number) => dispatch({ type: "SELECT_TURN", index }), []);
  const selectPending = useCallback(() => dispatch({ type: "SELECT_PENDING" }), []);
  const setComposerDraft = useCallback((text: string) => dispatch({ type: "SET_COMPOSER", text }), []);
  const setReaderTab = useCallback((tab: "scene" | "timeline") => dispatch({ type: "SET_READER_TAB", tab }), []);
  const reconnectStream = useCallback(() => { void restorePending(); }, [restorePending]);
  const approve = useCallback(() => { void resolve(true); }, [resolve]);
  const reject = useCallback(() => { void resolve(false); }, [resolve]);

  const pending = state.runStatus === "running" || state.runStatus === "awaiting_approval" || state.runStatus === "rejecting";
  const activeSnapshot = !state.viewPending && history.length
    ? history[Math.min(Math.max(state.activeIndex, 0), history.length - 1)]
    : null;
  const value: ConsoleContextValue = {
    campaignId, campaignName, history, historyLoading, progress, summary,
    activeIndex: state.activeIndex, activeSnapshot, pending, viewPending: state.viewPending,
    runStatus: state.runStatus, events: state.events, pendingDraft: state.pendingDraft,
    composerDraft: state.composerDraft, error: state.error, streamDelaying: state.streamDelaying,
    submitTurn, approve, reject, reconnectStream, selectTurn, selectPending, setComposerDraft,
    readerTab: state.readerTab, setReaderTab,
  };
  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

export function useConsole(): ConsoleContextValue {
  const context = useContext(ConsoleContext);
  if (!context) throw new Error("useConsole must be used within a ConsoleProvider");
  return context;
}
