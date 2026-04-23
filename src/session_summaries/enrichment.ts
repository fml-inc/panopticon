import type { SessionSummaryRunnerName } from "../config.js";
import { getDb } from "../db/schema.js";
import { detectAgent, invokeLlm } from "../summary/llm.js";
import { SESSION_SUMMARY_ENRICHMENT_VERSION } from "./model.js";
import {
  getSessionSummaryRunnerPolicy,
  inferRunnerFromSessionTarget,
  isSummaryRunnerName,
  type SessionSummaryRunnerPolicy,
} from "./policy.js";

const ENRICH_LIMIT = 5;
const ENRICH_TIMEOUT_MS = 90_000;
const ENRICH_RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000;

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

  const where: string[] = [];
  const params: unknown[] = [];
  if (!force) {
    where.push("e.refresh_now = 1");
    where.push(
      "(e.last_attempted_at_ms IS NULL OR e.last_attempted_at_ms < ?)",
    );
    params.push(nowMs - ENRICH_RETRY_BACKOFF_MS);
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

  const policy = getSessionSummaryRunnerPolicy();
  const availableRunner = policy.allowedRunners.some(
    (runner) => detectAgent(runner) !== null,
  );
  if (!availableRunner) {
    log(
      `Session summary enrichment skipped: ${rows.length} dirty rows, no allowed runner`,
    );
    return { attempted: 0, updated: 0 };
  }

  const claimAttempt = db.prepare(
    `UPDATE session_summary_enrichments
     SET last_attempted_at_ms = ?
     WHERE session_summary_key = ?
       AND (? = 1 OR refresh_now = 1)
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
         refresh_now = 0,
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
    const finishAttempt = (error: string) => {
      const finishedAtMs = Date.now();
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
      finishAttempt("summary projection missing");
      continue;
    }

    const selection = selectSessionSummaryRunner({
      sessionTarget: context.target,
      stickyRunner: row.summary_runner,
      policy,
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
