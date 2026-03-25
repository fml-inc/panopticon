export {
  allVendors,
  getVendor,
  getVendorOrThrow,
  registerVendor,
  vendorIds,
} from "./registry.js";
export type {
  CanonicalEvent,
  VendorAdapter,
  VendorConfigSpec,
  VendorDetectSpec,
  VendorEventSpec,
  VendorHookSpec,
  VendorInstallOpts,
  VendorProxySpec,
  VendorShellEnvSpec,
} from "./types.js";

// Register built-in vendors (side-effect imports)
import "./claude.js";
import "./gemini.js";
import "./codex.js";
import "./openclaw.js";
