"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyError, transcribeAudio } from "@/lib/api";

// Anna accepts recordings up to 10 minutes; a spoken action never needs more than two.
const MAX_RECORDING_MS = 120_000;

interface UseVoiceTranscriptionOptions {
  /** Called with the transcribed text once a recording is processed. */
  onTranscript: (text: string) => void;
}

interface UseVoiceTranscription {
  listening: boolean;
  /** True while the microphone opens or the recording is being transcribed. */
  connecting: boolean;
  error: string | null;
  start: () => Promise<void>;
  /** Stop recording and transcribe what was said. */
  stop: () => void;
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
    .find((type) => MediaRecorder.isTypeSupported(type));
}

/**
 * Push-to-talk: records the microphone with MediaRecorder, then sends the clip
 * to Anna's speech-to-text (`anna.audio.transcribe`). No API key and no
 * third-party connection; the clip goes only to the Anna host.
 */
export function useVoiceTranscription({ onTranscript }: UseVoiceTranscriptionOptions): UseVoiceTranscription {
  const [listening, setListening] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  const releaseMic = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();  // onstop transcribes
  }, []);

  const start = useCallback(async () => {
    if (busyRef.current || recorderRef.current) return;
    busyRef.current = true;
    setError(null);
    setConnecting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        releaseMic();
        recorderRef.current = null;
        const clip = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
        chunksRef.current = [];
        if (!mountedRef.current) return;
        setListening(false);
        if (!clip.size) {
          busyRef.current = false;
          setConnecting(false);
          return;
        }
        setConnecting(true);
        try {
          const text = await transcribeAudio(clip);
          if (mountedRef.current && text) onTranscriptRef.current(text);
          else if (mountedRef.current) setError("No speech was recognised. Please try again.");
        } catch (err) {
          if (mountedRef.current) setError(friendlyError(err, "Your voice could not be transcribed. Please try again."));
        } finally {
          busyRef.current = false;
          if (mountedRef.current) setConnecting(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      timerRef.current = setTimeout(stop, MAX_RECORDING_MS);
      setConnecting(false);
      setListening(true);
    } catch (err) {
      releaseMic();
      recorderRef.current = null;
      busyRef.current = false;
      setConnecting(false);
      setListening(false);
      setError(friendlyError(err, "Voice input could not be started. Please try again."));
    }
  }, [releaseMic, stop]);

  // Release the microphone without transcribing if the component unmounts.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      releaseMic();
    };
  }, [releaseMic]);

  return { listening, connecting, error, start, stop };
}
