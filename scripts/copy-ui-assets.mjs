// Copy the Mission Control web assets into dist/ so the static handler can serve
// them from a built install. tsup only bundles the TS entry points (and wipes
// dist with `clean: true`), so the html/js/css are copied here as a build step.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const src = path.join("src", "ui", "web");
const dest = path.join("dist", "ui", "web");

if (!existsSync(src)) {
  console.warn(`[copy-ui-assets] no web assets at ${src}, skipping`);
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-ui-assets] ${src} -> ${dest}`);
