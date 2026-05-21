export type {
  ClaudeCodeConfig,
  ConfigLayer,
  PluginHooksSummary,
} from "./targets/claude/config.js";
export {
  isGitignored,
  readClaudeConfig as readConfig,
  resolveGitRoot,
  writeFile,
  writeSettings,
} from "./targets/claude/config.js";
