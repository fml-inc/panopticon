/**
 * Debug version — runs one sync cycle and reports results.
 */

import { getDb } from "../src/db/schema.js";
import {
  readMergedEvents,
  readMetrics,
  readUnmatchedOtelLogs,
} from "../src/sync/reader.js";
import { serializeMergedEvents } from "../src/sync/serialize.js";

try {
  const db = getDb();
  console.log("DB opened:", !!db);

  console.log("\n--- Reading merged events ---");
  const merged = readMergedEvents(0, 5);
  console.log(`Got ${merged.rows.length} merged events, maxId=${merged.maxId}`);
  if (merged.rows.length > 0) {
    const first = merged.rows[0];
    console.log("First:", {
      hookId: first.hookId,
      eventType: first.eventType,
      sessionId: first.sessionId.slice(0, 8),
      toolName: first.toolName,
      hasOtelAttrs: !!first.otelAttributes,
      hasPayload: !!first.payload,
    });

    // Try serializing
    const otlp = serializeMergedEvents(merged.rows);
    console.log("\nSerialized OTLP logs:", JSON.stringify(otlp).slice(0, 500));

    // Try posting
    const resp = await fetch("http://localhost:14318/v1/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(otlp),
    });
    console.log("\nPOST /v1/logs:", resp.status, resp.statusText);
    if (!resp.ok) {
      console.log("Body:", await resp.text());
    }
  }

  console.log("\n--- Reading unmatched OTLP logs ---");
  const unmatched = readUnmatchedOtelLogs(0, 5);
  console.log(
    `Got ${unmatched.rows.length} unmatched logs, maxId=${unmatched.maxId}`,
  );
  if (unmatched.rows.length > 0) {
    console.log("First body:", unmatched.rows[0].body);
  }

  console.log("\n--- Reading metrics ---");
  const metrics = readMetrics(0, 5);
  console.log(`Got ${metrics.rows.length} metrics, maxId=${metrics.maxId}`);
  if (metrics.rows.length > 0) {
    console.log("First:", metrics.rows[0].name, metrics.rows[0].value);
  }
} catch (err) {
  console.error("ERROR:", err);
}
