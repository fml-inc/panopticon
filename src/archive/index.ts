export type { ArchiveBackend } from "./backend.js";
export { LocalArchiveBackend } from "./local.js";

import path from "node:path";
import { config } from "../config.js";
import type { ArchiveBackend } from "./backend.js";
import { LocalArchiveBackend } from "./local.js";

let _backend: ArchiveBackend | null = null;

export function getArchiveBackend(): ArchiveBackend {
  if (!_backend) {
    _backend = new LocalArchiveBackend(path.join(config.dataDir, "archive"));
  }
  return _backend;
}
