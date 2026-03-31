export {
  allTargets,
  getTarget,
  getTargetOrThrow,
  registerTarget,
  targetIds,
} from "./registry.js";
export type {
  CanonicalEvent,
  TargetAdapter,
  TargetConfigSpec,
  TargetDetectSpec,
  TargetEventSpec,
  TargetHookSpec,
  TargetInstallOpts,
  TargetProxySpec,
  TargetShellEnvSpec,
} from "./types.js";
export { ALL_EVENTS } from "./types.js";

// Register built-in targets (side-effect imports)
import "./claude.js";
import "./claude-desktop.js";
import "./gemini.js";
import "./codex.js";
