"use client";

import { JourneyMapPanel } from "../panels/JourneyMapPanel";
import { SceneReaderPanel } from "../panels/SceneReaderPanel";
import { GameMasterPanel } from "../panels/GameMasterPanel";

/** Map as the board (hero) · scene reader as a side drawer · GM bottom bar. */
export function MapHeroLayout() {
  return (
    // Sized for Anna windows down to the 960×600 minimum: the map hides below 1024 px
    // and the GM bar shrinks with the window height.
    <div className="grid h-full grid-rows-[minmax(0,1fr)_minmax(9rem,30vh)] gap-4">
      <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] 2xl:grid-cols-[minmax(0,1fr)_50rem]">
        <div className="parchment hidden min-h-0 rounded-card border border-stone-2 p-4 lg:block">
          <JourneyMapPanel orientation="hero" />
        </div>
        <div className="parchment min-h-0 rounded-card border border-stone-2 p-5">
          <SceneReaderPanel />
        </div>
      </div>
      <div className="parchment min-h-0 rounded-card border border-stone-2 p-4">
        <GameMasterPanel />
      </div>
    </div>
  );
}
