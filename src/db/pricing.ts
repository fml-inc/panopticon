import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getDb } from "./schema.js";

const PRICING_PATH = path.join(config.dataDir, "pricing.json");
const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

interface ModelPricing {
  input: number;
  output: number;
  cache_read: number;
}

interface PricingCache {
  updated: string;
  models: Record<string, ModelPricing>;
}

/**
 * Fetch pricing from OpenRouter, save to disk cache, and upsert into SQLite.
 * Models are keyed by their base name (provider prefix stripped).
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

      if (input === 0 && output === 0) continue;

      // Strip provider prefix: "anthropic/claude-opus-4" → "claude-opus-4"
      const baseId = m.id.includes("/") ? m.id.split("/")[1] : m.id;
      if (!models[baseId]) {
        models[baseId] = { input, output, cache_read: cacheRead };
      }
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
        pricing.input * 1.25, // estimate cache write at 1.25x input
        now,
      );
    }
  });
  tx();
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
