import { createHash } from "node:crypto";
import { cp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(repo, "ui", "out");
const destination = join(repo, "bundle");

let toolIdMap = null;
try { toolIdMap = await readFile(join(destination, "anna-tool-ids.js"), "utf8"); } catch { /* first build */ }

const entries = await readdir(source);
if (!entries.includes("index.html")) {
  throw new Error("Next.js static export did not produce ui/out/index.html");
}
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
await writeFile(
  join(destination, "anna-tool-ids.js"),
  toolIdMap ?? "window.__ANNA_TOOL_IDS__ = window.__ANNA_TOOL_IDS__ || {};\n",
);

// Anna's default script-src only permits same-origin files. Next's App Router
// export bootstraps React with inline Flight scripts, so allow exactly those
// immutable generated scripts by CSP hash instead of enabling unsafe-inline.
let html = await readFile(join(destination, "index.html"), "utf8");
const toolIdScript = '<script src="./anna-tool-ids.js"></script>';
if (!html.includes(toolIdScript)) {
  if (!/<head\b[^>]*>/i.test(html)) {
    throw new Error("Static export index.html has no <head> for the Anna tool ID mapping.");
  }
  html = html.replace(/<head\b[^>]*>/i, (head) => head + "\n    " + toolIdScript);
  await writeFile(join(destination, "index.html"), html);
}
const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  .filter(([, attrs, body]) =>
    !/\bsrc\s*=/.test(attrs) &&
    !/\btype\s*=\s*["'](?:application\/json|application\/ld\+json)["']/i.test(attrs) &&
    body.trim().length > 0,
  )
  .map(([, , body]) => `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);

const manifestPath = join(repo, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.ui ??= {};
manifest.ui.csp_overrides ??= {};
manifest.ui.csp_overrides["script-src"] = [...new Set(["'self'", ...inlineScripts])];
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `Copied ${entries.length} static export entries into bundle/ and added ${inlineScripts.length} exact inline-script CSP hashes.`,
);
