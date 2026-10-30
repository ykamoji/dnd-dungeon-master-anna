/** Resolve only local app assets and the published adventure-art origin. */
export function resolveAssetUrl(value: string | undefined | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const candidate = value.trim();
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      if (
        url.protocol === "https:" &&
        url.origin === "https://raw.githubusercontent.com" &&
        url.pathname.startsWith("/5etools-mirror-3/5etools-img/main/adventure/ToA/") &&
        !url.username &&
        !url.password
      ) return candidate;
    } catch {
      return null;
    }
    return null;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(candidate) || candidate.includes("\\") || candidate.startsWith("//")) {
    return null;
  }
  const path = candidate.replace(/^\/+/, "");
  if (!path) return null;
  for (const segment of path.split(/[/?#]/, 1)[0].split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return null;
  }
  return path;
}
