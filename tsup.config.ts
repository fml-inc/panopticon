import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    server: "src/server.ts",
    sdk: "src/sdk.ts",
    db: "src/db.ts",
    "hooks/handler": "src/hooks/handler.ts",
    "mcp/server": "src/mcp/server.ts",
    "otlp/server": "src/otlp/server.ts",
    "proxy/server": "src/proxy/server.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: true,
  clean: true,
  sourcemap: true,
  shims: true,
});
