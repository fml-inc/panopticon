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
  if (args.uuid && args.uuid.length > 0) {
    return `intent:${args.uuid}`;
  }
  if (typeof args.userIndex === "number") {
    return `intent:${args.sessionId}:user:${args.userIndex}`;
  }
  return `intent:${args.sessionId}:${args.ordinal ?? 0}`;
}

export function editKey(args: {
  sessionId: string;
  assistantOrdinal: number;
  toolCallIndex: number;
  toolUseId?: string | null;
  multiEditIndex?: number;
  hookEventId?: number;
}): string {
  const suffix =
    args.multiEditIndex !== undefined ? `:${args.multiEditIndex}` : "";
  if (args.toolUseId && args.toolUseId.length > 0) {
    return `edit:${args.toolUseId}${suffix}`;
  }
  if (typeof args.hookEventId === "number") {
    return `edit:hook:${args.hookEventId}${suffix}`;
  }
  return `edit:${args.sessionId}:${args.assistantOrdinal}:${args.toolCallIndex}${suffix}`;
}

export function messageEvidenceKey(sessionId: string, ordinal: number): string {
  return `message:${sessionId}:${ordinal}`;
}

export function toolEvidenceKey(toolUseId: string): string {
  return `tool:${toolUseId}`;
}

export function toolLocalEvidenceKey(
  sessionId: string,
  messageOrdinal: number,
  toolCallIndex: number,
): string {
  return `tool_local:${sessionId}:${messageOrdinal}:${toolCallIndex}`;
}

export function hookEvidenceKey(id: number): string {
  return `hook:${id}`;
}

export function fileSnapshotEvidenceKey(
  filePath: string,
  content: string,
): string {
  return `fs_snapshot:${filePath}:${sha256Hex(content)}`;
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
