import {
  clearAttemptBackoff,
  isAttemptBackoffActive,
  recordAttemptBackoffFailure,
} from "../attempt-backoff.js";
import type { SessionSummaryRunnerName } from "../config.js";
import { config } from "../config.js";
import { getDb } from "../db/schema.js";
import { detectAgent, invokeLlmAsync } from "../summary/llm.js";
import { sessionSummaryLastActivitySql } from "./activity.js";
import {
  SUMMARY_GLOBAL_BACKOFF_SCOPE,
  SUMMARY_GLOBAL_RUNNER_AVAILABILITY_KEY,
  SUMMARY_ROW_BACKOFF_SCOPE,
  SUMMARY_RUNNER_BACKOFF_SCOPE,
} from "./backoff.js";
import { invalidSessionSummaryEnrichmentReason } from "./enrichment-quality.js";
import {
  SESSION_SUMMARY_COLD_WINDOW_MS,
  SESSION_SUMMARY_ENRICHMENT_VERSION,
  SESSION_SUMMARY_MESSAGE_THRESHOLD,
  SESSION_SUMMARY_PENDING_AGE_THRESHOLD_MS,
} from "./model.js";
import {
  getSessionSummaryRunnerPolicy,
  inferRunnerFromSessionTarget,
  isSummaryRunnerName,
  type SessionSummaryRunnerPolicy,
} from "./policy.js";
import {
  SESSION_SUMMARY_SEARCH_CORPUS,
  SESSION_SUMMARY_SEARCH_PRIORITY,
} from "./search-index.js";
import {
  loadSessionSummaryAwaySummaryRows,
  loadSessionSummaryEditRows,
  loadSessionSummaryIntentRows,
  summarizeFiles,
} from "./session-data.js";

const DEFAULT_ENRICH_LIMIT = 5;
const DEFAULT_ENRICH_CONCURRENCY = 2;
const DEFAULT_ENRICH_TIMEOUT_MS = 90_000;
const LAST_ACTIVITY_SQL = sessionSummaryLastActivitySql();

// Prompt/template changes should bump SESSION_SUMMARY_ENRICHMENT_VERSION.
// policyHash intentionally covers runner/config policy only, not prompt text.
const SYSTEM_PROMPT = `You are enriching a per-session coding summary for retrieval and future pickup.

Rules:
1. Use only the structured session data provided in the prompt or retrieved through the requested Panopticon MCP tools
2. Existing summaries are useful scaffolding, but they are not authoritative; refine them with raw session evidence when the session has later activity, pivots, reverted work, deferred decisions, or ambiguous outcomes
3. Follow the summary length target in the user prompt; use extra length for complex sessions to capture evolved decisions, deferred work, reverted approaches, and verification, but do not pad simple outcomes
4. Lead with the main outcome, decision, or highest-value finding
5. Capture what changed, what landed or was decided, and any context that would help someone pick up related work later
6. For review sessions, emphasize findings, severity, and whether fixes landed
7. For implementation or debugging sessions, emphasize what changed and how it was verified
8. If there is no useful continuity context, do not invent it
9. Do not mention the model, agent, message count, timestamps, absolute local paths, database paths, prompt engineering, validation batches, or investigation mechanics
10. Do not mention any work that happened after the target session ended
11. If no code changed, say that explicitly
12. Output ONLY the summary text`;

export interface SessionSummaryEnrichmentRefreshResult {
  attempted: number;
  updated: number;
}

interface SessionSummaryRefreshCandidate {
  session_summary_key: string;
  session_id: string;
  summary_runner: string | null;
  summary_input_hash: string | null;
  enriched_message_count: number | null;
  last_material_change_at_ms: number | null;
  last_activity_ms: number | null;
  message_count: number;
  last_attempted_at_ms: number | null;
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

