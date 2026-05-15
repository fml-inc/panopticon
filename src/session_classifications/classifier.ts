export type SessionClassification = "interactive" | "automated";

export interface SessionClassificationSignals {
  target: string | null;
  firstPrompt: string | null;
  model: string | null;
  models: string | null;
  userMessageCount: number;
  parentSessionId: string | null;
  relationshipType: string | null;
}

export interface SessionClassificationResult {
  classification: SessionClassification;
  reason: string;
}

const INTERACTIVE_TARGETS = new Set(["claude", "codex"]);
const AUTOMATED_MODELS = new Set(["codex-auto-review"]);

const AUTOMATED_PROMPT_PREFIXES = [
  {
    prefix:
      "The following is the Codex agent history whose request action you are assessing.",
    reason: "codex approval-review prompt",
  },
  {
    prefix:
      "The following is the Codex agent history added since your last approval assessment.",
    reason: "codex approval-review continuation prompt",
  },
  { prefix: "You are a code reviewer.", reason: "code reviewer prompt" },
  {
    prefix: "You are a security code reviewer.",
    reason: "security reviewer prompt",
  },
  { prefix: "You are a design reviewer.", reason: "design reviewer prompt" },
  {
    prefix: "You are a code assistant. Your task is to address",
    reason: "automated fix prompt",
  },
  {
    prefix: "You are a code review insights analyst.",
    reason: "review insights prompt",
  },
  {
    prefix: "You are reviewing whether an implementation matches",
    reason: "implementation review prompt",
  },
  {
    prefix: "You are a plan document reviewer.",
    reason: "plan reviewer prompt",
  },
  {
    prefix: "You are a spec document reviewer.",
    reason: "spec reviewer prompt",
  },
  {
    prefix: "You are summarizing a day of AI agent activity.",
    reason: "activity summary prompt",
  },
  {
    prefix: "You are analyzing AI agent sessions.",
    reason: "session analysis prompt",
  },
  { prefix: "## Analysis Request", reason: "analysis request prompt" },
  { prefix: "# Fix Request", reason: "fix request prompt" },
];

const AUTOMATED_PROMPT_SUBSTRINGS = [
  {
    substring: "invoked by roborev to perform this review",
    reason: "roborev marker",
  },
];

export function classifySession(
  signals: SessionClassificationSignals,
): SessionClassificationResult | null {
  const automationReason = definiteAutomationReason(signals);
  if (automationReason) {
    return { classification: "automated", reason: automationReason };
  }

  if (
    signals.parentSessionId === null &&
    normalizedRelationshipType(signals.relationshipType) !== "subagent" &&
    signals.firstPrompt !== null &&
    signals.firstPrompt.trim().length > 0 &&
    signals.userMessageCount > 0 &&
    signals.target !== null &&
    INTERACTIVE_TARGETS.has(signals.target)
  ) {
    return {
      classification: "interactive",
      reason: `top-level ${signals.target} session with user messages and no deterministic automation markers`,
    };
  }

  return null;
}

function definiteAutomationReason(
  signals: SessionClassificationSignals,
): string | null {
  if (normalizedRelationshipType(signals.relationshipType) === "subagent") {
    return "relationship_type=subagent";
  }

  const automatedModel = findAutomatedModel(signals);
  if (automatedModel) {
    return `model=${automatedModel}`;
  }

  const firstPrompt = signals.firstPrompt ?? "";
  for (const { prefix, reason } of AUTOMATED_PROMPT_PREFIXES) {
    if (firstPrompt.startsWith(prefix)) {
      return reason;
    }
  }
  for (const { substring, reason } of AUTOMATED_PROMPT_SUBSTRINGS) {
    if (firstPrompt.includes(substring)) {
      return reason;
    }
  }

  return null;
}

function findAutomatedModel(
  signals: SessionClassificationSignals,
): string | null {
  const models = new Set<string>();
  for (const value of [signals.model, signals.models]) {
    for (const model of splitModels(value)) {
      models.add(model);
    }
  }
  for (const model of models) {
    if (AUTOMATED_MODELS.has(model)) return model;
  }
  return null;
}

function splitModels(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function normalizedRelationshipType(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}
