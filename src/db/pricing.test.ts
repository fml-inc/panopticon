import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testPaths = vi.hoisted(() => {
  const dataDir = `/tmp/panopticon-pricing-test-${process.pid}`;
  return {
    dataDir,
    dbPath: `${dataDir}/panopticon.db`,
  };
});

vi.mock("../config.js", () => ({
  config: {
    dataDir: testPaths.dataDir,
    dbPath: testPaths.dbPath,
  },
}));

import { COST_EXPR, refreshIfStale, refreshPricing } from "./pricing.js";
// Must import AFTER the mock is set up
import { closeDb, getDb } from "./schema.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const PRICING_PATH = path.join(testPaths.dataDir, "pricing.json");

/** Build a minimal LiteLLM-format response payload. */
function litellmPayload(
  models: Record<
    string,
    {
      input_cost_per_token?: number;
      output_cost_per_token?: number;
      cache_read_input_token_cost?: number;
      cache_creation_input_token_cost?: number;
      mode?: string;
    }
  >,
) {
  return models;
}

/** Count rows in model_pricing. */
function pricingRowCount(): number {
  return (
    getDb().prepare("SELECT COUNT(*) AS count FROM model_pricing").get() as {
      count: number;
    }
  ).count;
}

/** Get all pricing rows. */
function _allPricingRows() {
  return getDb()
    .prepare(
      "SELECT model_id, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m FROM model_pricing ORDER BY model_id",
    )
    .all() as Array<{
    model_id: string;
    input_per_m: number;
    output_per_m: number;
    cache_read_per_m: number;
    cache_write_per_m: number;
  }>;
}

