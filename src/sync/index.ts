export {
  addTarget,
  listTargets,
  loadSyncConfig,
  removeTarget,
  saveSyncConfig,
} from "./config.js";
export { createSyncLoop } from "./loop.js";
export type {
  SyncFilter,
  SyncHandle,
  SyncOptions,
  SyncTarget,
} from "./types.js";
export {
  closeWatermarkDb,
  readWatermark,
  resetWatermarks,
  watermarkKey,
} from "./watermark.js";
