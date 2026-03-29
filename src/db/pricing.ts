import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getDb } from "./schema.js";

const PRICING_PATH = path.join(config.dataDir, "pricing.json");
const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

interface ModelPricing {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

interface PricingCache {
  updated: string;
  models: Record<string, ModelPricing>;
}

/**
 * Hardcoded fallback pricing for common models (per million tokens).
 * Used when LiteLLM fetch fails or cache is empty.
 */
const FALLBACK_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6": {
    input: 5,
    output: 25,
    cache_read: 0.5,
    cache_write: 6.25,
  },
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cache_read: 0.3,
    cache_write: 3.75,
  },
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    cache_read: 0.1,
    cache_write: 1.25,
  },
};

interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  mode?: string;
}

/**
 * Fetch pricing from LiteLLM, save to disk cache, and upsert into SQLite.
 * Models are keyed by their LiteLLM ID (e.g. "claude-opus-4-6").
 */
export async function refreshPricing(): Promise<PricingCache | null> {
  try {
    const res = await fetch(LITELLM_URL);
    if (!res.ok) return null;

    const data = (await res.json()) as Record<string, LiteLLMEntry>;
    if (!data || typeof data !== "object") return null;

    const models: Record<string, ModelPricing> = {};
    for (const [modelId, entry] of Object.entries(data)) {
      if (!entry.input_cost_per_token || !entry.output_cost_per_token) continue;
      if (entry.mode && entry.mode !== "chat") continue;

      const input = entry.input_cost_per_token * 1_000_000;
      const output = entry.output_cost_per_token * 1_000_000;
      if (input === 0 && output === 0) continue;

      models[modelId] = {
        input,
        output,
        cache_read: entry.cache_read_input_token_cost
          ? entry.cache_read_input_token_cost * 1_000_000
          : 0,
        cache_write: entry.cache_creation_input_token_cost
          ? entry.cache_creation_input_token_cost * 1_000_000
          : 0,
      };
    }

    const cache: PricingCache = {
      updated: new Date().toISOString(),
      models,
    };

    // Save JSON cache for debugging/visibility
    fs.mkdirSync(path.dirname(PRICING_PATH), { recursive: true });
    fs.writeFileSync(PRICING_PATH, `${JSON.stringify(cache, null, 2)}\n`);

    // Upsert into SQLite
    upsertPricingTable(models);

    return cache;
  } catch {
    // On fetch failure, ensure fallbacks are in the DB
    ensureFallbacks();
    return null;
  }
}

function upsertPricingTable(models: Record<string, ModelPricing>): void {
  const db = getDb();
  const now = Date.now();
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO model_pricing
      (model_id, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, updated_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const [modelId, pricing] of Object.entries(models)) {
      upsert.run(
        modelId,
        pricing.input,
        pricing.output,
        pricing.cache_read,
        pricing.cache_write,
        now,
      );
    }
  });
  tx();
}

/**
 * Ensure fallback pricing exists in the DB for common models.
 * Called when LiteLLM fetch fails so cost queries still work.
 */
function ensureFallbacks(): void {
  try {
    upsertPricingTable(FALLBACK_PRICING);
  } catch {
    // Non-blocking
  }
}

/** Refresh pricing if cache is missing or older than 24h. */
export async function refreshIfStale(): Promise<void> {
  try {
    const cache: PricingCache | null = (() => {
      try {
        return JSON.parse(fs.readFileSync(PRICING_PATH, "utf-8"));
      } catch {
        return null;
      }
    })();
    if (cache) {
      const age = Date.now() - new Date(cache.updated).getTime();
      if (age < STALE_MS) return;
    }
    await refreshPricing();
  } catch {
    // Non-blocking — never fail the hook
  }
}

/**
 * SQL expression that computes cost for a row with (model, token_type, tokens) columns.
 * Looks up the best matching model in the model_pricing table by longest prefix match.
 */
export const COST_EXPR = `
  tokens * COALESCE((
    SELECT CASE token_type
      WHEN 'input' THEN mp.input_per_m
      WHEN 'output' THEN mp.output_per_m
      WHEN 'cacheRead' THEN mp.cache_read_per_m
      WHEN 'cacheWrite' THEN mp.cache_write_per_m
      ELSE 0
    END
    FROM model_pricing mp
    WHERE model LIKE mp.model_id || '%'
    ORDER BY LENGTH(mp.model_id) DESC
    LIMIT 1
  ), 0) / 1000000.0`;
