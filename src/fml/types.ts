// Backend response types for config snapshot endpoints

export interface UserConfigSnapshotSummary {
  githubUsername: string;
  deviceName: string;
  hookCount: number;
  enabledPluginCount: number;
  snapshotAt: string;
}

export interface UserConfigSnapshotDetail {
  githubUsername: string;
  deviceName: string;
  permissions: unknown;
  enabledPlugins: unknown;
  hooks: unknown;
  commands: unknown;
  rules: unknown;
  skills: unknown;
  snapshotAt: string;
}

export interface RepoConfigSnapshotSummary {
  githubUsername: string;
  repository: string;
  hookCount: number;
  mcpServerCount: number;
  instructionCount: number;
  snapshotAt: string;
}

export interface RepoConfigSnapshotDetail {
  githubUsername: string;
  repository: string;
  cwd: string;
  hooks: unknown;
  mcpServers: unknown;
  commands: unknown;
  agents: unknown;
  rules: unknown;
  localHooks: unknown;
  localMcpServers: unknown;
  localPermissions: unknown;
  localIsGitignored: boolean;
  instructions: unknown;
  snapshotAt: string;
}

export interface ResolvedRepo {
  repoId: string;
  fullName: string;
  orgSlug: string;
}
