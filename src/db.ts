/**
 * Public DB API for external consumers (e.g. fml-plugin).
 *
 * Re-exports the database access layer so dependents can read
 * panopticon's SQLite tables without duplicating schema knowledge.
 */

export { config, ensureDataDir } from "./config.js";
export { closeDb, getDb } from "./db/schema.js";

export type {
  HookEventRow,
  OtelLogRow,
  OtelMetricRow,
} from "./db/store.js";
