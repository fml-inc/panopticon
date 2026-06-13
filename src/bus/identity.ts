/**
 * Self-identification for CLI commands run from inside an agent's Bash tool.
 *
 * The MCP server learns its session by reading ~/.claude/sessions/<ppid>.json —
 * for a stdio MCP server the parent process IS the launching agent. But a CLI
 * invoked from an agent's Bash tool is a GRANDCHILD (agent → shell → cli), so
 * `process.ppid` is the shell, not the agent. We therefore walk up the process
 * ancestry until we find a pid that Claude Code registered a session file for.
 *
 * Best-effort and undocumented-file-coupled: any failure yields {} and the
 * caller falls back to explicit --room/--session flags.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SelfIdentity {
  sessionId?: string;
  cwd?: string;
  /** The session's friendly name from the registry, if any. */
  name?: string;
}

function defaultParentPid(pid: number): number | null {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf-8",
    }).trim();
    const n = Number(out);
    return Number.isFinite(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

function defaultReadSession(pid: number): SelfIdentity | null {
  try {
    const file = path.join(os.homedir(), ".claude", "sessions", `${pid}.json`);
    const d = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
      string,
      unknown
    >;
    return {
      sessionId: typeof d.sessionId === "string" ? d.sessionId : undefined,
      cwd: typeof d.cwd === "string" ? d.cwd : undefined,
      name: typeof d.name === "string" ? d.name : undefined,
    };
  } catch {
    return null;
  }
}

export interface ResolveSelfDeps {
  /** Where to begin the walk (defaults to this process's parent). */
  startPid?: number;
  /** Read a pid's session registry file (injectable for tests). */
  readSession?: (pid: number) => SelfIdentity | null;
  /** Resolve a pid's parent (injectable for tests). */
  parent?: (pid: number) => number | null;
  /** Safety bound on how far up the tree to walk. */
  maxLevels?: number;
}

/**
 * Walk the process ancestry from `startPid` upward, returning the first
 * registered session identity found (the launching agent). Returns {} if none
 * is found within `maxLevels`.
 */
export function resolveSelfIdentity(deps: ResolveSelfDeps = {}): SelfIdentity {
  const readSession = deps.readSession ?? defaultReadSession;
  const parent = deps.parent ?? defaultParentPid;
  const maxLevels = deps.maxLevels ?? 8;
  let pid: number | null = deps.startPid ?? process.ppid ?? null;
  for (let i = 0; i < maxLevels && pid && pid > 1; i++) {
    const id = readSession(pid);
    if (id?.sessionId) return id;
    pid = parent(pid);
  }
  return {};
}
