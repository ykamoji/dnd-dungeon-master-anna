"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyError, getSpeechChunkLimit, speakText } from "@/lib/api";

// Chunks synthesized at once. Lines are short, so a small pool keeps latency low
// without flooding the user's quota with parallel calls.
const MAX_PARALLEL = 2;

export type TtsStatus = "idle" | "loading" | "playing";

/**
 * Decoded audio per line, keyed by caller-supplied key (session + turn + line).
 * Replaying a cached line never calls the API again. Lives for the page lifetime.
 */
const ttsCache = new Map<string, AudioBuffer[]>();

// One shared context for playback (browsers cap the number of contexts). It is
// suspended whenever nothing is scheduled so it does not burn CPU while idle.
let sharedCtx: AudioContext | null = null;
let activeSources = 0;

function getAudioContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === "closed") {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedCtx = new AC();
  }
  return sharedCtx;
}

function suspendContextIfIdle() {
  if (activeSources <= 0 && sharedCtx && sharedCtx.state === "running") {
    activeSources = 0;
    void sharedCtx.suspend();
  }
}

/**
 * Split text into speakable chunks (≤ maxLen), preferring sentence boundaries
 * and falling back to word boundaries for very long sentences.
 */
function chunkText(text: string, maxLen: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean ? [clean] : [];

  const sentences = clean.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) ?? [clean];
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };

  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length > maxLen) {
      flush();
      let piece = "";
      for (const word of s.split(" ")) {
        if (`${piece} ${word}`.trim().length > maxLen) {
          if (piece) chunks.push(piece.trim());
          piece = word.slice(0, maxLen);
        } else {
          piece = piece ? `${piece} ${word}` : word;
        }
      }
      if (piece.trim()) chunks.push(piece.trim());
    } else if (`${cur} ${s}`.trim().length > maxLen) {
      flush();
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  flush();
  return chunks;
}

async function mapPool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await work(items[index]);
    }
  }));
  return out;
}

interface UseTextToSpeech {
  /** The cache key currently loading/playing, or null when idle. */
  activeKey: string | null;
  status: TtsStatus;
  error: string | null;
  /** Play the line for `key`; clicking the same key again stops it. */
  toggle: (key: string, text: string, emotion?: string, voiceName?: string) => void;
  stop: () => void;
}

/**
 * Speaks a line through Anna's text-to-speech (`anna.audio.speak`). Long lines
 * are split at the model's `maxCharsPerCall`, synthesized a couple at a time,
 * decoded and played back to back. One line plays at a time; results are
 * cached per key so repeat plays are instant and free.
 */
export function useTextToSpeech(): UseTextToSpeech {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [status, setStatus] = useState<TtsStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const activeKeyRef = useRef<string | null>(null);
  // Bumped on every stop/new toggle; in-flight synthesis checks it to abort.
  const runIdRef = useRef(0);

  const stop = useCallback(() => {
    runIdRef.current++;
    for (const src of sourcesRef.current) {
      try {
        src.onended = null;
        src.stop();
        activeSources--;
      } catch {
        /* already stopped */
      }
    }
    sourcesRef.current = [];
    suspendContextIfIdle();
    activeKeyRef.current = null;
    setActiveKey(null);
    setStatus("idle");
  }, []);

  /** Schedule the buffers back to back; go idle when the last one ends. */
  const play = useCallback((key: string, buffers: AudioBuffer[]) => {
    if (!buffers.length) {
      stop();
      return;
    }
    const ctx = getAudioContext();
    void ctx.resume();
    let startAt = ctx.currentTime + 0.05;
    setStatus("playing");
    buffers.forEach((buffer, index) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(startAt);
      startAt += buffer.duration;
      sourcesRef.current.push(src);
      activeSources++;
      src.onended = () => {
        sourcesRef.current = sourcesRef.current.filter((s) => s !== src);
        activeSources--;
        suspendContextIfIdle();
        if (index === buffers.length - 1 && activeKeyRef.current === key) {
          activeKeyRef.current = null;
          setActiveKey(null);
          setStatus("idle");
        }
      };
    });
  }, [stop]);

  const synthesize = useCallback(async (key: string, text: string, voiceName: string | undefined, runId: number) => {
    try {
      const chunks = chunkText(text, await getSpeechChunkLimit());
      if (!chunks.length) {
        stop();
        return;
      }
      const ctx = getAudioContext();
      const buffers = await mapPool(chunks, MAX_PARALLEL, async (chunk) => {
        if (runIdRef.current !== runId) throw new Error("aborted");
        const bytes = await speakText(chunk, voiceName);
        return ctx.decodeAudioData(bytes);
      });
      if (runIdRef.current !== runId) return;
      ttsCache.set(key, buffers);
      play(key, buffers);
    } catch (err) {
      if ((err as Error).message === "aborted" || runIdRef.current !== runId) return;
      console.error(err);
      setError(friendlyError(err, "The voice line could not be played. Please try again."));
      stop();
    }
  }, [play, stop]);

  const toggle = useCallback(
    (key: string, text: string, _emotion?: string, voiceName?: string) => {
      if (activeKeyRef.current === key) {
        stop();
        return;
      }
      stop();
      setError(null);
      // Resume inside the click so the browser allows playback later.
      void getAudioContext().resume();
      activeKeyRef.current = key;
      setActiveKey(key);

      const cached = ttsCache.get(key);
      if (cached) {
        play(key, cached);
      } else {
        setStatus("loading");
        void synthesize(key, text, voiceName, runIdRef.current);
      }
    },
    [play, stop, synthesize],
  );

  useEffect(() => stop, [stop]);

  return { activeKey, status, error, toggle, stop };
}
