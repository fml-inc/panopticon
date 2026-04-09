import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

function getPanopticonVersion(): string {
  const { version } = JSON.parse(readFileSync("package.json", "utf-8"));
  if (version?.includes("+")) return version;
  try {
    const sha = execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
    }).trim();
    return `${version}+${sha}`;
  } catch {
    return version ?? "unknown";
  }
}

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    server: "src/server.ts",
    sdk: "src/sdk.ts",
    db: "src/db.ts",
    types: "src/types.ts",
    query: "src/query.ts",
    setup: "src/setup.ts",
    doctor: "src/doctor.ts",
    repo: "src/repo.ts",
    prune: "src/db/prune.ts",
    pricing: "src/db/pricing.ts",
    permissions: "src/mcp/permissions.ts",
    scanner: "src/scanner.ts",
    index: "src/index.ts",
    "hooks/handler": "src/hooks/handler.ts",
    "mcp/server": "src/mcp/server.ts",
    "otlp/server": "src/otlp/server.ts",
    "proxy/server": "src/proxy/server.ts",
    "api/client": "src/api/client.ts",
    "sync/index": "src/sync/index.ts",
    targets: "src/targets/index.ts",
  },
  format: ["esm"],
  target: "node24",
  platform: "node",
  define: {
    __PANOPTICON_VERSION__: JSON.stringify(getPanopticonVersion()),
    __SENTRY_DSN__: JSON.stringify(
      "https://dcf9fb5ae8ac18803d98c3ee577faf39@o4510167429873664.ingest.us.sentry.io/4511107500343296",
    ),
  },
  noExternal: ["@sentry/core", "tslog", "smol-toml"],
  splitting: true,
  clean: true,
  sourcemap: true,
  shims: true,
  dts: true,
});
