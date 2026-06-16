/**
 * Copy the Hermes observer plugin source into dist as a build asset.
 * Python needs no bundling — the file ships verbatim and is read from
 * <pluginRoot>/dist/targets/hermes/plugin.py at install time.
 * This script is run as part of the build process.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const srcFile = join(rootDir, "src", "targets", "hermes", "plugin.py");
const outDir = join(rootDir, "dist", "targets", "hermes");

mkdirSync(outDir, { recursive: true });
copyFileSync(srcFile, join(outDir, "plugin.py"));

console.log(`Copied Hermes plugin to ${join(outDir, "plugin.py")}`);