  if (policy.strategy === "fixed") {
    add(policy.fixedRunner);
  } else {
    add(isSummaryRunnerName(opts.stickyRunner) ? opts.stickyRunner : null);
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

export async function refreshSessionSummaryEnrichmentsOnce(opts?: {
  sessionId?: string;
  limit?: number;
  concurrency?: number;
  force?: boolean;
  log?: (msg: string) => void;
}): Promise<SessionSummaryEnrichmentRefreshResult> {
  const db = getDb();
  const nowMs = Date.now();
  const limit =
    opts?.limit ?? config.sessionSummaryEnrichLimit ?? DEFAULT_ENRICH_LIMIT;
  const concurrency = Math.max(
    1,
    Math.min(
      limit,
      opts?.concurrency ??
        config.sessionSummaryEnrichConcurrency ??
        DEFAULT_ENRICH_CONCURRENCY,
    ),
  );
  const force = opts?.force === true;
  const log = opts?.log ?? (() => {});
  const timeoutMs =
    config.sessionSummaryEnrichTimeoutMs ?? DEFAULT_ENRICH_TIMEOUT_MS;

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
    where.push(
      `(
         (? - ${LAST_ACTIVITY_SQL}) > ?
         OR MAX(0, COALESCE(sess.message_count, 0) - COALESCE(e.enriched_message_count, 0)) >= ?
         OR (? - COALESCE(e.last_material_change_at_ms, ?)) >= ?
       )`,
    );
    params.push(
      nowMs,
      SESSION_SUMMARY_COLD_WINDOW_MS,
      SESSION_SUMMARY_MESSAGE_THRESHOLD,
      nowMs,
      nowMs,
      SESSION_SUMMARY_PENDING_AGE_THRESHOLD_MS,
    );
  }
  if (opts?.sessionId) {
    where.push("e.session_id = ?");
    params.push(opts.sessionId);
  } else {
    where.push("COALESCE(sess.is_automated, 0) != 1");
  }

  const rows = db
    .prepare(
      `SELECT e.session_summary_key,
              e.session_id,
              e.summary_runner,
              e.summary_input_hash,
              e.enriched_message_count,
              e.last_material_change_at_ms,
              e.last_attempted_at_ms,
              COALESCE(sess.message_count, 0) AS message_count,
              ${LAST_ACTIVITY_SQL} AS last_activity_ms
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

  const candidates = rows;

  if (candidates.length === 0) {
    return { attempted: 0, updated: 0 };
  }

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
      `Session summary enrichment skipped: ${candidates.length} dirty rows, no allowed runner`,
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
  const searchIndexExists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_summary_search_index'",
    )
    .get();
  const updateSearchIndexSuccess = searchIndexExists
    ? db.prepare(
        `INSERT INTO session_summary_search_index
         (session_summary_key, session_id, corpus_key, source, priority,
          search_text, dirty, projection_hash, enriched_input_hash,
          updated_at_ms)
         VALUES (?, ?, ?, 'llm', ?, ?, 0, NULL, ?, ?)
         ON CONFLICT(session_summary_key, corpus_key) DO UPDATE SET
           session_id = excluded.session_id,
           source = excluded.source,
           priority = excluded.priority,
           search_text = excluded.search_text,
           dirty = excluded.dirty,
           enriched_input_hash = excluded.enriched_input_hash,
           updated_at_ms = excluded.updated_at_ms`,
      )
    : null;
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
  const bumpDerivedSyncSeq = db.prepare(
    `UPDATE sessions
     SET derived_sync_seq = COALESCE(derived_sync_seq, 0) + 1
     WHERE session_id = ?`,
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
  const claimedRows = claimRows(candidates);
  if (claimedRows.length === 0) {
    return { attempted: 0, updated: 0 };
  }

  const processRow = async (
    row: SessionSummaryRefreshCandidate,
  ): Promise<number> => {
    const finishAttempt = (
      error: string,
      backoff?: { scopeKind: string; scopeKey: string },
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
      if (result.changes > 0) {
        bumpDerivedSyncSeq.run(row.session_id);
      }
      if (result.changes === 0) {
        releaseClaim.run(
          row.session_summary_key,
          claimedAtMs,
          row.summary_input_hash,
          row.summary_input_hash,
        );
      }
    };

    try {
      const context = loadSummaryPromptContext(row.session_summary_key);
      if (!context) {
        finishAttempt("summary projection missing", {
          scopeKind: SUMMARY_ROW_BACKOFF_SCOPE,
          scopeKey: row.session_summary_key,
        });
        return 0;
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
        return 0;
      }

      const usePanopticonMcp = selection.runner === "codex";
      const prompt = usePanopticonMcp
        ? buildLlmMcpPrompt(row.session_id, context)
        : buildLlmPrompt(context);
      const startedAtMs = Date.now();
      log(
        `Session summary enrichment start: session=${row.session_id} key=${row.session_summary_key} runner=${selection.runner} model=${selection.model ?? "default"} messages=${row.message_count}`,
      );
      const result = await invokeLlmAsync(prompt, {
        runner: selection.runner,
        timeoutMs,
        withMcp: usePanopticonMcp,
        systemPrompt: SYSTEM_PROMPT,
        model: selection.model,
      });
      if (!result) {
        const durationMs = Date.now() - startedAtMs;
        log(
          `Session summary enrichment failed: session=${row.session_id} key=${row.session_summary_key} runner=${selection.runner} duration=${formatDurationMs(durationMs)}`,
        );
        finishAttempt(
          `summary enrichment invocation failed for ${selection.runner}`,
          {
            scopeKind: SUMMARY_RUNNER_BACKOFF_SCOPE,
            scopeKey: selection.runner,
          },
        );
        return 0;
      }

      const parsed = parseSessionSummaryEnrichmentOutput(result);
      if (!parsed) {
        finishAttempt("summary enrichment returned empty output", {
          scopeKind: SUMMARY_RUNNER_BACKOFF_SCOPE,
          scopeKey: selection.runner,
        });
        return 0;
      }

      const invalidReason = invalidSessionSummaryEnrichmentReason(
        parsed.summaryText,
      );
      if (invalidReason) {
        const durationMs = Date.now() - startedAtMs;
        log(
          `Session summary enrichment rejected: session=${row.session_id} key=${row.session_summary_key} runner=${selection.runner} duration=${formatDurationMs(durationMs)} reason=${invalidReason}`,
        );
        finishAttempt(invalidReason, {
          scopeKind: SUMMARY_ROW_BACKOFF_SCOPE,
          scopeKey: row.session_summary_key,
        });
        return 0;
      }

      const finishedAtMs = Date.now();
      const durationMs = finishedAtMs - startedAtMs;
      const write = updateSuccess.run(
        parsed.summaryText,
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
        bumpDerivedSyncSeq.run(row.session_id);
        updateSearchIndexSuccess?.run(
          row.session_summary_key,
          row.session_id,
          SESSION_SUMMARY_SEARCH_CORPUS.llmSummary,
          SESSION_SUMMARY_SEARCH_PRIORITY.llmSummary,
          parsed.summaryText,
          row.summary_input_hash,
          finishedAtMs,
        );
        updateSearchIndexSuccess?.run(
          row.session_summary_key,
          row.session_id,
          SESSION_SUMMARY_SEARCH_CORPUS.llmSearch,
          SESSION_SUMMARY_SEARCH_PRIORITY.llmSearch,
          parsed.searchText,
          row.summary_input_hash,
          finishedAtMs,
        );
        clearAttemptBackoff(
          SUMMARY_GLOBAL_BACKOFF_SCOPE,
          SUMMARY_GLOBAL_RUNNER_AVAILABILITY_KEY,
        );
        clearAttemptBackoff(SUMMARY_RUNNER_BACKOFF_SCOPE, selection.runner);
        clearAttemptBackoff(SUMMARY_ROW_BACKOFF_SCOPE, row.session_summary_key);
        log(
          `Session summary enrichment success: session=${row.session_id} key=${row.session_summary_key} runner=${selection.runner} model=${selection.model ?? "default"} duration=${formatDurationMs(durationMs)} messages=${row.message_count} chars=${result.length}`,
        );
        return 1;
      }

      releaseClaim.run(
        row.session_summary_key,
        claimedAtMs,
        row.summary_input_hash,
        row.summary_input_hash,
      );
      return 0;
    } catch (error) {
      finishAttempt(
        `summary enrichment failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          scopeKind: SUMMARY_ROW_BACKOFF_SCOPE,
          scopeKey: row.session_summary_key,
        },
      );
      return 0;
    }
  };

  const updated = await mapWithConcurrency(
    claimedRows,
    concurrency,
    processRow,
  );

  if (updated > 0) {
    log(`Enriched ${updated} session summaries with LLM output`);
  }
  return { attempted: claimedRows.length, updated };
}

