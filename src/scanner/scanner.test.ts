import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allTargets, getTarget } from "../targets/index.js";
import { readNewLines } from "./reader.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

function claudeSessionLines(): string[] {
  return [
    JSON.stringify({
      type: "progress",
      sessionId: "abc-123",
      version: "2.1.84",
      cwd: "/workspace",
      timestamp: "2026-03-26T03:25:24.175Z",
      data: { type: "hook_progress" },
    }),
    JSON.stringify({
      type: "user",
      sessionId: "abc-123",
      version: "2.1.84",
      cwd: "/workspace",
      timestamp: "2026-03-26T03:25:30.000Z",
      message: {
        content: [{ type: "text", text: "Write a fibonacci function" }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      sessionId: "abc-123",
      timestamp: "2026-03-26T03:25:35.000Z",
      message: {
        model: "claude-opus-4-6",
        usage: {
          input_tokens: 100,
          output_tokens: 250,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 800,
        },
        stop_reason: "tool_use",
      },
    }),
    JSON.stringify({
      type: "user",
      sessionId: "abc-123",
      timestamp: "2026-03-26T03:25:40.000Z",
      message: { content: "Now run the tests" },
    }),
    JSON.stringify({
      type: "assistant",
      sessionId: "abc-123",
      timestamp: "2026-03-26T03:25:45.000Z",
      message: {
        model: "claude-opus-4-6",
        usage: {
          input_tokens: 50,
          output_tokens: 120,
          cache_read_input_tokens: 6000,
          cache_creation_input_tokens: 200,
        },
        stop_reason: "end_turn",
      },
    }),
  ];
}

function codexSessionLines(): string[] {
  return [
    JSON.stringify({
      timestamp: "2026-03-26T03:26:52.904Z",
      type: "session_meta",
      payload: {
        id: "019d-codex-session",
        cwd: "/workspace",
        cli_version: "0.117.0",
        timestamp: "2026-03-26T03:26:42.404Z",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-26T03:26:52.905Z",
      type: "turn_context",
      payload: { model: "gpt-5.4" },
    }),
    JSON.stringify({
      timestamp: "2026-03-26T03:26:53.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Write a fizzbuzz" },
    }),
    JSON.stringify({
      timestamp: "2026-03-26T03:26:54.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: null, // First token_count has null info
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-26T03:26:55.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 15000, output_tokens: 300 },
          last_token_usage: {
            input_tokens: 15000,
            cached_input_tokens: 3000,
            output_tokens: 300,
            reasoning_output_tokens: 50,
          },
        },
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-26T03:26:56.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 30000, output_tokens: 500 },
          last_token_usage: {
            input_tokens: 15000,
            cached_input_tokens: 12000,
            output_tokens: 200,
            reasoning_output_tokens: 30,
          },
        },
      },
    }),
  ];
}

function geminiSessionJson(): object {
  return {
    sessionId: "gem-session-1",
    startTime: "2026-03-26T06:00:12.001Z",
    kind: "main",
    summary: "Test session",
    messages: [
      {
        type: "user",
        timestamp: "2026-03-26T06:00:12.001Z",
        content: [{ text: "Use some tools" }],
      },
      {
        type: "gemini",
        model: "gemini-3-flash-preview",
        timestamp: "2026-03-26T06:00:25.258Z",
        tokens: {
          input: 8312,
          output: 40,
          cached: 0,
          thoughts: 82,
          tool: 0,
          total: 8434,
        },
        content: "I will begin by exploring",
      },
      {
        type: "info",
        timestamp: "2026-03-26T06:00:30.000Z",
        content: "tool execution output",
      },
      {
        type: "gemini",
        model: "gemini-3-flash-preview",
        timestamp: "2026-03-26T06:00:41.389Z",
        tokens: {
          input: 8561,
          output: 57,
          cached: 7755,
          thoughts: 72,
          tool: 0,
          total: 8690,
        },
        content: "Here are the results",
      },
    ],
  };
}

// ── Reader tests ────────────────────────────────────────────────────────────

