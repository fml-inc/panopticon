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
  ReaderContext,
  SyncFilter,
  SyncHandle,
  SyncOptions,
  SyncTarget,
  TableSyncDescriptor,
} from "./types.js";
export {
  closeWatermarkDb,
  readWatermark,
  resetWatermarks,
  watermarkKey,
} from "./watermark.js";
