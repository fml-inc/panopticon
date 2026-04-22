export const INTENT_CLAIM_PREDICATES = [
  "repository/name",
  "file/path",
  "file/in-repository",
  "intent/prompt-text",
  "intent/prompt-ts-ms",
  "intent/session",
  "intent/repository",
  "intent/in-repository",
  "intent/cwd",
  "intent/closed-at-ms",
  "edit/part-of-intent",
  "edit/file",
  "edit/touches-file",
  "edit/tool-name",
  "edit/multi-edit-index",
  "edit/new-string-hash",
  "edit/new-string-snippet",
  "edit/timestamp-ms",
  "edit/landed-status",
  "edit/landed-reason",
] as const;

export type ClaimPredicate = (typeof INTENT_CLAIM_PREDICATES)[number];

export type ClaimSubjectKind = "intent" | "edit" | "repository" | "file";

export type ClaimValueKind = "text" | "num" | "json";

export type ClaimSourceType = "scanner" | "hook" | "git_disk";

export type ClaimCardinality = "singleton" | "set" | "timeline";

export type EvidenceRefKind =
  | "message"
  | "tool_call"
  | "scanner_turn"
  | "scanner_event"
  | "hook_event"
  | "otel_log"
  | "otel_metric"
  | "otel_span"
  | "git_commit"
  | "git_hunk"
  | "file_snapshot";

export interface EvidenceRefInput {
  kind: EvidenceRefKind;
  refKey: string;
  sessionId?: string | null;
  syncId?: string | null;
  repository?: string | null;
  filePath?: string | null;
  filePaths?: string[] | null;
  traceId?: string | null;
  spanId?: string | null;
  locator: Record<string, unknown>;
}

export interface ClaimEvidenceInput {
  ref: EvidenceRefInput;
  detail?: unknown;
  role?: "origin" | "supporting" | "refuting" | "context";
}

export interface AssertClaimInput {
  predicate: ClaimPredicate;
  subjectKind: ClaimSubjectKind;
  subject: string;
  value: unknown;
  observedAtMs: number;
  sourceType: ClaimSourceType;
  asserter: string;
  asserterVersion: number;
  confidence?: number;
  evidence?: ClaimEvidenceInput[];
  canonicalize?: boolean;
}

export interface EncodedClaimValue {
  valueKind: ClaimValueKind;
  valueText: string | null;
  valueNum: number | null;
  valueJson: string | null;
}

export interface PredicateSpec {
  cardinality: ClaimCardinality;
  valueKind: ClaimValueKind;
  sourceRanks: Partial<Record<ClaimSourceType, number>>;
}

export interface ClaimRow {
  id: number;
  observation_key: string;
  head_key: string;
  predicate: ClaimPredicate;
  subject_kind: ClaimSubjectKind;
  subject: string;
  value_kind: ClaimValueKind;
  value_text: string | null;
  value_num: number | null;
  value_json: string | null;
  source_type: ClaimSourceType;
  source_rank: number;
  confidence: number;
  observed_at_ms: number;
  asserted_at_ms: number;
  asserter: string;
  asserter_version: number;
}