describe("readNewLines", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads all lines from a new file", () => {
    const file = path.join(tmpDir, "test.jsonl");
    fs.writeFileSync(file, "line1\nline2\nline3\n");

    const { lines, newByteOffset } = readNewLines(file, 0);
    expect(lines).toEqual(["line1", "line2", "line3"]);
    expect(newByteOffset).toBe(18);
  });

  it("reads only new lines from an offset", () => {
    const file = path.join(tmpDir, "test.jsonl");
    fs.writeFileSync(file, "line1\nline2\nline3\n");

    const { lines, newByteOffset } = readNewLines(file, 6); // after "line1\n"
    expect(lines).toEqual(["line2", "line3"]);
    expect(newByteOffset).toBe(18);
  });

  it("returns empty when no new data", () => {
    const file = path.join(tmpDir, "test.jsonl");
    fs.writeFileSync(file, "line1\n");

    const { lines, newByteOffset } = readNewLines(file, 6);
    expect(lines).toEqual([]);
    expect(newByteOffset).toBe(6);
  });

  it("skips incomplete trailing line (no newline)", () => {
    const file = path.join(tmpDir, "test.jsonl");
    fs.writeFileSync(file, "complete\nincomplete");

    const { lines, newByteOffset } = readNewLines(file, 0);
    expect(lines).toEqual(["complete"]);
    expect(newByteOffset).toBe(9); // "complete\n"
  });

  it("picks up the line once newline is appended", () => {
    const file = path.join(tmpDir, "test.jsonl");
    fs.writeFileSync(file, "complete\nincomplete");

    const first = readNewLines(file, 0);
    expect(first.lines).toEqual(["complete"]);

    // Simulate append
    fs.appendFileSync(file, "\n");
    const second = readNewLines(file, first.newByteOffset);
    expect(second.lines).toEqual(["incomplete"]);
  });

  it("handles multi-byte UTF-8 correctly", () => {
    const file = path.join(tmpDir, "test.jsonl");
    fs.writeFileSync(file, "héllo\nwörld\n");

    const { lines } = readNewLines(file, 0);
    expect(lines).toEqual(["héllo", "wörld"]);
  });

  it("returns empty for missing file", () => {
    const { lines, newByteOffset } = readNewLines(path.join(tmpDir, "nope"), 0);
    expect(lines).toEqual([]);
    expect(newByteOffset).toBe(0);
  });
});

// ── Claude parser tests ─────────────────────────────────────────────────────

describe("claude scanner parseFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-claude-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAndParse(lines: string[]) {
    const file = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(file, lines.join("\n") + "\n");

    return getTarget("claude")!.scanner!.parseFile(file, 0);
  }

  it("extracts session metadata from first line with sessionId", () => {
    const result = writeAndParse(claudeSessionLines());
    expect(result).not.toBeNull();
    expect(result!.meta).toBeDefined();
    expect(result!.meta!.sessionId).toBe("abc-123");
    expect(result!.meta!.cliVersion).toBe("2.1.84");
    expect(result!.meta!.cwd).toBe("/workspace");
  });

  it("extracts model from first assistant message", () => {
    const result = writeAndParse(claudeSessionLines());
    expect(result!.meta!.model).toBe("claude-opus-4-6");
  });

  it("extracts first prompt from first user message", () => {
    const result = writeAndParse(claudeSessionLines());
    expect(result!.meta!.firstPrompt).toBe("Write a fibonacci function");
  });

  it("creates turns for user and assistant messages", () => {
    const result = writeAndParse(claudeSessionLines());
    // progress is skipped, 2 user + 2 assistant = 4 turns
    expect(result!.turns).toHaveLength(4);
    expect(result!.turns[0].role).toBe("user");
    expect(result!.turns[1].role).toBe("assistant");
    expect(result!.turns[2].role).toBe("user");
    expect(result!.turns[3].role).toBe("assistant");
  });

  it("extracts token usage from assistant messages", () => {
    const result = writeAndParse(claudeSessionLines());
    const first = result!.turns[1]; // first assistant
    expect(first.inputTokens).toBe(100);
    expect(first.outputTokens).toBe(250);
    expect(first.cacheReadTokens).toBe(5000);
    expect(first.cacheCreationTokens).toBe(800);

    const second = result!.turns[3]; // second assistant
    expect(second.inputTokens).toBe(50);
    expect(second.outputTokens).toBe(120);
    expect(second.cacheReadTokens).toBe(6000);
  });

  it("assigns sequential turn indices", () => {
    const result = writeAndParse(claudeSessionLines());
    expect(result!.turns.map((t) => t.turnIndex)).toEqual([0, 1, 2, 3]);
  });

  it("user turns have zero tokens", () => {
    const result = writeAndParse(claudeSessionLines());
    const userTurn = result!.turns[0];
    expect(userTurn.inputTokens).toBe(0);
    expect(userTurn.outputTokens).toBe(0);
    expect(userTurn.cacheReadTokens).toBe(0);
  });

  it("handles string content in user messages", () => {
    const result = writeAndParse(claudeSessionLines());
    expect(result!.turns[2].contentPreview).toBe("Now run the tests");
  });

  it("returns null for empty file", () => {
    const file = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(file, "");
    const result = getTarget("claude")!.scanner!.parseFile(file, 0);
    expect(result).toBeNull();
  });

  it("skips malformed JSON lines", () => {
    const lines = [
      "not json",
      JSON.stringify({
        type: "user",
        sessionId: "abc",
        timestamp: "2026-01-01T00:00:00Z",
        message: { content: "hello" },
      }),
    ];
    const result = writeAndParse(lines);
    expect(result!.turns).toHaveLength(1);
  });
});

// ── Codex parser tests ──────────────────────────────────────────────────────

