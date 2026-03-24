/**
 * Example: stream Panopticon telemetry to a local Grafana OTEL LGTM stack.
 *
 * Prerequisites:
 *   docker run -d --name panopticon-otel -p 3001:3000 -p 14318:4318 grafana/otel-lgtm
 *
 * Run:
 *   npx tsx examples/sync-to-grafana.ts
 *
 * Then open http://localhost:3001 (admin/admin) → Explore → Loki to see logs.
 */

import { createSyncLoop } from "../src/sync/index.js";

const sync = createSyncLoop({
  targets: [
    {
      name: "local-grafana",
      url: "http://localhost:14318",
    },
  ],
  // Sync everything, no filtering
  batchSize: 500, // Larger batches to catch up faster
  postBatchSize: 100, // Bigger POST batches too
  idleIntervalMs: 10_000, // Check every 10s for demo
  keepAlive: true,
  log: (msg) => console.log(msg),
});

console.log("Syncing Panopticon → Grafana LGTM (http://localhost:3001)");
console.log("Press Ctrl+C to stop\n");

sync.start();

process.on("SIGINT", () => {
  sync.stop();
  process.exit(0);
});
