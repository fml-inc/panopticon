export {
  allProviders,
  getProvider,
  getProviderOrThrow,
  providerIds,
  registerProvider,
} from "./registry.js";
export type { ProviderSpec } from "./types.js";

// Register built-in providers (side-effect import)
import "./builtin.js";
