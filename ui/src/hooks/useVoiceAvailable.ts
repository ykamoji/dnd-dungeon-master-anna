"use client";

import { useEffect, useState } from "react";
import { getVoiceAvailable } from "@/lib/api";

/** True once the host's speech catalogue lists a text-to-speech model. */
export function useVoiceAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    void getVoiceAvailable().then((value) => { if (active) setAvailable(value); });
    return () => { active = false; };
  }, []);
  return available;
}
