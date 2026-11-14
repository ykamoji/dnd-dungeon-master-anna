"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { children: ReactNode }
interface State { failed: boolean }

/** Last line of defence: a render crash shows a recovery screen, not a blank page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("The app hit an unexpected error.", error, info.componentStack);
  }

  private restart = () => {
    // Drop the in-progress step so a bad state cannot crash the app again; saved campaigns are kept.
    try { sessionStorage.removeItem("dnd-game-state"); } catch { /* storage unavailable */ }
    window.location.reload();
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
        <h2 className="text-gilded font-display text-3xl font-bold tracking-wide">The tale hit a snag</h2>
        <p className="max-w-md text-parchment-dim">
          Something went wrong on this screen. Your saved campaigns are safe — restart to pick up where you left off.
        </p>
        <button
          type="button"
          onClick={this.restart}
          className="cursor-pointer rounded-md border border-gold/40 bg-blood px-5 py-2.5 font-display text-sm uppercase tracking-wide text-parchment hover:bg-blood-bright"
        >
          Restart
        </button>
      </div>
    );
  }
}