export interface ParsedSessionSummaryEnrichmentOutput {
  summaryText: string;
  searchText: string;
}

export function parseSessionSummaryEnrichmentOutput(
  output: string,
): ParsedSessionSummaryEnrichmentOutput | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  const jsonText = stripJsonFence(trimmed);
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const summaryText = normalizeGeneratedText(
        record.summary_text ?? record.summaryText ?? record.summary,
      );
      if (summaryText) {
        const searchText =
          normalizeGeneratedText(record.search_text ?? record.searchText) ??
          summaryText;
        return {
          summaryText,
          searchText,
        };
      }
    }
  } catch {
    // Existing installations and tests may still receive plain summary text.
  }

  const summaryText = normalizeGeneratedText(trimmed);
  if (!summaryText) return null;
  return {
    summaryText,
    searchText: summaryText,
  };
}

function stripJsonFence(value: string): string {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : value;
}

function normalizeGeneratedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 0 ? compact : null;
}

function formatDurationMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 100) return `${Math.round(ms)}ms`;
  return `${ms.toFixed(1)}ms`;
}

async function mapWithConcurrency<T>(
  rows: readonly T[],
  concurrency: number,
  worker: (row: T) => Promise<number>,
): Promise<number> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, rows.length);

  const counts = await Promise.all(
    Array.from({ length: workerCount }, async () => {
      let localUpdated = 0;
      while (true) {
        const index = nextIndex++;
        if (index >= rows.length) return localUpdated;
        localUpdated += await worker(rows[index]);
      }
    }),
  );

  return counts.reduce((sum, count) => sum + count, 0);
}

