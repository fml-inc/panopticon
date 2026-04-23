import { createHash } from "node:crypto";
import {
  clearAttemptBackoff,
  isAttemptBackoffActive,
  recordAttemptBackoffFailure,
} from "../attempt-backoff.js";
import type {
  SessionSummaryRunnerName,
  SessionSummaryRunnerStrategy,
} from "../config.js";
import { config } from "../config.js";
import { getDb } from "../db/schema.js";
import { detectAgent, invokeLlm } from "../summary/llm.js";

export const SESSION_SUMMARY_ENRICHMENT_VERSION = 1;

const ENRICH_LIMIT = 5;
const ENRICH_TIMEOUT_MS = 90_000;
const HOT_WINDOW_MS = 30 * 60 * 1000;
const COLD_WINDOW_MS = 6 * 60 * 60 * 1000;
const MESSAGE_THRESHOLD = 20;
const PENDING_AGE_THRESHOLD_MS = 30 * 60 * 1000;
const SUMMARY_GLOBAL_BACKOFF_SCOPE = "session-summary-global";
const SUMMARY_GLOBAL_RUNNER_AVAILABILITY_KEY = "runner-availability";
const SUMMARY_ROW_BACKOFF_SCOPE = "session-summary-row";
const SUMMARY_RUNNER_BACKOFF_SCOPE = "session-summary-runner";

const SYSTEM_PROMPT = `You are enriching a per-session coding summary for retrieval.

Rules:
1. Use only the structured session data provided in the prompt
2. Write exactly one paragraph of 2-3 short sentences, max 140 words total
3. Lead with the main outcome or highest-value finding
4. For review sessions, emphasize findings, severity, and whether fixes landed
5. For implementation or debugging sessions, emphasize what changed and how it was verified
6. Do not mention the model, agent, message count, timestamps, absolute local paths, database paths, prompt engineering, validation batches, or investigation mechanics
7. Do not mention any work that happened after the target session ended
8. If no code changed, say that explicitly
9. Output ONLY the summary text`;

export interface SessionSummaryDeterministicInput {
  sessionSummaryKey: string;
  sessionId: string;
  title: string;
  status: "active" | "landed" | "mixed" | "abandoned";
  repository: string | null;
  cwd: string | null;
  branch: string | null;
  intentCount: number;
  editCount: number;
  landedEditCount: number;
  openEditCount: number;
  messageCount: number;
  lastActivityMs: number | null;
  intents: string[];
  files: Array<{
    filePath: string;
    editCount: number;
    landedCount: number;
  }>;
  tools: string[];
}

export interface SessionSummaryDeterministicDocs {
  summaryText: string;
  summarySearchText: string;
  projectionHash: string;
  summaryInputHash: string;
}

export interface SessionSummaryEnrichmentRow {
  session_summary_key: string;
  session_id: string;
  summary_text: string | null;
  summary_search_text: string | null;
  summary_source: string | null;
  summary_runner: string | null;
  summary_model: string | null;
  summary_version: number;
  summary_generated_at_ms: number | null;
  projection_hash: string | null;
  summary_input_hash: string | null;
  summary_policy_hash: string | null;
  enriched_input_hash: string | null;
  enriched_message_count: number | null;
  dirty: number;
  dirty_reason_json: string | null;
  last_material_change_at_ms: number | null;
  last_attempted_at_ms: number | null;
  failure_count: number;
  last_error: string | null;
}

export interface SessionSummaryEnrichmentRefreshResult {
  attempted: number;
  updated: number;
}

interface SessionSummaryRefreshCandidate {
  session_summary_key: string;
  session_id: string;
  summary_runner: string | null;
  summary_input_hash: string | null;
  message_count: number;
  last_attempted_at_ms: number | null;
}

