"use client";

import { useCallback, useEffect, useState } from "react";
import { friendlyError, getClasses } from "@/lib/api";
import type { ClassProfile } from "@/lib/types";

interface UseClassesResult {
  classes: ClassProfile[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Fetches class DNA profiles from GET /tools/classes. */
export function useClasses(): UseClassesResult {
  const [classes, setClasses] = useState<ClassProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getClasses()
      .then((data) => {
        if (active) {
          setClasses(data);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (active) setError(friendlyError(e, "Please try again."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  return { classes, loading, error, reload: load };
}
