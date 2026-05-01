/**
 * Bundle the Pi extension into a standalone JS file.
 * This script is run as part of the build process.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const outDir = join(rootDir, "dist", "targets", "pi");
const outFile = join(outDir, "extension.js");

// Clean output directory
if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true });
}
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(rootDir, "src", "targets", "pi", "extension.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: outFile,
  external: ["@mariozechner/pi-coding-agent"],
  logLevel: "warning",
});

console.log(`Bundled Pi extension to ${outFile}`);