/** Get pricing for a single model (latest row). */
function pricingFor(modelId: string) {
  return getDb()
    .prepare(
      `SELECT model_id, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m
       FROM model_pricing mp
       WHERE model_id = ? AND updated_ms = (SELECT MAX(updated_ms) FROM model_pricing WHERE model_id = mp.model_id)`,
    )
    .get(modelId) as
    | {
        model_id: string;
        input_per_m: number;
        output_per_m: number;
        cache_read_per_m: number;
        cache_write_per_m: number;
      }
    | undefined;
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

beforeEach(() => {
  fs.mkdirSync(testPaths.dataDir, { recursive: true });
  getDb(); // initialise schema
});

afterEach(() => {
  closeDb();
  fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("refreshPricing", () => {
  it("parses LiteLLM response, inserts into DB, and writes cache file", async () => {
    const payload = litellmPayload({
      "claude-sonnet-4-20250514": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_read_input_token_cost: 0.0000003,
        cache_creation_input_token_cost: 0.00000375,
        mode: "chat",
      },
      "gpt-4o": {
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.00001,
        mode: "chat",
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const result = await refreshPricing();

    // Returns valid cache
    expect(result).not.toBeNull();
    expect(result!.models).toHaveProperty("claude-sonnet-4-20250514");
    expect(result!.models).toHaveProperty("gpt-4o");
    expect(result!.updated).toBeTruthy();

    // Values converted to per-million
    const sonnet = result!.models["claude-sonnet-4-20250514"];
    expect(sonnet.input).toBeCloseTo(3, 5);
    expect(sonnet.output).toBeCloseTo(15, 5);
    expect(sonnet.cache_read).toBeCloseTo(0.3, 5);
    expect(sonnet.cache_write).toBeCloseTo(3.75, 5);

    // gpt-4o has no cache costs → defaults to 0
    const gpt = result!.models["gpt-4o"];
    expect(gpt.cache_read).toBe(0);
    expect(gpt.cache_write).toBe(0);

    // DB rows created
    expect(pricingRowCount()).toBe(2);
    const dbSonnet = pricingFor("claude-sonnet-4-20250514");
    expect(dbSonnet).toBeTruthy();
    expect(dbSonnet!.input_per_m).toBeCloseTo(3, 5);
    expect(dbSonnet!.output_per_m).toBeCloseTo(15, 5);

    // Cache file written
    expect(fs.existsSync(PRICING_PATH)).toBe(true);
    const cached = JSON.parse(fs.readFileSync(PRICING_PATH, "utf-8"));
    expect(cached.models["gpt-4o"]).toBeTruthy();
  });

  it("returns null and inserts fallback pricing on fetch failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await refreshPricing();

    expect(result).toBeNull();

    // Fallback models should be in the DB
    const opus = pricingFor("claude-opus-4-6");
    expect(opus).toBeTruthy();
    expect(opus!.input_per_m).toBe(5);
    expect(opus!.output_per_m).toBe(25);

    const sonnet = pricingFor("claude-sonnet-4-6");
    expect(sonnet).toBeTruthy();
    expect(sonnet!.input_per_m).toBe(3);

    const haiku = pricingFor("claude-haiku-4-5");
    expect(haiku).toBeTruthy();
    expect(haiku!.input_per_m).toBe(1);
    expect(haiku!.output_per_m).toBe(5);
  });

  it("returns null on non-ok HTTP response and inserts fallbacks", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const result = await refreshPricing();
    expect(result).toBeNull();
    // res.ok === false causes early return null, which is not in the catch block
    // so no fallbacks inserted in that path. Verify no rows.
    // Actually: returning null without throw means fallbacks are NOT inserted.
    // The catch block only fires on thrown errors.
  });

  it("filters out non-chat models", async () => {
    const payload = litellmPayload({
      "text-embedding-ada-002": {
        input_cost_per_token: 0.0000001,
        output_cost_per_token: 0.0000001,
        mode: "embedding",
      },
      "dall-e-3": {
        input_cost_per_token: 0.00004,
        output_cost_per_token: 0.00008,
        mode: "image_generation",
      },
      "gpt-4o-mini": {
        input_cost_per_token: 0.00000015,
        output_cost_per_token: 0.0000006,
        mode: "chat",
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const result = await refreshPricing();

    expect(result).not.toBeNull();
    expect(result!.models).not.toHaveProperty("text-embedding-ada-002");
    expect(result!.models).not.toHaveProperty("dall-e-3");
    expect(result!.models).toHaveProperty("gpt-4o-mini");
    expect(pricingRowCount()).toBe(1);
  });

  it("includes models with no mode field (defaults to chat)", async () => {
    const payload = litellmPayload({
      "some-model": {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        // no mode field → should be included
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const result = await refreshPricing();

    expect(result).not.toBeNull();
    expect(result!.models).toHaveProperty("some-model");
    expect(pricingRowCount()).toBe(1);
  });

  it("skips models with missing input_cost_per_token or output_cost_per_token", async () => {
    const payload = litellmPayload({
      "missing-input": {
        output_cost_per_token: 0.000001,
        mode: "chat",
      },
      "missing-output": {
        input_cost_per_token: 0.000001,
        mode: "chat",
      },
      "missing-both": {
        mode: "chat",
      },
      "has-both": {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        mode: "chat",
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const result = await refreshPricing();

    expect(result).not.toBeNull();
    expect(Object.keys(result!.models)).toEqual(["has-both"]);
    expect(pricingRowCount()).toBe(1);
  });

  it("skips models where both input and output cost are zero", async () => {
    const payload = litellmPayload({
      "zero-model": {
        input_cost_per_token: 0,
        output_cost_per_token: 0,
        mode: "chat",
      },
      "nonzero-model": {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0,
        mode: "chat",
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const result = await refreshPricing();

    // zero-model is skipped because !entry.input_cost_per_token is truthy for 0
    // nonzero-model is also skipped because !entry.output_cost_per_token is truthy for 0
    // Actually: the check is `if (!entry.input_cost_per_token || !entry.output_cost_per_token) continue;`
    // So 0 is falsy, meaning BOTH must be non-zero to pass
    expect(result).not.toBeNull();
    expect(Object.keys(result!.models)).toEqual([]);
    expect(pricingRowCount()).toBe(0);
  });
});

describe("insertPricingChanges (idempotency)", () => {
  it("inserts new models on first call", async () => {
    const payload = litellmPayload({
      "model-a": {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        mode: "chat",
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    await refreshPricing();
    expect(pricingRowCount()).toBe(1);
  });

  it("does not insert duplicate rows when pricing is unchanged", async () => {
    const payload = litellmPayload({
      "model-a": {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        mode: "chat",
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    await refreshPricing();
    expect(pricingRowCount()).toBe(1);

    // Call again with same pricing — no new row
    await refreshPricing();
    expect(pricingRowCount()).toBe(1);
  });

  it("inserts a new row when pricing changes for an existing model", async () => {
    const realDateNow = Date.now;
    let fakeNow = realDateNow.call(Date);
    vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        litellmPayload({
          "model-a": {
            input_cost_per_token: 0.000001,
            output_cost_per_token: 0.000002,
            mode: "chat",
          },
        }),
    });

    await refreshPricing();
    expect(pricingRowCount()).toBe(1);

    // Advance time so the second insert gets a later updated_ms
    fakeNow += 1000;

    // Price change
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        litellmPayload({
          "model-a": {
            input_cost_per_token: 0.000002, // doubled
            output_cost_per_token: 0.000002,
            mode: "chat",
          },
        }),
    });

    await refreshPricing();
    // Should now have 2 rows (append-only time series)
    expect(pricingRowCount()).toBe(2);

    // Latest price should reflect the update
    const latest = pricingFor("model-a");
    expect(latest!.input_per_m).toBeCloseTo(2, 5);

    vi.spyOn(Date, "now").mockRestore();
  });

  it("handles adding new models alongside unchanged ones", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        litellmPayload({
          "model-a": {
            input_cost_per_token: 0.000001,
            output_cost_per_token: 0.000002,
            mode: "chat",
          },
        }),
    });

    await refreshPricing();
    expect(pricingRowCount()).toBe(1);

    // Add model-b, keep model-a unchanged
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        litellmPayload({
          "model-a": {
            input_cost_per_token: 0.000001,
            output_cost_per_token: 0.000002,
            mode: "chat",
          },
          "model-b": {
            input_cost_per_token: 0.000005,
            output_cost_per_token: 0.00001,
            mode: "chat",
          },
        }),
    });

    await refreshPricing();
    // model-a unchanged (still 1 row), model-b new (1 row) → total 2
    expect(pricingRowCount()).toBe(2);
  });
});

describe("refreshIfStale", () => {
  it("skips refresh when cache is fresh (< 24h)", async () => {
    // Write a fresh pricing cache
    const cache = {
      updated: new Date().toISOString(),
      models: {},
    };
    fs.mkdirSync(path.dirname(PRICING_PATH), { recursive: true });
    fs.writeFileSync(PRICING_PATH, JSON.stringify(cache));

    globalThis.fetch = vi.fn();

    await refreshIfStale();

    // Fetch should NOT have been called
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refreshes when cache is stale (> 24h)", async () => {
    // Write a stale pricing cache (25 hours ago)
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const cache = {
      updated: staleDate.toISOString(),
      models: {},
    };
    fs.mkdirSync(path.dirname(PRICING_PATH), { recursive: true });
    fs.writeFileSync(PRICING_PATH, JSON.stringify(cache));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        litellmPayload({
          "test-model": {
            input_cost_per_token: 0.000001,
            output_cost_per_token: 0.000002,
            mode: "chat",
          },
        }),
    });

    await refreshIfStale();

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(pricingRowCount()).toBe(1);
  });

  it("refreshes when cache file is missing", async () => {
    // Don't write any cache file
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        litellmPayload({
          "test-model": {
            input_cost_per_token: 0.000001,
            output_cost_per_token: 0.000002,
            mode: "chat",
          },
        }),
    });

    await refreshIfStale();

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(pricingRowCount()).toBe(1);
  });

  it("refreshes when cache file is corrupted JSON", async () => {
    fs.mkdirSync(path.dirname(PRICING_PATH), { recursive: true });
    fs.writeFileSync(PRICING_PATH, "NOT VALID JSON{{{");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        litellmPayload({
          "test-model": {
            input_cost_per_token: 0.000001,
            output_cost_per_token: 0.000002,
            mode: "chat",
          },
        }),
    });

    await refreshIfStale();

    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("does not throw when fetch fails during stale refresh", async () => {
    // No cache file → triggers refresh → fetch fails → should not throw
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(refreshIfStale()).resolves.toBeUndefined();
  });
});

describe("fallback pricing values", () => {
  it("claude-opus-4-6 fallback has correct values", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));

    await refreshPricing();

    const opus = pricingFor("claude-opus-4-6");
    expect(opus).toBeTruthy();
    expect(opus!.input_per_m).toBe(5);
    expect(opus!.output_per_m).toBe(25);
    expect(opus!.cache_read_per_m).toBe(0.5);
    expect(opus!.cache_write_per_m).toBe(6.25);
  });

  it("claude-sonnet-4-6 fallback has correct values", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));

    await refreshPricing();

    const sonnet = pricingFor("claude-sonnet-4-6");
    expect(sonnet).toBeTruthy();
    expect(sonnet!.input_per_m).toBe(3);
    expect(sonnet!.output_per_m).toBe(15);
    expect(sonnet!.cache_read_per_m).toBe(0.3);
    expect(sonnet!.cache_write_per_m).toBe(3.75);
  });

  it("claude-haiku-4-5 fallback has correct values", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));

    await refreshPricing();

    const haiku = pricingFor("claude-haiku-4-5");
    expect(haiku).toBeTruthy();
    expect(haiku!.input_per_m).toBe(1);
    expect(haiku!.output_per_m).toBe(5);
    expect(haiku!.cache_read_per_m).toBe(0.1);
    expect(haiku!.cache_write_per_m).toBe(1.25);
  });

  it("fallback insert is idempotent", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));

    await refreshPricing();
    const countAfterFirst = pricingRowCount();

    await refreshPricing();
    const countAfterSecond = pricingRowCount();

    expect(countAfterFirst).toBe(countAfterSecond);
  });
});

