#!/usr/bin/env node
// Assemble a SELF-CONTAINED Vercel app for the DB-backed snapshot in apps/site-db.
//
// Why self-contained: deploying the repo root makes Vercel compile src/index.ts
// into a crashing catch-all (no tsup defines → ReferenceError) that shadows
// /api/tool. Deploying a standalone dir with no src/ avoids that entirely — the
// dir is just static files + /api/tool.js + a copy of the tsup-built service
// (which uses node:sqlite, so no native modules to install).
//
// Prereqs: pnpm build (dist/) and a reachable Panopticon server (for the export).
// Usage: node scripts/build-vercel-db-app.mjs [--repo <repo>] [--since <ISO>]
// Then:  cd apps/site-db && vercel deploy --prod   (see README)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "apps", "static-site"); // export target
const OUT = path.join(ROOT, "apps", "site-db");
const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
);

// 1) Build the scoped DB + api-mode assets (into apps/static-site).
execFileSync(
  "node",
  [
    path.join(ROOT, "scripts", "export-scoped-db.mjs"),
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);

// 2) Fresh output dir.
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "api"), { recursive: true });

// 3) Static assets + DB.
for (const f of ["index.html", "app.js", "style.css"]) {
  fs.copyFileSync(path.join(SITE, f), path.join(OUT, f));
}
fs.cpSync(path.join(SITE, "db"), path.join(OUT, "db"), { recursive: true });

// 4) tsup-built service (has the build-time defines; uses node:sqlite). Skip
//    sourcemaps to keep the upload small.
fs.cpSync(path.join(ROOT, "dist"), path.join(OUT, "_dist"), {
  recursive: true,
  filter: (src) => !src.endsWith(".map"),
});

// 5) The serverless function.
fs.writeFileSync(
  path.join(OUT, "api", "tool.js"),
  `// Read-only /api/tool over the bundled scoped DB (node:sqlite, no native deps).
import path from "node:path";
process.env.PANOPTICON_DATA_DIR ||= path.join(process.cwd(), "db");
const { dispatchTool, directPanopticonService, isToolName } = await import(
  "../_dist/service/index.js"
);
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { name, params } = req.body ?? {};
  if (!isToolName(name)) return res.status(404).json({ error: \`unknown tool: \${name}\` });
  try {
    res.status(200).json(await dispatchTool(directPanopticonService, name, params ?? {}));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
`,
);

// 6) package.json (deps Vercel installs for the function; node:sqlite is builtin)
//    + engines, and NODE_OPTIONS so node:sqlite loads on flag-gated Node.
fs.writeFileSync(
  path.join(OUT, "package.json"),
  `${JSON.stringify(
    {
      name: "panopticon-mission-control-snapshot",
      private: true,
      type: "module",
      engines: { node: ">=22" },
      dependencies: pkg.dependencies ?? {},
    },
    null,
    2,
  )}\n`,
);

// 7) vercel.json — bundle the DB with the function; ensure node:sqlite is enabled.
fs.writeFileSync(
  path.join(OUT, "vercel.json"),
  `${JSON.stringify(
    {
      $schema: "https://openapi.vercel.sh/vercel.json",
      functions: { "api/tool.js": { includeFiles: "db/**" } },
      build: { env: { NODE_OPTIONS: "--experimental-sqlite" } },
    },
    null,
    2,
  )}\n`,
);

console.log(`\n✅ Self-contained DB app → ${path.relative(ROOT, OUT)}`);
console.log(
  "   Preview: node scripts/serve-snapshot.mjs   (uses apps/static-site/db)",
);
console.log("   Deploy:  (cd apps/site-db && vercel deploy --prod --yes)");
console.log(
  "   If /api 500s with node:sqlite missing: vercel env add NODE_OPTIONS  (value: --experimental-sqlite), then redeploy.",
);
