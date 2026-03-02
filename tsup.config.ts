import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    "hooks/handler": "src/hooks/handler.ts",
    "mcp/server": "src/mcp/server.ts",
    "otlp/server": "src/otlp/server.ts",
    "sync/daemon": "src/sync/daemon.ts",
    "web2/server": "src/web2/server.ts",
    "web2/widget-mcp": "src/web2/widget-mcp.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: true,
  clean: true,
  sourcemap: true,
  shims: true,
  external: ["express", "cors"],
});