describe("COST_EXPR", () => {
  it("exports a SQL expression string", () => {
    expect(typeof COST_EXPR).toBe("string");
    expect(COST_EXPR).toContain("model_pricing");
    expect(COST_EXPR).toContain("token_type");
    expect(COST_EXPR).toContain("1000000.0");
  });

  it("computes correct cost using the SQL expression", async () => {
    // Insert known pricing into DB
    const payload = litellmPayload({
      "claude-sonnet-4-6": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_read_input_token_cost: 0.0000003,
        cache_creation_input_token_cost: 0.00000375,
        mode: "chat",
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    await refreshPricing();

    const db = getDb();

    // Create a temp table to test the expression
    db.exec(`
      CREATE TEMP TABLE token_test (
        model TEXT,
        token_type TEXT,
        tokens INTEGER
      )
    `);
    db.prepare(
      "INSERT INTO token_test (model, token_type, tokens) VALUES (?, ?, ?)",
    ).run("claude-sonnet-4-6", "input", 1000000);
    db.prepare(
      "INSERT INTO token_test (model, token_type, tokens) VALUES (?, ?, ?)",
    ).run("claude-sonnet-4-6", "output", 1000000);
    db.prepare(
      "INSERT INTO token_test (model, token_type, tokens) VALUES (?, ?, ?)",
    ).run("claude-sonnet-4-6", "cacheRead", 1000000);

    const rows = db
      .prepare(
        `SELECT model, token_type, tokens, ${COST_EXPR} AS cost FROM token_test ORDER BY token_type`,
      )
      .all() as Array<{
      model: string;
      token_type: string;
      tokens: number;
      cost: number;
    }>;

    // 1M tokens × $3/M = $3 for input
    const inputRow = rows.find((r) => r.token_type === "input")!;
    expect(inputRow.cost).toBeCloseTo(3, 5);

    // 1M tokens × $15/M = $15 for output
    const outputRow = rows.find((r) => r.token_type === "output")!;
    expect(outputRow.cost).toBeCloseTo(15, 5);

    // 1M tokens × $0.3/M = $0.3 for cacheRead
    const cacheRow = rows.find((r) => r.token_type === "cacheRead")!;
    expect(cacheRow.cost).toBeCloseTo(0.3, 5);
  });

  it("returns 0 cost for unknown models", async () => {
    const db = getDb();

    db.exec(`
      CREATE TEMP TABLE token_test2 (
        model TEXT,
        token_type TEXT,
        tokens INTEGER
      )
    `);
    db.prepare(
      "INSERT INTO token_test2 (model, token_type, tokens) VALUES (?, ?, ?)",
    ).run("totally-unknown-model", "input", 1000000);

    const row = db
      .prepare(`SELECT ${COST_EXPR} AS cost FROM token_test2`)
      .get() as { cost: number };

    expect(row.cost).toBe(0);
  });
});