function loadSummaryPromptContext(sessionSummaryKey: string): {
  title: string;
  status: string;
  target: string | null;
  repository: string | null;
  branch: string | null;
  messageCount: number;
  intentCount: number;
  editCount: number;
  landedEditCount: number;
  openEditCount: number;
  priorSummaryText: string | null;
  priorSummarySource: string | null;
  priorEnrichedMessageCount: number | null;
  intents: string[];
  awaySummaries: string[];
  files: Array<{ filePath: string; editCount: number; landedCount: number }>;
  recentMessages: Array<{ role: string; content: string }>;
  deterministicSearchCorpus: string | null;
} | null {
  const db = getDb();
  const summary = db
    .prepare(
      `SELECT s.title,
              s.status,
              s.session_id,
              sess.target,
              s.repository,
              s.branch,
              COALESCE(sess.message_count, 0) AS message_count,
              s.intent_count,
              s.edit_count,
              s.landed_edit_count,
              s.open_edit_count,
              e.summary_text AS prior_summary_text,
              e.summary_source AS prior_summary_source,
              e.enriched_message_count AS prior_enriched_message_count
       FROM session_summaries s
       LEFT JOIN sessions sess
         ON sess.session_id = s.session_id
       LEFT JOIN session_summary_enrichments e
         ON e.session_summary_key = s.session_summary_key
       WHERE s.session_summary_key = ?`,
    )
    .get(sessionSummaryKey) as
    | {
        title: string;
        status: string;
        session_id: string;
        target: string | null;
        repository: string | null;
        branch: string | null;
        message_count: number;
        intent_count: number;
        edit_count: number;
        landed_edit_count: number;
        open_edit_count: number;
        prior_summary_text: string | null;
        prior_summary_source: string | null;
        prior_enriched_message_count: number | null;
      }
    | undefined;
  if (!summary) return null;

  const intents = loadSessionSummaryIntentRows(summary.session_id)
    .map((row) => row.prompt_text)
    .filter((value) => value.trim().length > 0)
    .slice(0, 6);

  const files = summarizeFiles(
    loadSessionSummaryEditRows(summary.session_id),
  ).slice(0, 6);
  const awaySummaries = loadSessionSummaryAwaySummaryRows(
    summary.session_id,
  ).map((row) => row.content);
  const recentMessages = loadRecentMessageSnippets(summary.session_id);
  const deterministicSearchCorpus =
    loadDeterministicSearchCorpus(sessionSummaryKey);

  return {
    title: summary.title,
    status: summary.status,
    target: summary.target,
    repository: summary.repository,
    branch: summary.branch,
    messageCount: summary.message_count,
    intentCount: summary.intent_count,
    editCount: summary.edit_count,
    landedEditCount: summary.landed_edit_count,
    openEditCount: summary.open_edit_count,
    priorSummaryText: validPriorSummaryText(summary.prior_summary_text),
    priorSummarySource: summary.prior_summary_source,
    priorEnrichedMessageCount: summary.prior_enriched_message_count,
    intents,
    awaySummaries,
    files,
    recentMessages,
    deterministicSearchCorpus,
  };
}

