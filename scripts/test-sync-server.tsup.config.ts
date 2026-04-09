// Minimal tsup config for the e2e mock sync receiver.
// Kept separate from the main tsup.config.ts because the source lives
// outside src/ (so the main config's DTS pass can't include it) and
// because we don't want it included in the published npm package.
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "test-sync-server": "scripts/test-sync-server.ts" },
  format: ["esm"],
  target: "node24",
  platform: "node",
  outDir: "dist",
  clean: false,
  dts: false,
  sourcemap: true,
  shims: true,
});
