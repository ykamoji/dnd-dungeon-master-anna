import { GameStage } from "@/components/game/GameStage";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { GameProvider } from "@/context/GameContext";

export default function AppRoot() {
  return (
    <main className="h-screen w-full overflow-hidden">
      <ErrorBoundary>
        <GameProvider>
          <GameStage />
        </GameProvider>
      </ErrorBoundary>
    </main>
  );
}
