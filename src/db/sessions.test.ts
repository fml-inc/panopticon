import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Mock config to use a temp directory
vi.mock("../config.js", () => {
  const _os = require("node:os");
  const _path = require("node:path");
  const _fs = require("node:fs");
  const tmpDir = _path.join(_os.tmpdir(), "pano-sessions-test");
  _fs.mkdirSync(tmpDir, { recursive: true });
  return {
    config: {
      dataDir: tmpDir,
      dbPath: _path.join(tmpDir, "data.db"),
      port: 4318,
      host: "127.0.0.1",
      serverPidFile: _path.join(tmpDir, "panopticon.pid"),
    },
    ensureDataDir: () => _fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import { closeDb, getDb } from "./schema.js";
import { upsertSession } from "./store.js";

function getSession(sessionId: string) {
  const db = getDb();
  return db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as Record<string, unknown> | undefined;
}

function clearSessions() {
  const db = getDb();
  db.prepare("DELETE FROM sessions").run();
}

beforeAll(() => {
  getDb(); // ensure schema + migrations
});

beforeEach(() => {
  clearSessions();
});

afterAll(() => {
  closeDb();
});

// ── Hooks only ──────────────────────────────────────────────────────────────

describe("hooks only", () => {
  it("claude: creates session from SessionStart hook", () => {
    upsertSession({
      session_id: "claude-hook-1",
      target: "claude",
      started_at_ms: 1700000000000,
      permission_mode: "default",
      agent_version: "2.1.84",
    });
    const s = getSession("claude-hook-1")!;
    expect(s.target).toBe("claude");
    expect(s.started_at_ms).toBe(1700000000000);
    expect(s.permission_mode).toBe("default");
    expect(s.agent_version).toBe("2.1.84");
    // Scanner fields should be null (not yet populated)
    expect(s.model).toBeNull();
    expect(s.cli_version).toBeNull();
    expect(s.scanner_file_path).toBeNull();
    expect(s.total_input_tokens).toBeNull();
    expect(s.turn_count).toBeNull();
  });

  it("claude: UserPromptSubmit adds first_prompt", () => {
    upsertSession({
      session_id: "claude-hook-2",
      target: "claude",
      started_at_ms: 1700000000000,
    });
    upsertSession({
      session_id: "claude-hook-2",
      first_prompt: "Write a fibonacci function",
    });
    const s = getSession("claude-hook-2")!;
    expect(s.first_prompt).toBe("Write a fibonacci function");
    expect(s.started_at_ms).toBe(1700000000000); // preserved
  });

  it("claude: Stop adds ended_at_ms without overwriting other fields", () => {
    upsertSession({
      session_id: "claude-hook-3",
      target: "claude",
      started_at_ms: 1700000000000,
    });
    upsertSession({ session_id: "claude-hook-3", ended_at_ms: 1700000060000 });
    const s = getSession("claude-hook-3")!;
    expect(s.started_at_ms).toBe(1700000000000);
    expect(s.ended_at_ms).toBe(1700000060000);
  });

  it("codex: creates session with target=codex", () => {
    upsertSession({
      session_id: "codex-hook-1",
      target: "codex",
      started_at_ms: 1700000000000,
    });
    const s = getSession("codex-hook-1")!;
    expect(s.target).toBe("codex");
  });

  it("gemini: creates session with target=gemini", () => {
    upsertSession({
      session_id: "gemini-hook-1",
      target: "gemini",
      started_at_ms: 1700000000000,
    });
    const s = getSession("gemini-hook-1")!;
    expect(s.target).toBe("gemini");
  });

  it("first_prompt is not overwritten by subsequent upserts", () => {
    upsertSession({ session_id: "prompt-test", first_prompt: "first" });
    upsertSession({ session_id: "prompt-test", first_prompt: "second" });
    const s = getSession("prompt-test")!;
    expect(s.first_prompt).toBe("first"); // COALESCE(sessions.first_prompt, excluded.first_prompt)
  });
});

// ── Scanner only ────────────────────────────────────────────────────────────

describe("scanner only", () => {
  it("claude: creates session with model and token data", () => {
    upsertSession({
      session_id: "claude-scan-1",
      target: "claude",
      model: "claude-opus-4-6",
      cli_version: "2.1.84",
      first_prompt: "Write tests",
      scanner_file_path: "/home/user/.claude/projects/proj/abc.jsonl",
      started_at_ms: 1700000000000,
      total_input_tokens: 500,
      total_output_tokens: 2000,
      total_cache_read_tokens: 15000,
      total_cache_creation_tokens: 800,
      turn_count: 10,
    });
    const s = getSession("claude-scan-1")!;
    expect(s.target).toBe("claude");
    expect(s.model).toBe("claude-opus-4-6");
    expect(s.cli_version).toBe("2.1.84");
    expect(s.scanner_file_path).toBe(
      "/home/user/.claude/projects/proj/abc.jsonl",
    );
    expect(s.total_input_tokens).toBe(500);
    expect(s.total_output_tokens).toBe(2000);
    expect(s.total_cache_read_tokens).toBe(15000);
    expect(s.total_cache_creation_tokens).toBe(800);
    expect(s.turn_count).toBe(10);
    // Hook fields should be null
    expect(s.permission_mode).toBeNull();
    expect(s.agent_version).toBeNull();
    expect(s.ended_at_ms).toBeNull();
  });

  it("codex: creates session with reasoning tokens", () => {
    upsertSession({
      session_id: "codex-scan-1",
      target: "codex",
      model: "gpt-5.4",
      cli_version: "0.117.0",
      scanner_file_path: "/home/user/.codex/sessions/2026/03/25/session.jsonl",
      total_input_tokens: 15000,
      total_output_tokens: 300,
      total_cache_read_tokens: 3000,
      total_reasoning_tokens: 50,
      turn_count: 3,
    });
    const s = getSession("codex-scan-1")!;
    expect(s.model).toBe("gpt-5.4");
    expect(s.total_reasoning_tokens).toBe(50);
    expect(s.total_cache_read_tokens).toBe(3000);
  });

  it("gemini: creates session with thoughts as reasoning", () => {
    upsertSession({
      session_id: "gemini-scan-1",
      target: "gemini",
      model: "gemini-3-flash-preview",
      scanner_file_path: "/home/user/.gemini/tmp/proj/chats/session.json",
      total_input_tokens: 8000,
      total_output_tokens: 40,
      total_reasoning_tokens: 82,
      turn_count: 5,
    });
    const s = getSession("gemini-scan-1")!;
    expect(s.model).toBe("gemini-3-flash-preview");
    expect(s.total_reasoning_tokens).toBe(82);
  });

  it("scanner can update token totals on existing session", () => {
    upsertSession({
      session_id: "scan-update",
      target: "claude",
      total_input_tokens: 100,
      total_output_tokens: 200,
      turn_count: 2,
    });
    upsertSession({
      session_id: "scan-update",
      total_input_tokens: 500,
      total_output_tokens: 1000,
      turn_count: 10,
    });
    const s = getSession("scan-update")!;
    // COALESCE(excluded, sessions) — new value wins for token fields
    expect(s.total_input_tokens).toBe(500);
    expect(s.total_output_tokens).toBe(1000);
    expect(s.turn_count).toBe(10);
  });
});

// ── Hooks + Scanner combined ────────────────────────────────────────────────

describe("hooks then scanner", () => {
  it("claude: scanner fills in model and tokens on hook-created session", () => {
    // Hook creates session first
    upsertSession({
      session_id: "claude-both-1",
      target: "claude",
      started_at_ms: 1700000000000,
      permission_mode: "default",
      agent_version: "2.1.84",
      first_prompt: "Write tests",
    });
    // Scanner adds model + token data
    upsertSession({
      session_id: "claude-both-1",
      target: "claude",
      model: "claude-opus-4-6",
      cli_version: "2.1.84",
      scanner_file_path: "/path/to/session.jsonl",
      total_input_tokens: 500,
      total_output_tokens: 2000,
      total_cache_read_tokens: 15000,
      turn_count: 10,
    });
    const s = getSession("claude-both-1")!;
    // Hook fields preserved
    expect(s.target).toBe("claude");
    expect(s.started_at_ms).toBe(1700000000000);
    expect(s.permission_mode).toBe("default");
    expect(s.agent_version).toBe("2.1.84");
    expect(s.first_prompt).toBe("Write tests");
    // Scanner fields added
    expect(s.model).toBe("claude-opus-4-6");
    expect(s.scanner_file_path).toBe("/path/to/session.jsonl");
    expect(s.total_input_tokens).toBe(500);
    expect(s.total_output_tokens).toBe(2000);
    expect(s.turn_count).toBe(10);
  });

  it("codex: scanner fills tokens on hook-created session", () => {
    upsertSession({
      session_id: "codex-both-1",
      target: "codex",
      started_at_ms: 1700000000000,
    });
    upsertSession({
      session_id: "codex-both-1",
      model: "gpt-5.4",
      total_input_tokens: 15000,
      total_reasoning_tokens: 50,
      turn_count: 3,
    });
    const s = getSession("codex-both-1")!;
    expect(s.target).toBe("codex");
    expect(s.model).toBe("gpt-5.4");
    expect(s.total_reasoning_tokens).toBe(50);
  });

  it("gemini: scanner fills tokens on hook-created session", () => {
    upsertSession({
      session_id: "gemini-both-1",
      target: "gemini",
      started_at_ms: 1700000000000,
    });
    upsertSession({
      session_id: "gemini-both-1",
      model: "gemini-3-flash-preview",
      total_input_tokens: 8000,
      total_reasoning_tokens: 82,
      turn_count: 5,
    });
    const s = getSession("gemini-both-1")!;
    expect(s.target).toBe("gemini");
    expect(s.model).toBe("gemini-3-flash-preview");
    expect(s.total_reasoning_tokens).toBe(82);
  });
});

describe("scanner then hooks", () => {
  it("claude: hooks fill in permission_mode on scanner-created session", () => {
    // Scanner creates session first
    upsertSession({
      session_id: "claude-rev-1",
      target: "claude",
      model: "claude-opus-4-6",
      scanner_file_path: "/path/to/session.jsonl",
      total_input_tokens: 500,
      turn_count: 10,
      first_prompt: "Scanner prompt",
    });
    // Hook adds runtime fields
    upsertSession({
      session_id: "claude-rev-1",
      target: "claude",
      started_at_ms: 1700000000000,
      permission_mode: "default",
      agent_version: "2.1.84",
      first_prompt: "Hook prompt",
    });
    const s = getSession("claude-rev-1")!;
    // Scanner fields preserved
    expect(s.model).toBe("claude-opus-4-6");
    expect(s.scanner_file_path).toBe("/path/to/session.jsonl");
    expect(s.total_input_tokens).toBe(500);
    // Hook fields added
    expect(s.started_at_ms).toBe(1700000000000);
    expect(s.permission_mode).toBe("default");
    expect(s.agent_version).toBe("2.1.84");
    // First prompt preserved from scanner (first writer wins)
    expect(s.first_prompt).toBe("Scanner prompt");
  });
});

// ── COALESCE semantics ──────────────────────────────────────────────────────

describe("COALESCE merge semantics", () => {
  it("null fields do not overwrite existing values", () => {
    upsertSession({
      session_id: "coalesce-1",
      target: "claude",
    });
    upsertSession({ session_id: "coalesce-1" }); // all fields undefined → null
    const s = getSession("coalesce-1")!;
    expect(s.target).toBe("claude");
  });

  it("new non-null values overwrite null fields", () => {
    upsertSession({ session_id: "coalesce-2" });
    upsertSession({
      session_id: "coalesce-2",
      target: "codex",
      model: "gpt-5.4",
    });
    const s = getSession("coalesce-2")!;
    expect(s.target).toBe("codex");
    expect(s.model).toBe("gpt-5.4");
  });

  it("token fields: new value overwrites existing", () => {
    upsertSession({ session_id: "coalesce-3", total_input_tokens: 100 });
    upsertSession({ session_id: "coalesce-3", total_input_tokens: 500 });
    const s = getSession("coalesce-3")!;
    // COALESCE(excluded, sessions) — scanner updates win
    expect(s.total_input_tokens).toBe(500);
  });

  it("three sequential upserts from different sources compose correctly", () => {
    // Hook: SessionStart
    upsertSession({
      session_id: "triple-1",
      target: "claude",
      started_at_ms: 1700000000000,
    });
    // Hook: UserPromptSubmit
    upsertSession({ session_id: "triple-1", first_prompt: "Build something" });
    // Scanner: token data
    upsertSession({
      session_id: "triple-1",
      model: "claude-opus-4-6",
      total_input_tokens: 1000,
      total_output_tokens: 500,
      turn_count: 5,
      scanner_file_path: "/path.jsonl",
    });
    const s = getSession("triple-1")!;
    expect(s.target).toBe("claude");
    expect(s.started_at_ms).toBe(1700000000000);
    expect(s.first_prompt).toBe("Build something");
    expect(s.model).toBe("claude-opus-4-6");
    expect(s.total_input_tokens).toBe(1000);
    expect(s.turn_count).toBe(5);
    expect(s.scanner_file_path).toBe("/path.jsonl");
  });
});

// ── OTLP-derived sessions ───────────────────────────────────────────────────

describe("OTLP-derived sessions", () => {
  it("codex: OTLP creates minimal session (target only)", () => {
    // This is what ensureSessionsFromOtel does: upsert with just session_id + target
    upsertSession({ session_id: "codex-otel-sess-1", target: "codex" });

    const s = getSession("codex-otel-sess-1")!;
    expect(s.session_id).toBe("codex-otel-sess-1");
    expect(s.target).toBe("codex");
    expect(s.model).toBeNull();
    expect(s.scanner_file_path).toBeNull();
    expect(s.started_at_ms).toBeNull();
  });

  it("gemini: OTLP logs create a session via service.name mapping", () => {
    upsertSession({ session_id: "gemini-otel-sess-1", target: "gemini" });
    const s = getSession("gemini-otel-sess-1")!;
    expect(s.target).toBe("gemini");
  });

  it("OTLP session + scanner compose: scanner adds tokens to OTLP-created session", () => {
    // OTLP creates minimal session
    upsertSession({ session_id: "otel-then-scan", target: "codex" });
    // Scanner adds token data
    upsertSession({
      session_id: "otel-then-scan",
      model: "gpt-5.4",
      total_input_tokens: 15000,
      total_output_tokens: 300,
      total_reasoning_tokens: 50,
      turn_count: 3,
      scanner_file_path: "/path/to/session.jsonl",
    });
    const s = getSession("otel-then-scan")!;
    expect(s.target).toBe("codex");
    expect(s.model).toBe("gpt-5.4");
    expect(s.total_input_tokens).toBe(15000);
    expect(s.total_reasoning_tokens).toBe(50);
    expect(s.scanner_file_path).toBe("/path/to/session.jsonl");
  });

  it("OTLP session + hooks compose: hooks add runtime fields to OTLP-created session", () => {
    // OTLP creates minimal session
    upsertSession({ session_id: "otel-then-hook", target: "gemini" });
    // Hooks add runtime fields
    upsertSession({
      session_id: "otel-then-hook",
      started_at_ms: 1700000000000,
      first_prompt: "Use some tools",
    });
    const s = getSession("otel-then-hook")!;
    expect(s.target).toBe("gemini");
    expect(s.started_at_ms).toBe(1700000000000);
    expect(s.first_prompt).toBe("Use some tools");
  });

  it("all three sources compose on one session", () => {
    // OTLP creates session
    upsertSession({ session_id: "all-three", target: "codex" });
    // Hooks add runtime data
    upsertSession({
      session_id: "all-three",
      started_at_ms: 1700000000000,
      first_prompt: "Build a thing",
    });
    // Scanner adds token data
    upsertSession({
      session_id: "all-three",
      model: "gpt-5.4",
      cli_version: "0.117.0",
      total_input_tokens: 15000,
      total_output_tokens: 300,
      total_reasoning_tokens: 50,
      turn_count: 3,
      scanner_file_path: "/codex/sessions/session.jsonl",
    });
    const s = getSession("all-three")!;
    expect(s.target).toBe("codex");
    expect(s.started_at_ms).toBe(1700000000000);
    expect(s.first_prompt).toBe("Build a thing");
    expect(s.model).toBe("gpt-5.4");
    expect(s.cli_version).toBe("0.117.0");
    expect(s.total_input_tokens).toBe(15000);
    expect(s.total_reasoning_tokens).toBe(50);
    expect(s.scanner_file_path).toBe("/codex/sessions/session.jsonl");
  });
});

// ── Model set tracking ──────────────────────────────────────────────────────

describe("model set tracking", () => {
  it("first model sets the models field", () => {
    upsertSession({ session_id: "model-1", model: "claude-opus-4-6" });
    const s = getSession("model-1")!;
    expect(s.models).toBe("claude-opus-4-6");
  });

  it("same model is not duplicated", () => {
    upsertSession({ session_id: "model-2", model: "claude-opus-4-6" });
    upsertSession({ session_id: "model-2", model: "claude-opus-4-6" });
    const s = getSession("model-2")!;
    expect(s.models).toBe("claude-opus-4-6");
  });

  it("different models are comma-separated", () => {
    upsertSession({ session_id: "model-3", model: "claude-opus-4-6" });
    upsertSession({ session_id: "model-3", model: "claude-haiku-4-5" });
    const s = getSession("model-3")!;
    expect(s.models).toBe("claude-opus-4-6,claude-haiku-4-5");
  });

  it("null model does not change existing set", () => {
    upsertSession({ session_id: "model-4", model: "gpt-5.4" });
    upsertSession({ session_id: "model-4" }); // no model
    const s = getSession("model-4")!;
    expect(s.models).toBe("gpt-5.4");
  });

  it("three models from different sources accumulate", () => {
    upsertSession({ session_id: "model-5", model: "claude-opus-4-6" });
    upsertSession({ session_id: "model-5", model: "claude-haiku-4-5" });
    upsertSession({ session_id: "model-5", model: "claude-sonnet-4" });
    const s = getSession("model-5")!;
    expect(s.models).toBe("claude-opus-4-6,claude-haiku-4-5,claude-sonnet-4");
  });
});

// ── OTEL token columns ──────────────────────────────────────────────────────

describe("OTEL token columns", () => {
  it("otel tokens are stored separately from scanner tokens", () => {
    upsertSession({
      session_id: "tok-1",
      total_input_tokens: 1000,
      total_output_tokens: 500,
      otel_input_tokens: 800,
      otel_output_tokens: 400,
    });
    const s = getSession("tok-1")!;
    expect(s.total_input_tokens).toBe(1000); // scanner
    expect(s.total_output_tokens).toBe(500);
    expect(s.otel_input_tokens).toBe(800); // otel
    expect(s.otel_output_tokens).toBe(400);
  });

  it("otel and scanner tokens update independently", () => {
    // Scanner sets tokens
    upsertSession({ session_id: "tok-2", total_input_tokens: 1000 });
    // OTEL sets different tokens
    upsertSession({ session_id: "tok-2", otel_input_tokens: 800 });
    const s = getSession("tok-2")!;
    expect(s.total_input_tokens).toBe(1000);
    expect(s.otel_input_tokens).toBe(800);
  });

  it("otel cache tokens stored separately", () => {
    upsertSession({
      session_id: "tok-3",
      otel_cache_read_tokens: 50000,
      otel_cache_creation_tokens: 3000,
      total_cache_read_tokens: 75000,
    });
    const s = getSession("tok-3")!;
    expect(s.otel_cache_read_tokens).toBe(50000);
    expect(s.otel_cache_creation_tokens).toBe(3000);
    expect(s.total_cache_read_tokens).toBe(75000); // scanner
  });
});
