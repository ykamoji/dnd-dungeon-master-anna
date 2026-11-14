"use client";

import { useEffect, useState } from "react";
import { getVoiceAvailable } from "@/lib/api";

/** True only once the Executa confirms a voice credential is configured. */
export function useVoiceAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    void getVoiceAvailable().then((value) => { if (active) setAvailable(value); });
    return () => { active = false; };
  }, []);
  return available;
}
