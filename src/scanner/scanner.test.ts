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
    fs.writeFileSync(file, `${lines.join("\n")}\n`);

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

  it("populates uuid and parentUuid on messages", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        sessionId: "uuid-test",
        timestamp: "2026-01-01T00:00:00Z",
        uuid: "aaa",
        message: { content: "hello" },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId: "uuid-test",
        timestamp: "2026-01-01T00:00:01Z",
        uuid: "bbb",
        parentUuid: "aaa",
        message: {
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ];
    const result = writeAndParse(lines);
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0].uuid).toBe("aaa");
    expect(result!.messages[0].parentUuid).toBeUndefined();
    expect(result!.messages[1].uuid).toBe("bbb");
    expect(result!.messages[1].parentUuid).toBe("aaa");
  });

  it("stores timestampMs on tool calls and tool results", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        sessionId: "dur-test",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          model: "claude-opus-4-6",
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId: "dur-test",
        timestamp: "2026-01-01T00:00:03Z",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: "file1.txt\nfile2.txt",
            },
            { type: "text", text: "next question" },
          ],
        },
      }),
    ];
    const result = writeAndParse(lines);
    // Assistant message has one tool call with timestamp
    expect(result!.messages[0].toolCalls).toHaveLength(1);
    expect(result!.messages[0].toolCalls[0].timestampMs).toBe(
      new Date("2026-01-01T00:00:00Z").getTime(),
    );
    // User message has tool result with timestamp (3 seconds later)
    const userResults = result!.messages[1].toolResults.get("tu_1");
    expect(userResults).toBeDefined();
    expect(userResults!.timestampMs).toBe(
      new Date("2026-01-01T00:00:03Z").getTime(),
    );
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
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
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

  it("extracts assistant content from response_item message blocks", () => {
    const result = writeAndParse([
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { id: "codex-msg-1", cwd: "/workspace" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01Z",
        payload: { type: "user_message", message: "hello" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-01-01T00:00:02Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I can help with that." }],
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:03Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 5,
              reasoning_output_tokens: 0,
            },
          },
        },
      }),
    ]);

    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[1].role).toBe("assistant");
    expect(result!.messages[1].content).toBe("I can help with that.");
  });

  it("captures reasoning items as assistant thinking", () => {
    const result = writeAndParse([
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { id: "codex-think-1", cwd: "/workspace" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01Z",
        payload: { type: "user_message", message: "think first" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-01-01T00:00:02Z",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Need to inspect files" }],
          content: null,
          encrypted_content: "encrypted",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:03Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 5,
              reasoning_output_tokens: 2,
            },
          },
        },
      }),
    ]);

    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[1].hasThinking).toBe(true);
    expect(result!.messages[1].content).toContain("Need to inspect files");
    const reasoning = result!.events.find((e) => e.eventType === "reasoning")!;
    expect(reasoning.content).toBe("Need to inspect files");
    expect(reasoning.metadata?.has_encrypted_content).toBe(true);
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

// ── Event capture tests ─────────────────────────────────────────────────────