export interface SessionSummaryRunnerPolicy {
  allowedRunners: SessionSummaryRunnerName[];
  strategy: SessionSummaryRunnerStrategy;
  fixedRunner: SessionSummaryRunnerName;
  fallbackRunners: SessionSummaryRunnerName[];
  models: Record<SessionSummaryRunnerName, string | null>;
  policyHash: string;
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

export function selectSessionSummaryRunner(opts: {
  sessionTarget: string | null;
  stickyRunner: string | null;
  policy?: SessionSummaryRunnerPolicy;
  detector?: (runner: SessionSummaryRunnerName) => string | null;
}): {
  runner: SessionSummaryRunnerName | null;
  model: string | null;
  policyHash: string;
  attemptedRunners: SessionSummaryRunnerName[];
} {
  const policy = opts.policy ?? getSessionSummaryRunnerPolicy();
  const detect = opts.detector ?? detectAgent;
  const attempted: SessionSummaryRunnerName[] = [];
  const add = (runner: SessionSummaryRunnerName | null) => {
    if (!runner) return;
    if (!policy.allowedRunners.includes(runner)) return;
    if (attempted.includes(runner)) return;
    attempted.push(runner);
  };

  add(isSummaryRunnerName(opts.stickyRunner) ? opts.stickyRunner : null);
  if (policy.strategy === "fixed") {
    add(policy.fixedRunner);
  } else {
    add(inferRunnerFromSessionTarget(opts.sessionTarget));
  }
  for (const runner of policy.fallbackRunners) add(runner);
  for (const runner of policy.allowedRunners) add(runner);

  const selected = attempted.find((runner) => detect(runner) !== null) ?? null;
  return {
    runner: selected,
    model: selected ? (policy.models[selected] ?? null) : null,
    policyHash: policy.policyHash,
    attemptedRunners: attempted,
  };
}

export function buildDeterministicSessionSummaryDocs(
  input: SessionSummaryDeterministicInput,
): SessionSummaryDeterministicDocs {
  const topFiles = input.files
    .slice()
    .sort(
      (a, b) =>
        b.editCount - a.editCount || a.filePath.localeCompare(b.filePath),
    )
    .slice(0, 5);
  const prompts = normalizeItems(input.intents, 4);
  const tools = normalizeItems(input.tools, 6);

  const summaryTextParts = [
    input.title,
    `Status: ${input.status}`,
    `${input.intentCount} intents, ${input.editCount} edits, ${input.landedEditCount} landed, ${input.openEditCount} open`,
  ];
  if (topFiles.length > 0) {
    summaryTextParts.push(
      `Top files: ${topFiles.map((file) => file.filePath).join(", ")}`,
    );
  }
  const summaryText = `${summaryTextParts.join(". ")}.`;

  const searchFields = [
    `Title: ${input.title}`,
    `Status: ${input.status}`,
    input.repository ? `Repository: ${input.repository}` : null,
    input.branch ? `Branch: ${input.branch}` : null,
    input.cwd ? `Cwd: ${input.cwd}` : null,
    `Counts: intents ${input.intentCount}; edits ${input.editCount}; landed ${input.landedEditCount}; open ${input.openEditCount}`,
    topFiles.length > 0
      ? `Files: ${topFiles
          .map(
            (file) =>
              `${file.filePath} (${file.editCount} edits, ${file.landedCount} landed)`,
          )
          .join("; ")}`
      : null,
    tools.length > 0 ? `Tools: ${tools.join("; ")}` : null,
    prompts.length > 0 ? `Prompts: ${prompts.join(" | ")}` : null,
  ].filter((value): value is string => Boolean(value));

  const projectionEnvelope = {
    sessionSummaryKey: input.sessionSummaryKey,
    sessionId: input.sessionId,
    title: input.title,
    status: input.status,
    repository: input.repository,
    cwd: input.cwd,
    branch: input.branch,
    intentCount: input.intentCount,
    editCount: input.editCount,
    landedEditCount: input.landedEditCount,
    openEditCount: input.openEditCount,
    topFiles,
  };

  const summaryInputEnvelope = {
    title: input.title,
    status: input.status,
    repository: input.repository,
    branch: input.branch,
    intentCount: input.intentCount,
    editCount: input.editCount,
    landedEditCount: input.landedEditCount,
    openEditCount: input.openEditCount,
    prompts,
    topFiles,
    tools,
  };

  return {
    summaryText,
    summarySearchText: searchFields.join("\n"),
    projectionHash: hashStable(projectionEnvelope),
    summaryInputHash: hashStable(summaryInputEnvelope),
  };
}

export function summaryDirtyReasons(
  existing: Pick<
    SessionSummaryEnrichmentRow,
    | "summary_version"
    | "summary_input_hash"
    | "summary_policy_hash"
    | "enriched_input_hash"
    | "enriched_message_count"
    | "summary_text"
    | "last_material_change_at_ms"
  > | null,
  nextDocs: Pick<SessionSummaryDeterministicDocs, "summaryInputHash">,
  input: Pick<
    SessionSummaryDeterministicInput,
    "messageCount" | "lastActivityMs"
  >,
  policyHash: string,
  nowMs: number,
): string[] {
  const reasons: string[] = [];
  if (!existing) reasons.push("missing");
  const inputChanged =
    !existing || existing.summary_input_hash !== nextDocs.summaryInputHash;
  const policyChanged =
    !existing || existing.summary_policy_hash !== policyHash;
  const versionChanged =
    !existing ||
    existing.summary_version !== SESSION_SUMMARY_ENRICHMENT_VERSION;
  const baselineCurrent =
    !!existing &&
    existing.summary_policy_hash === policyHash &&
    existing.enriched_input_hash === nextDocs.summaryInputHash &&
    existing.summary_version === SESSION_SUMMARY_ENRICHMENT_VERSION;
  const pendingSinceMs = baselineCurrent
    ? null
    : (existing?.last_material_change_at_ms ?? nowMs);
  const messageDelta = Math.max(
    0,
    input.messageCount - (existing?.enriched_message_count ?? 0),
  );
  const pendingAgeMs = pendingSinceMs === null ? 0 : nowMs - pendingSinceMs;
  const lastActivityAgeMs =
    input.lastActivityMs === null
      ? Number.POSITIVE_INFINITY
      : nowMs - input.lastActivityMs;

  if (
    existing &&
    existing.summary_version !== SESSION_SUMMARY_ENRICHMENT_VERSION
  ) {
    reasons.push("summary_version_changed");
  }
  if (existing && existing.summary_input_hash !== nextDocs.summaryInputHash) {
    reasons.push("summary_input_changed");
  }
  if (existing && existing.summary_policy_hash !== policyHash) {
    reasons.push("summary_policy_changed");
  }
  if (existing && !existing.summary_text) reasons.push("missing_summary_text");
  if (!baselineCurrent) {
    if (lastActivityAgeMs > COLD_WINDOW_MS) {
      reasons.push("session_cold");
    } else if (messageDelta >= MESSAGE_THRESHOLD) {
      reasons.push("message_threshold_reached");
    } else if (pendingAgeMs >= PENDING_AGE_THRESHOLD_MS) {
      reasons.push("pending_age_threshold_reached");
    } else if (lastActivityAgeMs <= HOT_WINDOW_MS) {
      reasons.push("session_hot");
    } else {
      reasons.push("session_warm");
    }
  }
  if (inputChanged || policyChanged || versionChanged) {
    reasons.push("refresh_pending");
  }
  return reasons;
}

export function mergeSessionSummaryEnrichment(
  existing: SessionSummaryEnrichmentRow | null,
  input: SessionSummaryDeterministicInput,
  policyHash: string,
  nowMs: number,
): Omit<
  SessionSummaryEnrichmentRow,
  "last_attempted_at_ms" | "failure_count" | "last_error"
> & {
  last_attempted_at_ms: number | null;
  failure_count: number;
  last_error: string | null;
} {
  const docs = buildDeterministicSessionSummaryDocs(input);
  const inputChanged =
    !existing || existing.summary_input_hash !== docs.summaryInputHash;
  const policyChanged =
    !existing || existing.summary_policy_hash !== policyHash;
  const missingSummaryText = !existing?.summary_text;
  const baselineCurrent =
    !!existing &&
    existing.summary_policy_hash === policyHash &&
    existing.enriched_input_hash === docs.summaryInputHash &&
    existing.summary_version === SESSION_SUMMARY_ENRICHMENT_VERSION;
  const pendingSinceMs = baselineCurrent
    ? null
    : (existing?.last_material_change_at_ms ?? nowMs);
  const messageDelta = Math.max(
    0,
    input.messageCount - (existing?.enriched_message_count ?? 0),
  );
  const pendingAgeMs = pendingSinceMs === null ? 0 : nowMs - pendingSinceMs;
  const lastActivityAgeMs =
    input.lastActivityMs === null
      ? Number.POSITIVE_INFINITY
      : nowMs - input.lastActivityMs;
  const shouldRefreshNow =
    !baselineCurrent &&
    (lastActivityAgeMs > COLD_WINDOW_MS ||
      messageDelta >= MESSAGE_THRESHOLD ||
      pendingAgeMs >= PENDING_AGE_THRESHOLD_MS);
  const reasons = summaryDirtyReasons(existing, docs, input, policyHash, nowMs);
  const dirtyReasonJson =
    reasons.length > 0 ? JSON.stringify({ reasons }) : null;

  if (!existing || inputChanged || missingSummaryText) {
    return {
      session_summary_key: input.sessionSummaryKey,
      session_id: input.sessionId,
      summary_text: docs.summaryText,
      summary_search_text: docs.summarySearchText,
      summary_source: "deterministic",
      summary_runner: null,
      summary_model: null,
      summary_version: SESSION_SUMMARY_ENRICHMENT_VERSION,
      summary_generated_at_ms: nowMs,
      projection_hash: docs.projectionHash,
      summary_input_hash: docs.summaryInputHash,
      summary_policy_hash: existing?.summary_policy_hash ?? null,
      enriched_input_hash: existing?.enriched_input_hash ?? null,
      enriched_message_count: existing?.enriched_message_count ?? null,
      dirty: shouldRefreshNow ? 1 : 0,
      dirty_reason_json: dirtyReasonJson,
      last_material_change_at_ms: pendingSinceMs,
      last_attempted_at_ms: existing?.last_attempted_at_ms ?? null,
      failure_count: existing?.failure_count ?? 0,
      last_error: existing?.last_error ?? null,
    };
  }

  return {
    session_summary_key: input.sessionSummaryKey,
    session_id: input.sessionId,
    summary_text: existing.summary_text,
    summary_search_text: docs.summarySearchText,
    summary_source: existing.summary_source ?? "deterministic",
    summary_runner: existing.summary_runner,
    summary_model: existing.summary_model,
    summary_version: existing.summary_version,
    summary_generated_at_ms: existing.summary_generated_at_ms ?? nowMs,
    projection_hash: docs.projectionHash,
    summary_input_hash: docs.summaryInputHash,
    summary_policy_hash: existing.summary_policy_hash,
    enriched_input_hash: existing.enriched_input_hash,
    enriched_message_count: existing.enriched_message_count,
    dirty: shouldRefreshNow || policyChanged ? 1 : 0,
    dirty_reason_json: dirtyReasonJson,
    last_material_change_at_ms: pendingSinceMs,
    last_attempted_at_ms: existing.last_attempted_at_ms,
    failure_count: existing.failure_count,
    last_error: existing.last_error,
  };
}

export function refreshSessionSummaryEnrichmentsOnce(opts?: {
  sessionId?: string;
  limit?: number;
  force?: boolean;
  log?: (msg: string) => void;
}): SessionSummaryEnrichmentRefreshResult {
  const db = getDb();
  const nowMs = Date.now();
  const limit = opts?.limit ?? ENRICH_LIMIT;
  const force = opts?.force === true;
  const log = opts?.log ?? (() => {});

  if (
    !force &&
    isAttemptBackoffActive(
      SUMMARY_GLOBAL_BACKOFF_SCOPE,
      SUMMARY_GLOBAL_RUNNER_AVAILABILITY_KEY,
      nowMs,
    )
  ) {
    log(
      "Session summary enrichment skipped: runner availability backoff active",
    );
    return { attempted: 0, updated: 0 };
  }

  const where: string[] = [];
  const params: unknown[] = [];
  if (!force) {
    where.push("e.dirty = 1");
    where.push(
      `NOT EXISTS (
         SELECT 1
         FROM attempt_backoffs ab
         WHERE ab.scope_kind = ?
           AND ab.scope_key = e.session_summary_key
           AND ab.next_attempt_at_ms > ?
       )`,
    );
    params.push(SUMMARY_ROW_BACKOFF_SCOPE, nowMs);
  }
  if (opts?.sessionId) {
    where.push("e.session_id = ?");
    params.push(opts.sessionId);
  }

  const rows = db
    .prepare(
      `SELECT e.session_summary_key,
              e.session_id,
              e.summary_runner,
              e.summary_input_hash,
              e.last_attempted_at_ms,
              COALESCE(sess.message_count, 0) AS message_count
       FROM session_summary_enrichments e
       JOIN session_summaries s
         ON s.session_summary_key = e.session_summary_key
       LEFT JOIN sessions sess
         ON sess.session_id = e.session_id
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY COALESCE(e.last_material_change_at_ms, 0) DESC,
                COALESCE(s.last_intent_ts_ms, 0) DESC,
                e.session_summary_key ASC
       LIMIT ?`,
    )
    .all(...params, limit) as SessionSummaryRefreshCandidate[];

  if (rows.length === 0) {
    return { attempted: 0, updated: 0 };
  }

  const claimAttempt = db.prepare(
    `UPDATE session_summary_enrichments
     SET last_attempted_at_ms = ?
     WHERE session_summary_key = ?
       AND (? = 1 OR dirty = 1)
       AND (
         (last_attempted_at_ms = ?)
         OR (last_attempted_at_ms IS NULL AND ? IS NULL)
       )`,
  );
  const clearClaim = db.prepare(
    `UPDATE session_summary_enrichments
     SET last_attempted_at_ms = NULL
     WHERE session_summary_key = ?
       AND last_attempted_at_ms = ?
       AND (
         (summary_input_hash = ?)
         OR (summary_input_hash IS NULL AND ? IS NULL)
       )`,
  );
  const releaseClaim = db.prepare(
    `UPDATE session_summary_enrichments
     SET last_attempted_at_ms = NULL
     WHERE session_summary_key = ?
       AND last_attempted_at_ms = ?
       AND NOT (
         (summary_input_hash = ?)
         OR (summary_input_hash IS NULL AND ? IS NULL)
       )`,
  );
  const policy = getSessionSummaryRunnerPolicy();
  const availableRunner = policy.allowedRunners.some(
    (runner) => detectAgent(runner) !== null,
  );
  if (!availableRunner) {
    recordAttemptBackoffFailure(
      SUMMARY_GLOBAL_BACKOFF_SCOPE,
      SUMMARY_GLOBAL_RUNNER_AVAILABILITY_KEY,
      "no allowed summary runner available",
      nowMs,
    );
    log(
      `Session summary enrichment skipped: ${rows.length} dirty rows, no allowed runner`,
    );
    return { attempted: 0, updated: 0 };
  }
  const readyRunner = policy.allowedRunners.some((runner) => {
    if (detectAgent(runner) === null) return false;
    if (force) return true;
    return !isAttemptBackoffActive(SUMMARY_RUNNER_BACKOFF_SCOPE, runner, nowMs);
  });
  if (!readyRunner) {
    log("Session summary enrichment skipped: runner backoff active");
    return { attempted: 0, updated: 0 };
  }

  const updateSuccess = db.prepare(
    `UPDATE session_summary_enrichments
     SET summary_text = ?,
         summary_source = 'llm',
         summary_runner = ?,
         summary_model = ?,
         summary_version = ?,
         summary_generated_at_ms = ?,
         summary_policy_hash = ?,
         enriched_input_hash = ?,
         enriched_message_count = ?,
         dirty = 0,
         dirty_reason_json = NULL,
         last_material_change_at_ms = NULL,
         last_attempted_at_ms = ?,
         failure_count = 0,
         last_error = NULL
     WHERE session_summary_key = ?
       AND last_attempted_at_ms = ?
       AND (
         (summary_input_hash = ?)
         OR (summary_input_hash IS NULL AND ? IS NULL)
       )`,
  );
  const updateFailure = db.prepare(
    `UPDATE session_summary_enrichments
     SET last_attempted_at_ms = ?,
         failure_count = COALESCE(failure_count, 0) + 1,
         last_error = ?
     WHERE session_summary_key = ?
       AND last_attempted_at_ms = ?
       AND (
         (summary_input_hash = ?)
         OR (summary_input_hash IS NULL AND ? IS NULL)
       )`,
  );

  const claimedAtMs = nowMs;
  const claimRows = db.transaction(
    (candidates: SessionSummaryRefreshCandidate[]) => {
      const claimed: SessionSummaryRefreshCandidate[] = [];
      for (const row of candidates) {
        const result = claimAttempt.run(
          claimedAtMs,
          row.session_summary_key,
          force ? 1 : 0,
          row.last_attempted_at_ms,
          row.last_attempted_at_ms,
        );
        if (result.changes > 0) claimed.push(row);
      }
      return claimed;
    },
  );
  const claimedRows = claimRows(rows);
  if (claimedRows.length === 0) {
    return { attempted: 0, updated: 0 };
  }

  let updated = 0;
  for (const row of claimedRows) {
    const context = loadSummaryPromptContext(row.session_summary_key);
    const finishAttempt = (
      error: string,
      backoff?: { scopeKind: string; scopeKey: string } | undefined,
    ) => {
      const finishedAtMs = Date.now();
      if (backoff) {
        recordAttemptBackoffFailure(
          backoff.scopeKind,
          backoff.scopeKey,
          error,
          finishedAtMs,
        );
      }
      const result = updateFailure.run(
        finishedAtMs,
        error,
        row.session_summary_key,
        claimedAtMs,
        row.summary_input_hash,
        row.summary_input_hash,
      );
      if (result.changes === 0) {
        releaseClaim.run(
          row.session_summary_key,
          claimedAtMs,
          row.summary_input_hash,
          row.summary_input_hash,
        );
      }
    };

    if (!context) {
      finishAttempt("summary projection missing", {
        scopeKind: SUMMARY_ROW_BACKOFF_SCOPE,
        scopeKey: row.session_summary_key,
      });
      continue;
    }

    const selection = selectSessionSummaryRunner({
      sessionTarget: context.target,
      stickyRunner: row.summary_runner,
      policy,
      detector: (runner) => {
        const detected = detectAgent(runner);
        if (!detected) return null;
        if (
          !force &&
          isAttemptBackoffActive(SUMMARY_RUNNER_BACKOFF_SCOPE, runner, nowMs)
        ) {
          return null;
        }
        return detected;
      },
    });
    if (!selection.runner) {
      const cleared = clearClaim.run(
        row.session_summary_key,
        claimedAtMs,
        row.summary_input_hash,
        row.summary_input_hash,
      );
      if (cleared.changes === 0) {
        releaseClaim.run(
          row.session_summary_key,
          claimedAtMs,
          row.summary_input_hash,
          row.summary_input_hash,
        );
      }
      continue;
    }

    const prompt = buildLlmPrompt(context);
    const result = invokeLlm(prompt, {
      runner: selection.runner,
      timeoutMs: ENRICH_TIMEOUT_MS,
      withMcp: false,
      systemPrompt: SYSTEM_PROMPT,
      model: selection.model,
    });
    if (!result) {
      finishAttempt(
        `summary enrichment invocation failed for ${selection.runner}`,
        {
          scopeKind: SUMMARY_RUNNER_BACKOFF_SCOPE,
          scopeKey: selection.runner,
        },
      );
      continue;
    }

    const finishedAtMs = Date.now();
    const write = updateSuccess.run(
      result,
      selection.runner,
      selection.model,
      SESSION_SUMMARY_ENRICHMENT_VERSION,
      finishedAtMs,
      selection.policyHash,
      row.summary_input_hash,
      row.message_count,
      finishedAtMs,
      row.session_summary_key,
      claimedAtMs,
      row.summary_input_hash,
      row.summary_input_hash,
    );
    if (write.changes > 0) {
      clearAttemptBackoff(
        SUMMARY_GLOBAL_BACKOFF_SCOPE,
        SUMMARY_GLOBAL_RUNNER_AVAILABILITY_KEY,
      );
      clearAttemptBackoff(SUMMARY_RUNNER_BACKOFF_SCOPE, selection.runner);
      clearAttemptBackoff(SUMMARY_ROW_BACKOFF_SCOPE, row.session_summary_key);
      updated += 1;
      continue;
    }

    releaseClaim.run(
      row.session_summary_key,
      claimedAtMs,
      row.summary_input_hash,
      row.summary_input_hash,
    );
  }

  if (updated > 0) {
    log(`Enriched ${updated} session summaries with LLM output`);
  }
  return { attempted: claimedRows.length, updated };
}

function loadSummaryPromptContext(sessionSummaryKey: string): {
  title: string;
  status: string;
  target: string | null;
  repository: string | null;
  branch: string | null;
  intentCount: number;
  editCount: number;
  landedEditCount: number;
  openEditCount: number;
  intents: string[];
  files: Array<{ filePath: string; editCount: number; landedCount: number }>;
  summarySearchText: string | null;
} | null {
  const db = getDb();
  const summary = db
    .prepare(
      `SELECT s.title,
              s.status,
              sess.target,
              s.repository,
              s.branch,
              s.intent_count,
              s.edit_count,
              s.landed_edit_count,
              s.open_edit_count,
              e.summary_search_text
       FROM session_summaries s
       LEFT JOIN sessions sess
         ON sess.session_id = SUBSTR(s.session_summary_key, LENGTH('ss:local:') + 1)
       LEFT JOIN session_summary_enrichments e
         ON e.session_summary_key = s.session_summary_key
       WHERE s.session_summary_key = ?`,
    )
    .get(sessionSummaryKey) as
    | {
        title: string;
        status: string;
        target: string | null;
        repository: string | null;
        branch: string | null;
        intent_count: number;
        edit_count: number;
        landed_edit_count: number;
        open_edit_count: number;
        summary_search_text: string | null;
      }
    | undefined;
  if (!summary) return null;

  const intents = (
    db
      .prepare(
        `SELECT u.prompt_text
         FROM session_summaries s
         JOIN intent_session_summaries iss
           ON iss.session_summary_id = s.id
         JOIN intent_units u
           ON u.id = iss.intent_unit_id
         WHERE s.session_summary_key = ?
         ORDER BY COALESCE(u.prompt_ts_ms, 0) ASC, u.id ASC`,
      )
      .all(sessionSummaryKey) as Array<{ prompt_text: string }>
  )
    .map((row) => row.prompt_text)
    .filter((value) => value.trim().length > 0)
    .slice(0, 6);

  const files = (
    db
      .prepare(
        `SELECT e.file_path,
                COUNT(*) AS edit_count,
                SUM(CASE WHEN e.landed = 1 THEN 1 ELSE 0 END) AS landed_count
         FROM session_summaries s
         JOIN intent_session_summaries iss
           ON iss.session_summary_id = s.id
         JOIN intent_edits e
           ON e.intent_unit_id = iss.intent_unit_id
         WHERE s.session_summary_key = ?
         GROUP BY e.file_path
         ORDER BY edit_count DESC, e.file_path ASC`,
      )
      .all(sessionSummaryKey) as Array<{
      file_path: string;
      edit_count: number;
      landed_count: number;
    }>
  )
    .map((row) => ({
      filePath: row.file_path,
      editCount: row.edit_count,
      landedCount: row.landed_count,
    }))
    .slice(0, 6);

  return {
    title: summary.title,
    status: summary.status,
    target: summary.target,
    repository: summary.repository,
    branch: summary.branch,
    intentCount: summary.intent_count,
    editCount: summary.edit_count,
    landedEditCount: summary.landed_edit_count,
    openEditCount: summary.open_edit_count,
    intents,
    files,
    summarySearchText: summary.summary_search_text,
  };
}

function buildLlmPrompt(context: {
  title: string;
  status: string;
  repository: string | null;
  branch: string | null;
  intentCount: number;
  editCount: number;
  landedEditCount: number;
  openEditCount: number;
  intents: string[];
  files: Array<{ filePath: string; editCount: number; landedCount: number }>;
  summarySearchText: string | null;
}): string {
  const lines = [
    `Title: ${context.title}`,
    `Status: ${context.status}`,
    context.repository ? `Repository: ${context.repository}` : null,
    context.branch ? `Branch: ${context.branch}` : null,
    `Counts: intents ${context.intentCount}; edits ${context.editCount}; landed ${context.landedEditCount}; open ${context.openEditCount}`,
    context.files.length > 0
      ? `Files:\n${context.files
          .map(
            (file) =>
              `- ${file.filePath} (${file.editCount} edits, ${file.landedCount} landed)`,
          )
          .join("\n")}`
      : null,
    context.intents.length > 0
      ? `Intent prompts:\n${context.intents.map((prompt) => `- ${prompt}`).join("\n")}`
      : null,
    context.summarySearchText
      ? `Deterministic retrieval document:\n${context.summarySearchText}`
      : null,
    "Write the per-session summary.",
  ].filter((value): value is string => Boolean(value));
  return lines.join("\n\n");
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isSummaryRunnerName(
  value: unknown,
): value is SessionSummaryRunnerName {
  return value === "claude" || value === "codex";
}

function normalizeRunners(
  values: readonly unknown[] | undefined,
  fallback: SessionSummaryRunnerName[],
): SessionSummaryRunnerName[] {
  const normalized = values?.filter(isSummaryRunnerName) ?? [];
  return normalized.length > 0 ? [...new Set(normalized)] : fallback;
}

function normalizeItems(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const compact = value.replace(/\s+/g, " ").trim();
    if (!compact || seen.has(compact)) continue;
    seen.add(compact);
    normalized.push(compact);
    if (normalized.length >= limit) break;
  }
  return normalized;
}
