import fs from "node:fs";
import path from "node:path";
import { getTarget } from "../../targets/index.js";
import type { TargetAdapter } from "../../targets/types.js";
import { readTomlFile, writeTomlFile } from "../../toml.js";

type DirectMcpTargetId = "codex" | "gemini" | "claude-desktop";

export interface FmlDirectMcpChange {
  targetId: DirectMcpTargetId;
  displayName: string;
  configPath: string;
}

const DIRECT_MCP_TARGETS: DirectMcpTargetId[] = [
  "codex",
  "gemini",
  "claude-desktop",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function readTargetConfig(target: TargetAdapter): Record<string, unknown> {
  if (target.config.configFormat === "toml") {
    return readTomlFile(target.config.configPath);
  }
  return readJsonFile(target.config.configPath);
}

function writeTargetConfig(
  target: TargetAdapter,
  data: Record<string, unknown>,
): void {
  if (target.config.configFormat === "toml") {
    writeTomlFile(target.config.configPath, data);
    return;
  }
  writeJsonFile(target.config.configPath, data);
}

function mcpConfigKey(
  targetId: DirectMcpTargetId,
): "mcp_servers" | "mcpServers" {
  return targetId === "codex" ? "mcp_servers" : "mcpServers";
}

function fmlServerConfig(
  targetId: DirectMcpTargetId,
  pluginRoot: string,
): Record<string, unknown> {
  const serverBin = path.join(pluginRoot, "bin", "fml-mcp-server");
  return {
    command: targetId === "claude-desktop" ? process.execPath : "node",
    args: [serverBin],
  };
}

function selectedDirectTargets(target = "all"): DirectMcpTargetId[] {
  if (target === "all") return DIRECT_MCP_TARGETS;
  return DIRECT_MCP_TARGETS.includes(target as DirectMcpTargetId)
    ? [target as DirectMcpTargetId]
    : [];
}

export function upsertFmlMcpServerConfig(
  existing: Record<string, unknown>,
  key: "mcp_servers" | "mcpServers",
  serverConfig: Record<string, unknown>,
): Record<string, unknown> {
  const updated = { ...existing };
  const servers = { ...(asRecord(updated[key]) ?? {}) };
  const existingFml = asRecord(servers.fml) ?? {};

  delete servers.panopticon;
  servers.fml = {
    ...existingFml,
    ...serverConfig,
  };
  updated[key] = servers;

  return updated;
}

export function removeFmlMcpServerConfig(
  existing: Record<string, unknown>,
  key: "mcp_servers" | "mcpServers",
): Record<string, unknown> {
  const currentServers = asRecord(existing[key]);
  if (!currentServers) return { ...existing };

  const updated = { ...existing };
  const servers = { ...currentServers };
  delete servers.fml;

  if (Object.keys(servers).length === 0) {
    delete updated[key];
  } else {
    updated[key] = servers;
  }

  return updated;
}

export function configureFmlDirectMcp(
  pluginRoot: string,
  target = "all",
): FmlDirectMcpChange[] {
  const changes: FmlDirectMcpChange[] = [];
  for (const targetId of selectedDirectTargets(target)) {
    const adapter = getTarget(targetId);
    if (!adapter) continue;

    const updated = upsertFmlMcpServerConfig(
      readTargetConfig(adapter),
      mcpConfigKey(targetId),
      fmlServerConfig(targetId, pluginRoot),
    );
    writeTargetConfig(adapter, updated);
    changes.push({
      targetId,
      displayName: adapter.detect.displayName,
      configPath: adapter.config.configPath,
    });
  }
  return changes;
}

export function removeFmlDirectMcp(target = "all"): FmlDirectMcpChange[] {
  const changes: FmlDirectMcpChange[] = [];
  for (const targetId of selectedDirectTargets(target)) {
    const adapter = getTarget(targetId);
    if (!adapter) continue;

    const updated = removeFmlMcpServerConfig(
      readTargetConfig(adapter),
      mcpConfigKey(targetId),
    );
    writeTargetConfig(adapter, updated);
    changes.push({
      targetId,
      displayName: adapter.detect.displayName,
      configPath: adapter.config.configPath,
    });
  }
  return changes;
}