describe("claude event capture", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-claude-ev-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures system error events", () => {
    const lines = [
      JSON.stringify({
        type: "system",
        sessionId: "err-1",
        timestamp: "2026-01-01T00:00:00Z",
        level: "error",
        data: {
          type: "api_error",
          message: "rate limited",
          retryAttempt: 1,
          maxRetries: 3,
          retryInMs: 2000,
        },
      }),
    ];
    const file = path.join(tmpDir, "s.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const result = getTarget("claude")!.scanner!.parseFile(file, 0);
    expect(result!.events.length).toBeGreaterThanOrEqual(1);
    const err = result!.events.find((e) => e.eventType === "error");
    expect(err).toBeDefined();
    expect(err!.content).toBe("rate limited");
    expect(err!.metadata?.retryAttempt).toBe(1);
  });

  it("captures file-history-snapshot events", () => {
    const lines = [
      JSON.stringify({
        type: "file-history-snapshot",
        sessionId: "snap-1",
        timestamp: "2026-01-01T00:00:00Z",
        messageId: "msg-123",
        data: { trackedFileBackups: { "file.ts": "hash123" } },
      }),
    ];
    const file = path.join(tmpDir, "s.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const result = getTarget("claude")!.scanner!.parseFile(file, 0);
    const snap = result!.events.find((e) => e.eventType === "file_snapshot");
    expect(snap).toBeDefined();
    expect(snap!.metadata?.messageId).toBe("msg-123");
  });

  it("captures progress events with durationMs", () => {
    const lines = [
      JSON.stringify({
        type: "progress",
        sessionId: "prog-1",
        timestamp: "2026-01-01T00:00:00Z",
        data: {
          hookEvent: "PreToolUse",
          hookName: "PreToolUse:Bash",
          durationMs: 150,
        },
      }),
    ];
    const file = path.join(tmpDir, "s.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const result = getTarget("claude")!.scanner!.parseFile(file, 0);
    const prog = result!.events.find(
      (e) => e.eventType === "progress:PreToolUse",
    );
    expect(prog).toBeDefined();
    expect(prog!.metadata?.durationMs).toBe(150);
    expect(prog!.toolName).toBe("PreToolUse:Bash");
  });

  it("captures Claude session metadata rows", () => {
    const lines = [
      JSON.stringify({
        type: "permission-mode",
        sessionId: "meta-1",
        permissionMode: "plan",
      }),
      JSON.stringify({
        type: "custom-title",
        sessionId: "meta-1",
        customTitle: "panopticon-v2-idempotent-sync",
      }),
      JSON.stringify({
        type: "agent-name",
        sessionId: "meta-1",
        agentName: "panopticon-v2-idempotent-sync",
      }),
      JSON.stringify({
        type: "pr-link",
        sessionId: "meta-1",
        timestamp: "2026-01-01T00:00:01Z",
        prNumber: 842,
        prRepository: "fml-inc/fml",
        prUrl: "https://github.com/fml-inc/fml/pull/842",
      }),
      JSON.stringify({
        type: "worktree-state",
        sessionId: "meta-1",
        worktreeSession: {
          originalCwd: "/workspace/repo",
          worktreePath: "/workspace/repo/.claude/worktrees/feature",
          worktreeName: "feature",
          worktreeBranch: "worktree-feature",
          originalBranch: "main",
          originalHeadCommit: "abc123",
        },
      }),
      JSON.stringify({
        type: "attachment",
        sessionId: "meta-1",
        timestamp: "2026-01-01T00:00:02Z",
        parentUuid: "parent-1",
        isSidechain: false,
        attachment: {
          type: "deferred_tools_delta",
          addedNames: ["WebSearch", "TaskCreate"],
          removedNames: ["OldTool"],
          addedLines: ["WebSearch", "TaskCreate"],
        },
      }),
    ];
    const file = path.join(tmpDir, "meta.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const result = getTarget("claude")!.scanner!.parseFile(file, 0);

    expect(
      result!.events.find((e) => e.eventType === "permission_mode")?.content,
    ).toBe("plan");
    expect(
      result!.events.find((e) => e.eventType === "custom_title")?.content,
    ).toBe("panopticon-v2-idempotent-sync");
    expect(
      result!.events.find((e) => e.eventType === "agent_name")?.content,
    ).toBe("panopticon-v2-idempotent-sync");

    const prLink = result!.events.find((e) => e.eventType === "pr_link")!;
    expect(prLink.content).toBe("fml-inc/fml#842");
    expect(prLink.metadata?.prUrl).toBe(
      "https://github.com/fml-inc/fml/pull/842",
    );

    const worktree = result!.events.find(
      (e) => e.eventType === "worktree_state",
    )!;
    expect(worktree.content).toBe("/workspace/repo/.claude/worktrees/feature");
    expect(worktree.metadata?.worktreeBranch).toBe("worktree-feature");

    const attachment = result!.events.find(
      (e) => e.eventType === "attachment",
    )!;
    expect(attachment.content).toContain("Deferred tools updated");
    expect(attachment.metadata?.attachmentType).toBe("deferred_tools_delta");
    expect(attachment.metadata?.addedNamesCount).toBe(2);
  });

  it("captures additional Claude system subtypes", () => {
    const lines = [
      JSON.stringify({
        type: "system",
        sessionId: "sys-1",
        timestamp: "2026-01-01T00:00:00Z",
        subtype: "turn_duration",
        durationMs: 81640,
        messageCount: 44,
        parentUuid: "parent-a",
      }),
      JSON.stringify({
        type: "system",
        sessionId: "sys-1",
        timestamp: "2026-01-01T00:00:01Z",
        subtype: "local_command",
        level: "info",
        content:
          "<local-command-stderr>Error: Path does not exist</local-command-stderr>",
        parentUuid: "parent-b",
      }),
      JSON.stringify({
        type: "system",
        sessionId: "sys-1",
        timestamp: "2026-01-01T00:00:02Z",
        subtype: "compact_boundary",
        level: "info",
        content: "Conversation compacted",
        logicalParentUuid: "logical-parent",
        compactMetadata: { trigger: "auto", preTokens: 167304 },
      }),
      JSON.stringify({
        type: "system",
        sessionId: "sys-1",
        timestamp: "2026-01-01T00:00:03Z",
        subtype: "away_summary",
        content: "Reviewed the claims stack and paused there.",
        parentUuid: "parent-c",
      }),
    ];
    const file = path.join(tmpDir, "system.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const result = getTarget("claude")!.scanner!.parseFile(file, 0);

    const turnDuration = result!.events.find(
      (e) => e.eventType === "turn_duration",
    )!;
    expect(turnDuration.metadata?.durationMs).toBe(81640);
    expect(turnDuration.metadata?.messageCount).toBe(44);

    const localCommand = result!.events.find(
      (e) => e.eventType === "local_command",
    )!;
    expect(localCommand.content).toContain("Path does not exist");

    const compactBoundary = result!.events.find(
      (e) => e.eventType === "compact_boundary",
    )!;
    expect(compactBoundary.content).toBe("Conversation compacted");
    expect(compactBoundary.metadata?.compactMetadata).toEqual({
      trigger: "auto",
      preTokens: 167304,
    });

    const awaySummary = result!.events.find(
      (e) => e.eventType === "away_summary",
    )!;
    expect(awaySummary.content).toContain("Reviewed the claims stack");
  });

  it("captures Claude progress query and task updates", () => {
    const lines = [
      JSON.stringify({
        type: "progress",
        sessionId: "prog-2",
        timestamp: "2026-01-01T00:00:00Z",
        toolUseID: "search-progress-1",
        parentToolUseID: "toolu_parent_1",
        data: {
          type: "query_update",
          query: "github.com/anthropics/claude-code source code repository",
        },
      }),
      JSON.stringify({
        type: "progress",
        sessionId: "prog-2",
        timestamp: "2026-01-01T00:00:01Z",
        toolUseID: "search-progress-2",
        parentToolUseID: "toolu_parent_1",
        data: {
          type: "search_results_received",
          query: "github.com/anthropics/claude-code source code repository",
          resultCount: 10,
        },
      }),
      JSON.stringify({
        type: "progress",
        sessionId: "prog-2",
        timestamp: "2026-01-01T00:00:02Z",
        toolUseID: "task-progress-1",
        parentToolUseID: "toolu_parent_2",
        data: {
          type: "waiting_for_task",
          taskDescription: "Test login with auto-select",
          taskType: "local_bash",
        },
      }),
    ];
    const file = path.join(tmpDir, "progress.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const result = getTarget("claude")!.scanner!.parseFile(file, 0);

    const queryUpdate = result!.events.find(
      (e) => e.eventType === "progress:query_update",
    )!;
    expect(queryUpdate.content).toContain("claude-code");
    expect(queryUpdate.metadata?.parentToolUseID).toBe("toolu_parent_1");

    const searchResults = result!.events.find(
      (e) => e.eventType === "progress:search_results_received",
    )!;
    expect(searchResults.metadata?.resultCount).toBe(10);

    const waiting = result!.events.find(
      (e) => e.eventType === "progress:waiting_for_task",
    )!;
    expect(waiting.content).toBe("Test login with auto-select");
    expect(waiting.metadata?.taskType).toBe("local_bash");
  });
});

describe("codex event capture", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-codex-ev-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures function_call tool events", () => {
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { id: "codex-ev-1", cwd: "/workspace" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"ls -la"}',
          call_id: "call-1",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          output: "file1.ts\nfile2.ts",
          call_id: "call-1",
        },
      }),
    ];
    const file = path.join(tmpDir, "s.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const result = getTarget("codex")!.scanner!.parseFile(file, 0);
    expect(result!.events.length).toBe(2);

    const call = result!.events.find((e) => e.eventType === "tool_call")!;
    expect(call.toolName).toBe("exec_command");
    expect(call.toolInput).toContain("ls -la");

    const out = result!.events.find((e) => e.eventType === "tool_result")!;
    expect(out.toolName).toBe("exec_command");
    expect(out.toolOutput).toContain("file1.ts");
  });

  it("captures custom_tool_call edits into assistant tool calls", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /workspace/src/index.ts",
      "@@",
      "-const value = 0;",
      "+const value = 1;",
      "*** End Patch",
    ].join("\n");
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { id: "codex-ev-3", cwd: "/workspace" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { type: "user_message", message: "patch the file" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-01-01T00:00:01Z",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-2",
          input: patch,
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:02Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 5,
              reasoning_output_tokens: 0,
            },
          },
        },
      }),
    ];
    const file = path.join(tmpDir, "s.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const result = getTarget("codex")!.scanner!.parseFile(file, 0);

    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[1].toolCalls).toHaveLength(1);
    expect(result!.messages[1].toolCalls[0].toolName).toBe("apply_patch");
    expect(result!.messages[1].toolCalls[0].inputJson).toContain(
      "/workspace/src/index.ts",
    );
    expect(
      result!.events.find((e) => e.eventType === "tool_call")?.toolName,
    ).toBe("apply_patch");
  });

  it("captures agent_message events", () => {
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { id: "codex-ev-2" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01Z",
        payload: {
          type: "agent_message",
          message: "Exploring the codebase structure",
          phase: "commentary",
        },
      }),
    ];
    const file = path.join(tmpDir, "s.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const result = getTarget("codex")!.scanner!.parseFile(file, 0);
    const msg = result!.events.find((e) => e.eventType === "agent_message")!;
    expect(msg.content).toBe("Exploring the codebase structure");
    expect(msg.metadata?.phase).toBe("commentary");
  });

  it("captures web_search_call tool usage from response items", () => {
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { id: "codex-web-1", cwd: "/workspace" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { type: "user_message", message: "search the web" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01Z",
        payload: {
          type: "web_search_end",
          call_id: "ws-1",
          query: "site:example.com foo",
          action: {
            type: "search",
            query: "site:example.com foo",
            queries: ["site:example.com foo"],
          },
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-01-01T00:00:02Z",
        payload: {
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            query: "site:example.com foo",
            queries: ["site:example.com foo"],
          },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:03Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 5,
              reasoning_output_tokens: 0,
            },
          },
        },
      }),
    ];
    const file = path.join(tmpDir, "web.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const result = getTarget("codex")!.scanner!.parseFile(file, 0);

    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[1].toolCalls).toHaveLength(1);
    expect(result!.messages[1].toolCalls[0].toolName).toBe("web_search");
    expect(result!.messages[1].toolCalls[0].toolUseId).toBe("ws-1");
    expect(result!.messages[1].toolCalls[0].inputJson).toContain(
      "site:example.com foo",
    );
    expect(
      result!.events.find(
        (e) => e.eventType === "tool_call" && e.toolName === "web_search",
      )?.metadata?.call_id,
    ).toBe("ws-1");
    expect(
      result!.events.find((e) => e.eventType === "web_search_end")?.content,
    ).toBe("site:example.com foo");
  });

  it("falls back to web_search_end details when web_search_call omits action", () => {
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { id: "codex-web-2", cwd: "/workspace" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01Z",
        payload: {
          type: "web_search_end",
          call_id: "ws-2",
          query: "site:wikipedia.org triplestore",
          action: {
            type: "search",
            query: "site:wikipedia.org triplestore",
            queries: ["site:wikipedia.org triplestore"],
          },
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-01-01T00:00:02Z",
        payload: {
          type: "web_search_call",
          status: "completed",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:03Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 5,
              reasoning_output_tokens: 0,
            },
          },
        },
      }),
    ];
    const file = path.join(tmpDir, "web-fallback.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const result = getTarget("codex")!.scanner!.parseFile(file, 0);

    expect(result!.messages[0].toolCalls).toHaveLength(1);
    expect(result!.messages[0].toolCalls[0].toolUseId).toBe("ws-2");
    expect(result!.messages[0].toolCalls[0].inputJson).toContain(
      "site:wikipedia.org triplestore",
    );
  });

  it("captures patch_apply_end events with structured metadata", () => {
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { id: "codex-patch-end-1", cwd: "/workspace" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-01-01T00:00:01Z",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-patch-1",
          input:
            "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:02Z",
        payload: {
          type: "patch_apply_end",
          call_id: "call-patch-1",
          turn_id: "turn-1",
          stdout: "Success. Updated the following files:\nM src/a.ts\n",
          stderr: "",
          success: true,
          changes: {
            "src/a.ts": {
              type: "update",
              unified_diff: "@@\n-a\n+b\n",
              move_path: null,
            },
          },
        },
      }),
    ];
    const file = path.join(tmpDir, "patch-end.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const result = getTarget("codex")!.scanner!.parseFile(file, 0);

    const patchEvent = result!.events.find(
      (e) => e.eventType === "patch_apply_end",
    )!;
    expect(patchEvent.toolName).toBe("apply_patch");
    expect(patchEvent.toolOutput).toContain("Updated the following files");
    expect(patchEvent.metadata?.success).toBe(true);
    expect(
      (patchEvent.metadata?.changes as Record<string, unknown>)["src/a.ts"],
    ).toBeDefined();
  });

  it("captures exec_command_end events and uses them as fallback tool results", () => {
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { id: "codex-exec-end-1", cwd: "/workspace" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-exec-1",
          arguments: '{"cmd":"git status --short"}',
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:02Z",
        payload: {
          type: "exec_command_end",
          call_id: "call-exec-1",
          process_id: "12345",
          turn_id: "turn-1",
          command: ["/bin/zsh", "-lc", "git status --short"],
          cwd: "/workspace",
          parsed_cmd: [{ type: "unknown", cmd: "git status --short" }],
          source: "unified_exec",
          stdout: "",
          stderr: "",
          aggregated_output: "M src/a.ts\n",
          exit_code: 0,
          duration: { secs: 0, nanos: 5_000_000 },
          formatted_output: "",
          status: "completed",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:03Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 12,
              cached_input_tokens: 0,
              output_tokens: 4,
              reasoning_output_tokens: 0,
            },
          },
        },
      }),
    ];
    const file = path.join(tmpDir, "exec-end.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const result = getTarget("codex")!.scanner!.parseFile(file, 0);

    const execEvent = result!.events.find(
      (e) => e.eventType === "exec_command_end",
    )!;
    expect(execEvent.toolName).toBe("exec_command");
    expect(execEvent.toolOutput).toContain("M src/a.ts");
    expect(execEvent.metadata?.exit_code).toBe(0);
    expect(execEvent.metadata?.duration_ms).toBe(5);
    expect(result!.messages[0].toolResults.get("call-exec-1")?.contentRaw).toBe(
      "M src/a.ts\n",
    );
  });

  it("captures codex task lifecycle and auxiliary event messages", () => {
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { id: "codex-aux-1", cwd: "/workspace" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01Z",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
          model_context_window: 258400,
          collaboration_mode_kind: "default",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-01-01T00:00:02Z",
        payload: {
          type: "function_call",
          name: "query",
          call_id: "call-mcp-1",
          arguments: '{"sql":"select 1"}',
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:03Z",
        payload: {
          type: "mcp_tool_call_end",
          call_id: "call-mcp-1",
          invocation: {
            server: "panopticon",
            tool: "query",
            arguments: { sql: "select 1" },
          },
          duration: { secs: 0, nanos: 1000 },
          result: {
            Ok: {
              content: [{ type: "text", text: '[{"value":1}]' }],
            },
          },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:04Z",
        payload: {
          type: "task_complete",
          turn_id: "turn-1",
          last_agent_message: "done",
          duration_ms: 123,
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:05Z",
        payload: {
          type: "turn_aborted",
          turn_id: "turn-2",
          reason: "interrupted",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:06Z",
        payload: { type: "context_compacted" },
      }),
    ];
    const file = path.join(tmpDir, "aux.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const result = getTarget("codex")!.scanner!.parseFile(file, 0);

    expect(
      result!.events.find((e) => e.eventType === "task_started"),
    ).toBeDefined();
    expect(
      result!.events.find((e) => e.eventType === "task_complete")?.content,
    ).toBe("done");
    expect(
      result!.events.find((e) => e.eventType === "turn_aborted")?.content,
    ).toBe("interrupted");
    expect(
      result!.events.find((e) => e.eventType === "context_compacted"),
    ).toBeDefined();
    const mcp = result!.events.find(
      (e) => e.eventType === "mcp_tool_call_end",
    )!;
    expect(mcp.toolName).toBe("query");
    expect(mcp.toolOutput).toContain('[{"value":1}]');
  });

  it("captures compacted transcript snapshots", () => {
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { id: "codex-compacted-1", cwd: "/workspace" },
      }),
      JSON.stringify({
        type: "compacted",
        timestamp: "2026-01-01T00:00:01Z",
        payload: {
          message: "Compacted prior context",
          replacement_history: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "First prompt" }],
            },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "First answer" }],
            },
          ],
        },
      }),
    ];
    const file = path.join(tmpDir, "compacted.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const result = getTarget("codex")!.scanner!.parseFile(file, 0);

    const compacted = result!.events.find((e) => e.eventType === "compacted")!;
    expect(compacted.content).toBe("Compacted prior context");
    expect(compacted.metadata?.replacement_history_length).toBe(2);
  });
});

