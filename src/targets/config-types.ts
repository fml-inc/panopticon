export interface ConfigLayer {
  settings: Record<string, unknown> | null;
  hooks: Array<{ event: string; matcher: string | null; type: string }>;
  mcpServers: Array<{ name: string; command: string }>;
  commands: Array<{ name: string; content: string }>;
  agents: Array<{ name: string; content: string }>;
  rules: Array<{ name: string; content: string }>;
  skills: Array<{ name: string; content: string }>;
  permissions: { allow: string[]; ask: string[]; deny: string[] };
}

export interface PluginHooksSummary {
  pluginName: string;
  marketplace: string;
  hooks: ConfigLayer["hooks"];
}

export interface HarnessConfigSnapshot {
  managed: ConfigLayer | null;
  user: ConfigLayer;
  project: ConfigLayer | null;
  projectLocal: ConfigLayer | null;
  instructions: Array<{ path: string; content: string; lineCount: number }>;
  enabledPlugins: Array<{ pluginName: string; marketplace: string }>;
  pluginHooks: PluginHooksSummary[];
  /** Panopticon's own permission state (user-global). Null fields when files absent. */
  panopticonPermissions: {
    allowed: Record<string, unknown> | null;
    approvals: Record<string, unknown> | null;
  };
  /** Target-specific memory files keyed by project-dir name, then by relative path within memory/. */
  memoryFiles: Record<string, Record<string, string>>;
}

/** @deprecated Use HarnessConfigSnapshot for target-neutral config snapshots. */
export type ClaudeCodeConfig = HarnessConfigSnapshot;
