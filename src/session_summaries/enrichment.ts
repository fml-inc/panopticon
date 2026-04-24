import {
  clearAttemptBackoff,
  isAttemptBackoffActive,
  recordAttemptBackoffFailure,
} from "../attempt-backoff.js";
import type { SessionSummaryRunnerName } from "../config.js";
import { config } from "../config.js";
import { getDb } from "../db/schema.js";
import { detectAgent, invokeLlm } from "../summary/llm.js";
import {
  SUMMARY_GLOBAL_BACKOFF_SCOPE,
  SUMMARY_GLOBAL_RUNNER_AVAILABILITY_KEY,
  SUMMARY_ROW_BACKOFF_SCOPE,
  SUMMARY_RUNNER_BACKOFF_SCOPE,
} from "./backoff.js";
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
  loadSessionSummaryEditRows,
  loadSessionSummaryIntentRows,
  summarizeFiles,
} from "./session-data.js";

const DEFAULT_ENRICH_LIMIT = 5;
const DEFAULT_ENRICH_TIMEOUT_MS = 90_000;
const LAST_ACTIVITY_SQL = `MAX(
  COALESCE(sess.started_at_ms, 0),
  COALESCE(sess.ended_at_ms, 0),
  COALESCE(s.last_intent_ts_ms, 0)
)`;

// Prompt/template changes should bump SESSION_SUMMARY_ENRICHMENT_VERSION.
// policyHash intentionally covers runner/config policy only, not prompt text.
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

export function refreshSessionSummaryEnrichmentsOnce(opts?: {
  sessionId?: string;
  limit?: number;
  force?: boolean;
  log?: (msg: string) => void;
}): SessionSummaryEnrichmentRefreshResult {
  const db = getDb();
  const nowMs = Date.now();
  const limit =
    opts?.limit ?? config.sessionSummaryEnrichLimit ?? DEFAULT_ENRICH_LIMIT;
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

  let updated = 0;
  for (const row of claimedRows) {
    const context = loadSummaryPromptContext(row.session_summary_key);
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
    const startedAtMs = Date.now();
    log(
      `Session summary enrichment start: session=${row.session_id} key=${row.session_summary_key} runner=${selection.runner} model=${selection.model ?? "default"} messages=${row.message_count}`,
    );
    const result = invokeLlm(prompt, {
      runner: selection.runner,
      timeoutMs,
      withMcp: false,
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
      continue;
    }

    const finishedAtMs = Date.now();
    const durationMs = finishedAtMs - startedAtMs;
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
      updateSearchIndexSuccess?.run(
        row.session_summary_key,
        row.session_id,
        SESSION_SUMMARY_SEARCH_CORPUS.llmSummary,
        SESSION_SUMMARY_SEARCH_PRIORITY.llmSummary,
        result,
        row.summary_input_hash,
        finishedAtMs,
      );
      updateSearchIndexSuccess?.run(
        row.session_summary_key,
        row.session_id,
        SESSION_SUMMARY_SEARCH_CORPUS.llmSearch,
        SESSION_SUMMARY_SEARCH_PRIORITY.llmSearch,
        result,
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

function formatDurationMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 100) return `${Math.round(ms)}ms`;
  return `${ms.toFixed(1)}ms`;
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
  intents: string[];
  files: Array<{ filePath: string; editCount: number; landedCount: number }>;
  recentMessages: Array<{ role: string; content: string }>;
  summarySearchText: string | null;
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
              s.summary_search_text
       FROM session_summaries s
       LEFT JOIN sessions sess
         ON sess.session_id = s.session_id
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
        summary_search_text: string | null;
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
  const recentMessages = loadRecentMessageSnippets(summary.session_id);

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
    intents,
    files,
    recentMessages,
    summarySearchText: summary.summary_search_text,
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
  intents: string[];
  files: Array<{ filePath: string; editCount: number; landedCount: number }>;
  recentMessages: Array<{ role: string; content: string }>;
  summarySearchText: string | null;
}): string {
  const lines = [
    `Title: ${context.title}`,
    `Status: ${context.status}`,
    context.repository ? `Repository: ${context.repository}` : null,
    context.branch ? `Branch: ${context.branch}` : null,
    `Counts: messages ${context.messageCount}; intents ${context.intentCount}; edits ${context.editCount}; landed ${context.landedEditCount}; open ${context.openEditCount}`,
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
    context.recentMessages.length > 0
      ? `Recent messages:\n${context.recentMessages
          .map((message) => `- ${message.role}: ${message.content}`)
          .join("\n")}`
      : null,
    context.summarySearchText
      ? `Deterministic retrieval document:\n${context.summarySearchText}`
      : null,
    "Write the per-session summary.",
  ].filter((value): value is string => Boolean(value));
  return lines.join("\n\n");
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
