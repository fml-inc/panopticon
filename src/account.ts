import fs from "node:fs";
import { config } from "./config.js";

/**
 * Account types that determine how session costs should be interpreted.
 *
 * - "api": Direct API billing — costs are real charges.
 * - "pro", "max", "team", "enterprise": Subscription plans — token usage
 *   is covered by the subscription, so reported costs represent the
 *   *equivalent* API cost, not an actual charge.
 * - "unknown": Could not determine account type.
 */
export type AccountType =
  | "api"
  | "pro"
  | "max"
  | "team"
  | "enterprise"
  | "unknown";

export const SUBSCRIPTION_TYPES: ReadonlySet<string> = new Set([
  "pro",
  "max",
  "team",
  "enterprise",
]);

export function isSubscription(accountType: string): boolean {
  return SUBSCRIPTION_TYPES.has(accountType);
}

/** Fields in hook payloads or OTel resource attributes that hint at account type. */
const ACCOUNT_TYPE_KEYS = [
  "account_type",
  "accountType",
  "account.type",
  "subscription_type",
  "subscriptionType",
  "subscription.type",
  "plan",
  "plan_type",
  "planType",
  "billing_type",
  "billingType",
];

const PLAN_KEYS = [
  "subscription_plan",
  "subscriptionPlan",
  "subscription.plan",
  "account_plan",
  "accountPlan",
  "account.plan",
];

/** Normalise raw value strings into a canonical AccountType. */
function normalizeAccountType(raw: string): AccountType {
  const v = raw.toLowerCase().trim();
  if (v === "api" || v === "direct" || v === "api_key" || v === "apikey")
    return "api";
  if (v === "pro" || v === "claude_pro" || v === "pro_plan") return "pro";
  if (
    v === "max" ||
    v === "claude_max" ||
    v === "max_plan" ||
    v === "max5" ||
    v === "max20"
  )
    return "max";
  if (v === "team" || v === "teams" || v === "claude_team") return "team";
  if (v === "enterprise" || v === "claude_enterprise") return "enterprise";
  // Check if the value contains a known type as a substring
  if (v.includes("enterprise")) return "enterprise";
  if (v.includes("team")) return "team";
  if (v.includes("max")) return "max";
  if (v.includes("pro")) return "pro";
  if (v.includes("api")) return "api";
  return "unknown";
}

/**
 * Try to detect account type from a flat key-value map (hook payload fields
 * or OTel resource/record attributes).
 */
export function detectAccountTypeFromAttributes(
  attrs: Record<string, unknown> | undefined,
): AccountType | null {
  if (!attrs) return null;

  // Check direct account-type fields
  for (const key of ACCOUNT_TYPE_KEYS) {
    const val = attrs[key];
    if (typeof val === "string" && val.length > 0) {
      return normalizeAccountType(val);
    }
  }

  // Check plan fields
  for (const key of PLAN_KEYS) {
    const val = attrs[key];
    if (typeof val === "string" && val.length > 0) {
      return normalizeAccountType(val);
    }
  }

  return null;
}

/**
 * Read account type override from the panopticon config file.
 * Users can set `"accountType": "pro"` (or max, team, api, etc.) in
 * ~/.local/share/panopticon/account.json
 */
export function readAccountTypeConfig(): AccountType | null {
  try {
    const raw = fs.readFileSync(config.accountConfigFile, "utf-8");
    const cfg = JSON.parse(raw);
    if (typeof cfg.accountType === "string" && cfg.accountType.length > 0) {
      return normalizeAccountType(cfg.accountType);
    }
  } catch {
    // File doesn't exist or is invalid — that's fine
  }
  return null;
}

/**
 * Detect account type for a session, checking multiple sources in priority order:
 * 1. Hook payload fields (most specific per-session data)
 * 2. OTel resource attributes
 * 3. User config file override
 * 4. Falls back to "unknown"
 */
export function detectAccountType(sources: {
  hookPayload?: Record<string, unknown>;
  resourceAttributes?: Record<string, unknown>;
}): { accountType: AccountType; detectedFrom: string } {
  // 1. Hook payload
  const fromPayload = detectAccountTypeFromAttributes(sources.hookPayload);
  if (fromPayload && fromPayload !== "unknown") {
    return { accountType: fromPayload, detectedFrom: "hook_payload" };
  }

  // 2. OTel resource attributes
  const fromResource = detectAccountTypeFromAttributes(
    sources.resourceAttributes,
  );
  if (fromResource && fromResource !== "unknown") {
    return { accountType: fromResource, detectedFrom: "resource_attributes" };
  }

  // 3. Config file
  const fromConfig = readAccountTypeConfig();
  if (fromConfig && fromConfig !== "unknown") {
    return { accountType: fromConfig, detectedFrom: "config" };
  }

  return { accountType: "unknown", detectedFrom: "none" };
}