function buildLlmPrompt(context: {
  title: string;
  status: string;
  repository: string | null;
  branch: string | null;
  messageCount: number;
  intentCount: number;
  editCount: number;
  landedEditCount: number;
  openEditCount: number;
  priorSummaryText: string | null;
  priorSummarySource: string | null;
  priorEnrichedMessageCount: number | null;
  intents: string[];
  awaySummaries: string[];
  files: Array<{ filePath: string; editCount: number; landedCount: number }>;
  recentMessages: Array<{ role: string; content: string }>;
  deterministicSearchCorpus: string | null;
}): string {
  const lengthTarget = selectSummaryLengthTarget(context);
  const lines = [
    `Title: ${context.title}`,
    `Status: ${context.status}`,
    context.repository ? `Repository: ${context.repository}` : null,
    context.branch ? `Branch: ${context.branch}` : null,
    `Counts: messages ${context.messageCount}; intents ${context.intentCount}; edits ${context.editCount}; landed ${context.landedEditCount}; open ${context.openEditCount}`,
    `Summary length target: ${lengthTarget.description}.`,
    context.priorSummaryText
      ? `Existing summary scaffold (${context.priorSummarySource ?? "unknown"}${context.priorEnrichedMessageCount !== null ? `, covered ${context.priorEnrichedMessageCount} messages` : ""}):\n${context.priorSummaryText}`
      : null,
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
    context.awaySummaries.length > 0
      ? `Agent recap summaries:\n${context.awaySummaries.map((summary) => `- ${summary}`).join("\n")}`
      : null,
    context.recentMessages.length > 0
      ? `Recent messages:\n${context.recentMessages
          .map((message) => `- ${message.role}: ${message.content}`)
          .join("\n")}`
      : null,
    context.deterministicSearchCorpus
      ? `Existing deterministic summary/search scaffold:\n${context.deterministicSearchCorpus}`
      : null,
    "Use existing scaffold material as a foundation, but prefer raw recent messages when they add pivots, corrections, reverted work, deferred decisions, or newer verification.",
    "Write the per-session summary.",
  ].filter((value): value is string => Boolean(value));
  return lines.join("\n\n");
}

function validPriorSummaryText(value: string | null): string | null {
  const text = normalizeGeneratedText(value);
  if (!text) return null;
  return invalidSessionSummaryEnrichmentReason(text) ? null : text;
}