describe("gemini event capture", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-gemini-ev-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures toolCalls from gemini messages", () => {
    const session = {
      sessionId: "gem-ev-1",
      startTime: "2026-01-01T00:00:00Z",
      messages: [
        {
          type: "gemini",
          model: "gemini-3-flash",
          timestamp: "2026-01-01T00:00:01Z",
          tokens: {
            input: 100,
            output: 10,
            cached: 0,
            thoughts: 0,
            total: 110,
          },
          content: "Reading file",
          toolCalls: [
            {
              name: "read_file",
              args: { file_path: "/workspace/main.ts" },
              result: [
                { functionResponse: { content: "export function main() {}" } },
              ],
            },
          ],
        },
      ],
    };
    const file = path.join(tmpDir, "session-test.json");
    fs.writeFileSync(file, JSON.stringify(session));
    const result = getTarget("gemini")!.scanner!.parseFile(file, 0);
    const call = result!.events.find((e) => e.eventType === "tool_call")!;
    expect(call.toolName).toBe("read_file");
    expect(call.toolInput).toContain("main.ts");
    expect(call.toolOutput).toContain("export function main");
  });

  it("captures thoughts/reasoning from gemini messages", () => {
    const session = {
      sessionId: "gem-ev-2",
      startTime: "2026-01-01T00:00:00Z",
      messages: [
        {
          type: "gemini",
          model: "gemini-3-flash",
          timestamp: "2026-01-01T00:00:01Z",
          tokens: {
            input: 100,
            output: 10,
            cached: 0,
            thoughts: 50,
            total: 160,
          },
          content: "Here is my analysis",
          thoughts: [
            {
              subject: "Code review",
              description: "Analyzing the function for bugs",
            },
          ],
        },
      ],
    };
    const file = path.join(tmpDir, "session-test.json");
    fs.writeFileSync(file, JSON.stringify(session));
    const result = getTarget("gemini")!.scanner!.parseFile(file, 0);
    const thought = result!.events.find((e) => e.eventType === "reasoning")!;
    expect(thought.content).toBe("Analyzing the function for bugs");
  });

  it("captures info messages", () => {
    const session = {
      sessionId: "gem-ev-3",
      startTime: "2026-01-01T00:00:00Z",
      messages: [
        {
          type: "info",
          timestamp: "2026-01-01T00:00:01Z",
          content: "Tool execution output",
        },
      ],
    };
    const file = path.join(tmpDir, "session-test.json");
    fs.writeFileSync(file, JSON.stringify(session));
    const result = getTarget("gemini")!.scanner!.parseFile(file, 0);
    const info = result!.events.find((e) => e.eventType === "info")!;
    expect(info.content).toBe("Tool execution output");
  });

  it("returns empty events array when no events", () => {
    const session = {
      sessionId: "gem-ev-4",
      startTime: "2026-01-01T00:00:00Z",
      messages: [
        {
          type: "user",
          timestamp: "2026-01-01T00:00:01Z",
          content: [{ text: "hi" }],
        },
      ],
    };
    const file = path.join(tmpDir, "session-test.json");
    fs.writeFileSync(file, JSON.stringify(session));
    const result = getTarget("gemini")!.scanner!.parseFile(file, 0);
    expect(result!.events).toEqual([]);
  });
});