describe("codex scanner parseFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-codex-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAndParse(lines: string[]) {
    const file = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return getTarget("codex")!.scanner!.parseFile(file, 0);
  }

  it("extracts session metadata from session_meta", () => {
    const result = writeAndParse(codexSessionLines());
    expect(result!.meta!.sessionId).toBe("019d-codex-session");
    expect(result!.meta!.cwd).toBe("/workspace");
    expect(result!.meta!.cliVersion).toBe("0.117.0");
  });

  it("extracts model from turn_context", () => {
    const result = writeAndParse(codexSessionLines());
    expect(result!.meta!.model).toBe("gpt-5.4");
  });

  it("extracts first prompt from user_message", () => {
    const result = writeAndParse(codexSessionLines());
    expect(result!.meta!.firstPrompt).toBe("Write a fizzbuzz");
  });

  it("skips token_count with null info", () => {
    const result = writeAndParse(codexSessionLines());
    // user_message + 2 token_counts with info = 3 turns (null info skipped)
    expect(result!.turns).toHaveLength(3);
  });

  it("extracts per-turn tokens from last_token_usage", () => {
    const result = writeAndParse(codexSessionLines());
    const firstAssistant = result!.turns[1]; // first token_count with info
    expect(firstAssistant.inputTokens).toBe(15000);
    expect(firstAssistant.outputTokens).toBe(300);
    expect(firstAssistant.cacheReadTokens).toBe(3000);
    expect(firstAssistant.reasoningTokens).toBe(50);

    const secondAssistant = result!.turns[2];
    expect(secondAssistant.inputTokens).toBe(15000);
    expect(secondAssistant.outputTokens).toBe(200);
    expect(secondAssistant.cacheReadTokens).toBe(12000);
    expect(secondAssistant.reasoningTokens).toBe(30);
  });

  it("assigns model from turn_context to turns", () => {
    const result = writeAndParse(codexSessionLines());
    expect(result!.turns[1].model).toBe("gpt-5.4");
  });
});

// ── Gemini parser tests ─────────────────────────────────────────────────────

describe("gemini scanner parseFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-gemini-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAndParse(session: object) {
    const file = path.join(tmpDir, "session-test.json");
    fs.writeFileSync(file, JSON.stringify(session));
    return getTarget("gemini")!.scanner!.parseFile(file, 0);
  }

  it("extracts session metadata", () => {
    const result = writeAndParse(geminiSessionJson());
    expect(result!.meta!.sessionId).toBe("gem-session-1");
    expect(result!.meta!.model).toBe("gemini-3-flash-preview");
    expect(result!.meta!.startedAtMs).toBe(
      new Date("2026-03-26T06:00:12.001Z").getTime(),
    );
  });

  it("extracts first prompt from first user message", () => {
    const result = writeAndParse(geminiSessionJson());
    expect(result!.meta!.firstPrompt).toBe("Use some tools");
  });

  it("creates turns for user and gemini messages, skips info", () => {
    const result = writeAndParse(geminiSessionJson());
    // 1 user + 2 gemini = 3 turns (info skipped)
    expect(result!.turns).toHaveLength(3);
    expect(result!.turns[0].role).toBe("user");
    expect(result!.turns[1].role).toBe("assistant");
    expect(result!.turns[2].role).toBe("assistant");
  });

  it("extracts tokens including thoughts (reasoning)", () => {
    const result = writeAndParse(geminiSessionJson());
    const first = result!.turns[1];
    expect(first.inputTokens).toBe(8312);
    expect(first.outputTokens).toBe(40);
    expect(first.cacheReadTokens).toBe(0);
    expect(first.reasoningTokens).toBe(82);

    const second = result!.turns[2];
    expect(second.cacheReadTokens).toBe(7755);
    expect(second.reasoningTokens).toBe(72);
  });

  it("returns null for unchanged file (same byte offset)", () => {
    const file = path.join(tmpDir, "session-test.json");
    const content = JSON.stringify(geminiSessionJson());
    fs.writeFileSync(file, content);

    // First read
    const first = getTarget("gemini")!.scanner!.parseFile(file, 0);
    expect(first).not.toBeNull();

    // Second read at same offset
    const second = getTarget("gemini")!.scanner!.parseFile(
      file,
      first!.newByteOffset,
    );
    expect(second).toBeNull();
  });

  it("returns null for missing sessionId", () => {
    const result = writeAndParse({ messages: [{ type: "user" }] });
    expect(result).toBeNull();
  });

  it("returns null for empty messages", () => {
    const result = writeAndParse({ sessionId: "x", messages: [] });
    expect(result).toBeNull();
  });
});

// ── Scanner spec on target adapters ─────────────────────────────────────────

describe("target scanner specs", () => {
  it("claude has scanner spec", () => {
    const claude = getTarget("claude")!;
    expect(claude.scanner).toBeDefined();
    expect(claude.scanner!.discover).toBeTypeOf("function");
    expect(claude.scanner!.parseFile).toBeTypeOf("function");
  });

  it("codex has scanner spec", () => {
    expect(getTarget("codex")!.scanner).toBeDefined();
  });

  it("gemini has scanner spec", () => {
    expect(getTarget("gemini")!.scanner).toBeDefined();
  });

  it("discover returns array of file paths", () => {
    for (const target of allTargets()) {
      if (!target.scanner) continue;
      const files = target.scanner.discover();
      expect(Array.isArray(files)).toBe(true);
      for (const f of files) {
        expect(f.filePath).toBeTypeOf("string");
      }
    }
  });
});
