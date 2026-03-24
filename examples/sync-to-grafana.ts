/**
 * Stream Panopticon telemetry to a local Grafana OTEL LGTM stack.
 *
 * Setup:
 *   ./examples/setup-grafana.sh
 *
 * Run:
 *   npx tsx examples/sync-to-grafana.ts
 *
 * Dashboard: http://localhost:3001/d/panopticon-main (admin/admin)
 */

import { createSyncLoop } from "../src/sync/index.js";

const sync = createSyncLoop({
  targets: [
    {
      name: "local-grafana",
      url: "http://localhost:14318",
    },
  ],
  keepAlive: true,
  log: (msg) => console.log(msg),
});

console.log("Syncing Panopticon → Grafana LGTM");
console.log("Dashboard: http://localhost:3001/d/panopticon-main");
console.log("Press Ctrl+C to stop\n");

sync.start();

process.on("SIGINT", () => {
  sync.stop();
  process.exit(0);
});
