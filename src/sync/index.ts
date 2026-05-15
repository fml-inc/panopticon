export {
  addTarget,
  listTargets,
  loadSyncConfig,
  removeTarget,
  saveSyncConfig,
} from "./config.js";
export { createSyncLoop } from "./loop.js";
export { TABLE_SYNC_REGISTRY } from "./registry.js";
export type {
  CodeProvenanceSyncRecord,
  IntentSessionSummarySyncRecord,
  RepoConfigSnapshotRecord,
  SessionDerivedStateSyncRecord,
  SessionSummaryEnrichmentSyncRecord,
  SessionSummarySyncRecord,
  SessionSyncRecord,
  SyncFilter,
  SyncHandle,
  SyncOptions,
  SyncTarget,
  TableSyncDescriptor,
  UserConfigSnapshotRecord,
} from "./types.js";
export {
  readWatermark,
  resetWatermarks,
  watermarkKey,
} from "./watermark.js";
