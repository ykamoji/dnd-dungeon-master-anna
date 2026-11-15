"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useGame } from "@/context/GameContext";
import { useConsole, type DiceRolls } from "../ConsoleProvider";
import { DiceTray } from "../parts/DiceTray";
import { CommandComposer } from "../parts/CommandComposer";

const NO_ROLLS: DiceRolls = { d20: null, d100: null };

interface GameMasterPanelProps {
  /** "vertical" = serpentine rail; "hero" = a wider, board-like wrap. */
  orientation?: "vertical" | "hero";
}

/**
 * The Dungeon Master core (req 1.2): dice, command input, and the HITL approval
 * controls. The live trace is shown in the scene reader, not here.
 */
export function GameMasterPanel({ orientation = "hero" }: GameMasterPanelProps) {
  const {
    runStatus,
    composerDraft,
    error,
    submitTurn,
    setComposerDraft,
    dismissError,
    retrySetup,
  } = useConsole();

  const [rolls, setRolls] = useState<DiceRolls>(NO_ROLLS);
  const { currentStep } = useGame();

  const busy =
    runStatus === "running" ||
    runStatus === "awaiting_approval" ||
    runStatus === "rejecting";
  const awaiting = runStatus === "awaiting_approval";

  const handleSubmit = () => {
    submitTurn({ text: composerDraft, dice: rolls });
    setComposerDraft("");
    setRolls(NO_ROLLS);
  };

  return (
    <div>
      {/* Portal to <body>: the stage slides its views with a CSS transform, which would
          otherwise pin this "fixed" banner to the top of the stack (the first page). Only
          show it while the console is the current step. */}
      {error && currentStep === "console" && typeof document !== "undefined" && createPortal(
        <div
          role="alert"
          className="fixed left-1/2 top-16 z-50 flex max-w-[min(90vw,40rem)] -translate-x-1/2 items-center gap-3 rounded-card border border-blood-bright/50 bg-blood px-4 py-2 text-md text-gold shadow-lg"
        >
          <span>{error}</span>
          {retrySetup && (
            <button
              type="button"
              onClick={retrySetup}
              className="shrink-0 cursor-pointer rounded-md border border-gold/50 px-2 py-1 font-display text-xs uppercase tracking-wider hover:bg-gold/10"
            >
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={dismissError}
            aria-label="Dismiss message"
            className="shrink-0 cursor-pointer px-1 text-lg leading-none text-gold/80 hover:text-gold-bright"
          >
            ✕
          </button>
        </div>,
        document.body,
      )}

      <div className={`flex ${orientation === "vertical" ? "flex-col" : "flex-row"} items-center gap-3 space-y-3`}>
        <DiceTray rolls={rolls} onRoll={setRolls} disabled={busy} />
        <CommandComposer
          value={composerDraft}
          onChange={setComposerDraft}
          onSubmit={handleSubmit}
          disabled={busy}
          placeholder={
            awaiting
              ? "Approve or reject the draft above to continue…"
              : undefined
          }
        />
      </div>
    </div >
  );
}
