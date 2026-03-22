import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const PRICING_PATH = path.join(config.dataDir, "pricing.json");
const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

interface ModelPricing {
  /** Cost per million input tokens */
  input: number;
  /** Cost per million output tokens */
  output: number;
  /** Cost per million cache-read tokens (0 if not available) */
  cache_read: number;
}

interface PricingCache {
  updated: string;
  models: Record<string, ModelPricing>;
}

/**
 * Fetch pricing from OpenRouter and save to disk.
 * Models are keyed by their base name (provider prefix stripped),
 * e.g. "claude-opus-4", "gemini-2.5-flash".
 */
export async function refreshPricing(): Promise<PricingCache | null> {
  try {
    const res = await fetch(OPENROUTER_URL);
    if (!res.ok) return null;

    const json = (await res.json()) as {
      data: {
        id: string;
        pricing: {
          prompt?: string;
          completion?: string;
          input_cache_read?: string;
        };
      }[];
    };

    const models: Record<string, ModelPricing> = {};
    for (const m of json.data) {
      const input = parseFloat(m.pricing?.prompt ?? "0") * 1_000_000;
      const output = parseFloat(m.pricing?.completion ?? "0") * 1_000_000;
      const cacheRead =
        parseFloat(m.pricing?.input_cache_read ?? "0") * 1_000_000;

      // Skip free/zero-cost models
      if (input === 0 && output === 0) continue;

      // Strip provider prefix: "anthropic/claude-opus-4" → "claude-opus-4"
      const baseId = m.id.includes("/") ? m.id.split("/")[1] : m.id;
      // Strip date suffixes: "claude-opus-4-20250514" — keep only if not already stored
      // (shorter/more general names take precedence to avoid duplication)
      if (!models[baseId]) {
        models[baseId] = { input, output, cache_read: cacheRead };
      }
    }

    const cache: PricingCache = {
      updated: new Date().toISOString(),
      models,
    };

    fs.mkdirSync(path.dirname(PRICING_PATH), { recursive: true });
    fs.writeFileSync(PRICING_PATH, `${JSON.stringify(cache, null, 2)}\n`);
    return cache;
  } catch {
    return null;
  }
}

function loadCache(): PricingCache | null {
  try {
    return JSON.parse(fs.readFileSync(PRICING_PATH, "utf-8"));
  } catch {
    return null;
  }
}

/** Refresh pricing if cache is missing or older than 24h. */
export async function refreshIfStale(): Promise<void> {
  const cache = loadCache();
  if (cache) {
    const age = Date.now() - new Date(cache.updated).getTime();
    if (age < STALE_MS) return;
  }
  await refreshPricing();
}

/**
 * Build a SQL CASE expression that computes cost from model name and token type.
 * Uses cached OpenRouter pricing, falls back to hardcoded defaults if unavailable.
 */
export function buildCostSQL(): string {
  const cache = loadCache();
  if (!cache || Object.keys(cache.models).length === 0) {
    return FALLBACK_COST_SQL;
  }

  // Sort by model name length descending so more specific patterns match first
  // (e.g. "gemini-2.5-flash-lite" before "gemini-2.5-flash")
  const entries = Object.entries(cache.models).sort(
    (a, b) => b[0].length - a[0].length,
  );

  const clauses: string[] = [];
  for (const [modelId, pricing] of entries) {
    // Build per-token-type pricing
    const parts: string[] = [];
    parts.push(`WHEN token_type = 'input' THEN ${pricing.input}`);
    parts.push(`WHEN token_type = 'output' THEN ${pricing.output}`);
    if (pricing.cache_read > 0) {
      parts.push(`WHEN token_type = 'cacheRead' THEN ${pricing.cache_read}`);
      // Estimate cache write at 1.25x input (common ratio)
      parts.push(`WHEN token_type = 'cacheWrite' THEN ${pricing.input * 1.25}`);
    }
    parts.push("ELSE 0");

    // Escape single quotes in model ID for SQL
    const escaped = modelId.replace(/'/g, "''");
    clauses.push(
      `WHEN model LIKE '${escaped}%' THEN tokens * (CASE ${parts.join(" ")} END) / 1000000.0`,
    );
  }

  clauses.push("ELSE 0");
  return `\n  CASE\n    ${clauses.join("\n    ")}\n  END`;
}

// Hardcoded fallback when no pricing cache is available
const FALLBACK_COST_SQL = `
  CASE
    WHEN model LIKE 'claude-opus%' THEN tokens * CASE WHEN token_type = 'input' THEN 15.0 WHEN token_type = 'output' THEN 75.0 WHEN token_type = 'cacheRead' THEN 1.5 WHEN token_type = 'cacheWrite' THEN 18.75 ELSE 0 END / 1000000.0
    WHEN model LIKE 'claude-sonnet%' OR model LIKE 'claude-3%sonnet%' THEN tokens * CASE WHEN token_type = 'input' THEN 3.0 WHEN token_type = 'output' THEN 15.0 WHEN token_type = 'cacheRead' THEN 0.3 WHEN token_type = 'cacheWrite' THEN 3.75 ELSE 0 END / 1000000.0
    WHEN model LIKE 'claude-haiku%' OR model LIKE 'claude-3%haiku%' THEN tokens * CASE WHEN token_type = 'input' THEN 0.80 WHEN token_type = 'output' THEN 4.0 WHEN token_type = 'cacheRead' THEN 0.08 WHEN token_type = 'cacheWrite' THEN 1.0 ELSE 0 END / 1000000.0
    WHEN model LIKE 'gemini%flash%lite%' THEN tokens * CASE WHEN token_type = 'input' THEN 0.075 WHEN token_type = 'output' THEN 0.3 ELSE 0 END / 1000000.0
    WHEN model LIKE 'gemini%flash%' THEN tokens * CASE WHEN token_type = 'input' THEN 0.075 WHEN token_type = 'output' THEN 0.3 ELSE 0 END / 1000000.0
    WHEN model LIKE 'gemini%pro%' THEN tokens * CASE WHEN token_type = 'input' THEN 1.25 WHEN token_type = 'output' THEN 5.0 ELSE 0 END / 1000000.0
    ELSE 0
  END`;
