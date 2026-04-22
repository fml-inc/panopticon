import { createHash } from "node:crypto";
import type {
  ClaimPredicate,
  ClaimSourceType,
  ClaimValueKind,
  PredicateSpec,
} from "./types.js";

const PREDICATE_SPECS: Record<ClaimPredicate, PredicateSpec> = {
  "repository/name": {
    cardinality: "singleton",
    valueKind: "text",
    sourceRanks: { scanner: 100, hook: 50 },
  },
  "file/path": {
    cardinality: "singleton",
    valueKind: "text",
    sourceRanks: { scanner: 100, hook: 50 },
  },
  "file/in-repository": {
    cardinality: "singleton",
    valueKind: "text",
    sourceRanks: { scanner: 100, hook: 50 },
  },
  "intent/prompt-text": {
    cardinality: "singleton",
    valueKind: "text",
    sourceRanks: { scanner: 100, hook: 50 },
  },
  "intent/prompt-ts-ms": {
    cardinality: "singleton",
    valueKind: "num",
    sourceRanks: { hook: 100, scanner: 50 },
  },
  "intent/session": {
    cardinality: "singleton",
    valueKind: "text",
    sourceRanks: { scanner: 100, hook: 50 },
  },
  "intent/repository": {
    cardinality: "singleton",
    valueKind: "text",
    sourceRanks: { scanner: 100, hook: 50 },
  },
  "intent/in-repository": {
    cardinality: "singleton",
    valueKind: "text",
    sourceRanks: { scanner: 100, hook: 50 },
  },
  "intent/cwd": {
    cardinality: "singleton",
    valueKind: "text",
    sourceRanks: { hook: 100, scanner: 50 },
  },
  "intent/closed-at-ms": {
    cardinality: "singleton",
    valueKind: "num",
    sourceRanks: { hook: 100, scanner: 50 },
  },
  "edit/part-of-intent": {
    cardinality: "singleton",
    valueKind: "text",
    sourceRanks: { scanner: 100 },
  },
  "edit/file": {
    cardinality: "singleton",
    valueKind: "text",
    sourceRanks: { scanner: 100, hook: 50 },
  },
  "edit/touches-file": {
    cardinality: "singleton",
    valueKind: "text",
    sourceRanks: { scanner: 100, hook: 50 },
  },
  "edit/tool-name": {
    cardinality: "singleton",
    valueKind: "text",
    sourceRanks: { scanner: 100, hook: 50 },
  },
  "edit/multi-edit-index": {
    cardinality: "singleton",
    valueKind: "num",
    sourceRanks: { scanner: 100 },
  },
  "edit/new-string-hash": {
    cardinality: "singleton",
    valueKind: "text",
    sourceRanks: { scanner: 100, hook: 50 },
  },
  "edit/new-string-snippet": {
    cardinality: "singleton",
    valueKind: "text",
    sourceRanks: { scanner: 100, hook: 50 },
  },
  "edit/timestamp-ms": {
    cardinality: "singleton",
    valueKind: "num",
    sourceRanks: { hook: 100, scanner: 50 },
  },
  "edit/landed-status": {
    cardinality: "singleton",
    valueKind: "text",
    sourceRanks: { git_disk: 100 },
  },
  "edit/landed-reason": {
    cardinality: "singleton",
    valueKind: "text",
    sourceRanks: { git_disk: 100 },
  },
};

export function getPredicateSpec(predicate: ClaimPredicate): PredicateSpec {
  return PREDICATE_SPECS[predicate];
}

export function sourceRank(
  predicate: ClaimPredicate,
  sourceType: ClaimSourceType,
): number {
  return getPredicateSpec(predicate).sourceRanks[sourceType] ?? 0;
}

export function headKeyFor(
  predicate: ClaimPredicate,
  subject: string,
  _valueKind: ClaimValueKind,
  normalizedValue: string,
): string {
  const spec = getPredicateSpec(predicate);
  if (spec.cardinality === "set") {
    return `${predicate}:${subject}:${hashValue(normalizedValue)}`;
  }
  if (spec.cardinality === "timeline") {
    return `${predicate}:${subject}`;
  }
  return `${predicate}:${subject}`;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
