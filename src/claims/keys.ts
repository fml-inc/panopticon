import { createHash } from "node:crypto";
import { headKeyFor } from "./predicates.js";
import type {
  ClaimEvidenceInput,
  ClaimPredicate,
  ClaimValueKind,
  EncodedClaimValue,
} from "./types.js";

export function intentKey(args: {
  sessionId: string;
  ordinal?: number;
  userIndex?: number;
  uuid?: string | null;
}): string {
  // Prefer the prompt's session-local user index so hook ingest and scanner
  // rebuilds converge on the same subject even before message UUIDs exist.
  if (typeof args.userIndex === "number") {
    return `intent:${args.sessionId}:user:${args.userIndex}`;
  }
  if (args.uuid && args.uuid.length > 0) {
    return `intent:${args.uuid}`;
  }
  return `intent:${args.sessionId}:${args.ordinal ?? 0}`;
}

export function editKey(args: {
  intentKey?: string;
  sessionId?: string;
  assistantOrdinal?: number;
  toolCallIndex?: number;
  toolUseId?: string | null;
  multiEditIndex?: number;
  hookEventId?: number;
  semanticIdentity?: string;
  semanticOccurrence?: number;
}): string {
  const suffix =
    args.multiEditIndex !== undefined ? `:${args.multiEditIndex}` : "";
  if (args.toolUseId && args.toolUseId.length > 0) {
    return `edit:${args.toolUseId}${suffix}`;
  }
  if (args.intentKey && args.semanticIdentity) {
    return `edit:${args.intentKey}:sem:${sha256Hex(args.semanticIdentity)}:${args.semanticOccurrence ?? 0}${suffix}`;
  }
  if (args.intentKey && typeof args.toolCallIndex === "number") {
    return `edit:${args.intentKey}:tool:${args.toolCallIndex}${suffix}`;
  }
  if (typeof args.hookEventId === "number") {
    return `edit:hook:${args.hookEventId}${suffix}`;
  }
  return `edit:${args.sessionId ?? "unknown"}:${args.assistantOrdinal ?? 0}:${args.toolCallIndex ?? 0}${suffix}`;
}

export function messageEvidenceKey(sessionId: string, ordinal: number): string {
  return `message:${sessionId}:${ordinal}`;
}

export function messageSyncEvidenceKey(syncId: string): string {
  return `msg:${syncId}`;
}

export function toolEvidenceKey(toolUseId: string): string {
  return `tool:${toolUseId}`;
}

export function toolCallSyncEvidenceKey(syncId: string): string {
  return `tc:${syncId}`;
}

export function toolLocalEvidenceKey(
  sessionId: string,
  messageOrdinal: number,
  toolCallIndex: number,
): string {
  return `tool_local:${sessionId}:${messageOrdinal}:${toolCallIndex}`;
}

export function semanticEditIdentity(args: {
  filePath: string;
  newString: string;
  oldStrings: string[];
  deletedFile: boolean;
}): string {
  return [
    args.filePath,
    args.deletedFile ? "1" : "0",
    sha256Hex(args.newString),
    sha256Hex(args.oldStrings.join("\u0000")),
  ].join("|");
}

export function hookEvidenceKey(id: number): string {
  return `hook:${id}`;
}

export function hookEventSyncEvidenceKey(syncId: string): string {
  return `hook_event:${syncId}`;
}

export function fileSnapshotEvidenceKey(
  filePath: string,
  content: string,
): string {
  return `file_snapshot:${filePath}:${sha256Hex(content)}`;
}

export function encodeClaimValue(value: unknown): EncodedClaimValue {
  if (typeof value === "number" && Number.isFinite(value)) {
    return {
      valueKind: "num",
      valueText: null,
      valueNum: value,
      valueJson: null,
    };
  }
  if (typeof value === "string") {
    return {
      valueKind: "text",
      valueText: value,
      valueNum: null,
      valueJson: null,
    };
  }
  return {
    valueKind: "json",
    valueText: null,
    valueNum: null,
    valueJson: stableStringify(value),
  };
}

export function normalizedValueForKey(
  valueKind: ClaimValueKind,
  encoded: EncodedClaimValue,
): string {
  if (valueKind === "num") return String(encoded.valueNum ?? "");
  if (valueKind === "json") return encoded.valueJson ?? "";
  return encoded.valueText ?? "";
}

export function claimHeadKey(
  predicate: ClaimPredicate,
  subject: string,
  valueKind: ClaimValueKind,
  normalizedValue: string,
): string {
  return headKeyFor(predicate, subject, valueKind, normalizedValue);
}

export function observationKey(args: {
  predicate: ClaimPredicate;
  subject: string;
  normalizedValue: string;
  evidence: ClaimEvidenceInput[];
  sourceType: string;
  asserter: string;
  asserterVersion: string;
  observedAtMs: number;
}): string {
  const evidenceFingerprint = args.evidence
    .map((item) => item.key)
    .sort()
    .join("|");
  return `obs:${sha256Hex(
    [
      args.predicate,
      args.subject,
      args.normalizedValue,
      evidenceFingerprint,
      args.sourceType,
      args.asserter,
      args.asserterVersion,
      String(args.observedAtMs),
    ].join("|"),
  )}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortValue(v)]),
    );
  }
  return value;
}