function buildLlmMcpPrompt(
  sessionId: string,
  context: {
    status: string;
    messageCount: number;
    intentCount: number;
    editCount: number;
    landedEditCount: number;
    openEditCount: number;
    files: Array<{ filePath: string; editCount: number; landedCount: number }>;
  },
): string {
  const lengthTarget = selectSummaryLengthTarget(context);
  return [
    `Session id: ${sessionId}`,
    "",
    `Summary length target: ${lengthTarget.description}.`,
    "Use Panopticon MCP tools to load this exact session.",
    "Start with session_summary_detail to get the existing summary, counts, files, and enrichment timestamp as a cheap foundation.",
    "Then inspect raw timeline evidence, especially messages/tool calls after the existing enrichment was generated; inspect earlier timeline pages too when the session is complex, mixed, contains pivots/reverts/deferred work, or the raw evidence changes the story.",
    "Also query scanner_events for event_type='away_summary' and use those captured recap records as session evidence when present.",
    "Use query, search, or get only if needed to resolve ambiguity or avoid paging through irrelevant timeline data.",
    "Do not simply rewrite the existing summary.",
    "Write the per-session summary.",
  ].join("\n");
}

function selectSummaryLengthTarget(context: {
  status: string;
  messageCount: number;
  intentCount: number;
  editCount: number;
  landedEditCount: number;
  openEditCount: number;
  files: Array<{ filePath: string; editCount: number; landedCount: number }>;
}): { tier: "small" | "normal" | "complex"; description: string } {
  const mixedOutcome =
    context.status === "mixed" ||
    (context.editCount > 0 && context.landedEditCount < context.editCount) ||
    context.openEditCount > 0;
  const fileSpread = context.files.length;
  if (
    context.intentCount >= 10 ||
    context.messageCount >= 80 ||
    context.editCount >= 40 ||
    fileSpread >= 5 ||
    (mixedOutcome && (context.intentCount >= 5 || context.editCount >= 12))
  ) {
    return {
      tier: "complex",
      description:
        "complex session, 4-6 concise sentences, max 240 words; use the extra length to capture evolved decisions, deferred work, reverted approaches, and verification",
    };
  }
  if (
    context.intentCount >= 3 ||
    context.messageCount >= 20 ||
    context.editCount >= 8 ||
    mixedOutcome
  ) {
    return {
      tier: "normal",
      description: "normal session, 2-4 concise sentences, max 160 words",
    };
  }
  return {
    tier: "small",
    description: "small session, 1-2 concise sentences, max 80 words",
  };
}

function loadDeterministicSearchCorpus(
  sessionSummaryKey: string,
): string | null {
  const db = getDb();
  const searchIndexExists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_summary_search_index'",
    )
    .get();
  if (!searchIndexExists) return null;

  const rows = db
    .prepare(
      `SELECT corpus_key, search_text
       FROM session_summary_search_index
       WHERE session_summary_key = ?
         AND source = 'deterministic'
       ORDER BY priority DESC, corpus_key ASC`,
    )
    .all(sessionSummaryKey) as Array<{
    corpus_key: string;
    search_text: string;
  }>;

  if (rows.length === 0) return null;
  return rows
    .map((row) => `${row.corpus_key}:\n${row.search_text}`)
    .join("\n\n");
}

function loadRecentMessageSnippets(
  sessionId: string,
): Array<{ role: string; content: string }> {
  const db = getDb();
  const messagesTableExists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'",
    )
    .get();
  if (!messagesTableExists) return [];

  return (
    db
      .prepare(
        `SELECT role, content
         FROM messages
         WHERE session_id = ?
           AND COALESCE(is_system, 0) = 0
           AND TRIM(COALESCE(content, '')) <> ''
         ORDER BY ordinal DESC, id DESC
         LIMIT 6`,
      )
      .all(sessionId) as Array<{ role: string; content: string }>
  )
    .reverse()
    .map((message) => ({
      role: normalizeMessageRole(message.role),
      content: compactMessageContent(message.content),
    }))
    .filter((message) => message.content.length > 0);
}

function normalizeMessageRole(role: string): string {
  const normalized = role.trim().toLowerCase();
  if (normalized === "user" || normalized === "assistant") return normalized;
  return normalized || "message";
}

function compactMessageContent(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}
