export {
  isGitignored,
  readClaudeConfig as readConfig,
  resolveGitRoot,
  writeFile,
  writeSettings,
} from "./targets/claude/config.js";
export type {
  ClaudeCodeConfig,
  ConfigLayer,
  HarnessConfigSnapshot,
  PluginHooksSummary,
} from "./targets/config-types.js";
