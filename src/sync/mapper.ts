/**
 * Maps SQLite rows to the shapes expected by FML ingestion endpoints.
 */

import { execFileSync } from "node:child_process";

// Cache: cwd → "org/repo" | null
const repoCache = new Map<string, string | null>();

/**
 * Resolve the GitHub "org/repo" for a working directory by inspecting the
 * git remote origin URL.  Results are cached for the lifetime of the process.
 */
export function resolveRepoFromCwd(cwd: string): string | null {
  if (repoCache.has(cwd)) return repoCache.get(cwd)!;

  let repo: string | null = null;
  try {
    const url = execFileSync(
      "git",
      ["-C", cwd, "remote", "get-url", "origin"],
      {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();

    // SSH: git@github.com:org/repo.git
    const sshMatch = url.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) {
      repo = sshMatch[1];
    } else {
      // HTTPS: https://github.com/org/repo.git
      const httpsMatch = url.match(/\/([^/]+\/[^/]+?)(?:\.git)?$/);
      if (httpsMatch) {
        repo = httpsMatch[1];
      }
    }
  } catch {
    // Not a git repo, no remote, etc.
  }

  repoCache.set(cwd, repo);
  return repo;
}

export interface FmlBatchEvent {
  sessionId: string;
  eventType: string;
  timestamp: number;
  cwd: string;
  repositoryFullName?: string;
  permissionMode?: string;
  payload?: unknown;
}

export interface FmlLogEntry {
  sessionId: string;
  timestampMs: number;
  body?: string;
  severityText?: string;
  attributes?: unknown;
  promptId?: string;
  traceId?: string;
  spanId?: string;
  repositoryFullName?: string;
}

export interface FmlMetricEntry {
  sessionId: string;
  timestampMs: number;
  name: string;
  value: number;
  unit?: string;
  attributes?: unknown;
  repositoryFullName?: string;
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function extractRepoFromResourceAttrs(
  raw: string | null | undefined,
): string | undefined {
  const attrs = parseJson(raw);
  if (!attrs || typeof attrs !== "object") return undefined;
  const repo = (attrs as Record<string, unknown>)["repository.full_name"];
  return typeof repo === "string" ? repo : undefined;
}

export interface HookEventDbRow {
  id: number;
  session_id: string;
  event_type: string;
  timestamp_ms: number;
  cwd: string | null;
  repository: string | null;
  tool_name: string | null;
  payload: string | null;
}

export function mapHookEvent(row: HookEventDbRow): FmlBatchEvent {
  const payload = parseJson(row.payload);
  const permissionMode =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).permission_mode
      : undefined;

  const cwd = row.cwd ?? "";
  let repo = row.repository ?? undefined;
  if (!repo && cwd) {
    repo = resolveRepoFromCwd(cwd) ?? undefined;
  }

  return {
    sessionId: row.session_id,
    eventType: row.event_type,
    timestamp: row.timestamp_ms,
    cwd,
    repositoryFullName: repo,
    permissionMode:
      typeof permissionMode === "string" ? permissionMode : undefined,
    payload,
  };
}

export interface OtelLogDbRow {
  id: number;
  timestamp_ns: number;
  severity_text: string | null;
  body: string | null;
  attributes: string | null;
  resource_attributes: string | null;
  session_id: string | null;
  prompt_id: string | null;
  trace_id: string | null;
  span_id: string | null;
}

export function mapOtelLog(row: OtelLogDbRow): FmlLogEntry {
  return {
    sessionId: row.session_id ?? "unknown",
    timestampMs: Math.floor(row.timestamp_ns / 1e6),
    body: row.body ?? undefined,
    severityText: row.severity_text ?? undefined,
    attributes: parseJson(row.attributes),
    promptId: row.prompt_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    spanId: row.span_id ?? undefined,
    repositoryFullName: extractRepoFromResourceAttrs(row.resource_attributes),
  };
}

export interface OtelMetricDbRow {
  id: number;
  timestamp_ns: number;
  name: string;
  value: number;
  unit: string | null;
  attributes: string | null;
  resource_attributes: string | null;
  session_id: string | null;
}

export function mapOtelMetric(row: OtelMetricDbRow): FmlMetricEntry {
  return {
    sessionId: row.session_id ?? "unknown",
    timestampMs: Math.floor(row.timestamp_ns / 1e6),
    name: row.name,
    value: row.value,
    unit: row.unit ?? undefined,
    attributes: parseJson(row.attributes),
    repositoryFullName: extractRepoFromResourceAttrs(row.resource_attributes),
  };
}
