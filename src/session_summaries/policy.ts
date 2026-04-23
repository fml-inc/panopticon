import { createHash } from "node:crypto";
import type {
  SessionSummaryRunnerName,
  SessionSummaryRunnerStrategy,
} from "../config.js";
import { config } from "../config.js";

export interface SessionSummaryRunnerPolicy {
  allowedRunners: SessionSummaryRunnerName[];
  strategy: SessionSummaryRunnerStrategy;
  fixedRunner: SessionSummaryRunnerName;
  fallbackRunners: SessionSummaryRunnerName[];
  models: Record<SessionSummaryRunnerName, string | null>;
  policyHash: string;
}

export function isSummaryRunnerName(
  value: unknown,
): value is SessionSummaryRunnerName {
  return value === "claude" || value === "codex";
}

export function inferRunnerFromSessionTarget(
  target: string | null,
): SessionSummaryRunnerName | null {
  const normalized = target?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("claude")) return "claude";
  return null;
}

export function getSessionSummaryRunnerPolicy(): SessionSummaryRunnerPolicy {
  const allowedRunners = normalizeRunners(
    config.sessionSummaryAllowedRunners ?? ["claude", "codex"],
    ["claude", "codex"],
  );
  const fallbackRunners = normalizeRunners(
    config.sessionSummaryFallbackRunners ?? allowedRunners,
    allowedRunners,
  ).filter((runner) => allowedRunners.includes(runner));
  const fixedRunner = isSummaryRunnerName(config.sessionSummaryFixedRunner)
    ? config.sessionSummaryFixedRunner
    : "claude";
  const strategy =
    config.sessionSummaryRunnerStrategy === "fixed"
      ? "fixed"
      : "same_as_session";
  const models: Record<SessionSummaryRunnerName, string | null> = {
    claude: config.sessionSummaryRunnerModels?.claude ?? "sonnet",
    codex: config.sessionSummaryRunnerModels?.codex ?? null,
  };
  const policyHash = hashStable({
    allowedRunners,
    strategy,
    fixedRunner,
    fallbackRunners,
    models,
  });
  return {
    allowedRunners,
    strategy,
    fixedRunner,
    fallbackRunners,
    models,
    policyHash,
  };
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeRunners(
  values: readonly unknown[] | undefined,
  fallback: SessionSummaryRunnerName[],
): SessionSummaryRunnerName[] {
  const normalized = values?.filter(isSummaryRunnerName) ?? [];
  return normalized.length > 0 ? [...new Set(normalized)] : fallback;
}
