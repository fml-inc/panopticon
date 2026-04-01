import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getTarget } from "./index.js";

const gemini = getTarget("gemini")!;

function makeTmpSession(messages: unknown[]): {
  filePath: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-gemini-test-"));
  const filePath = path.join(dir, "session-test.json");
  const session = {
    sessionId: "test-session-001",
    startTime: "2026-03-29T22:51:15.519Z",
    lastUpdated: "2026-03-29T22:56:05.815Z",
    messages,
  };
  fs.writeFileSync(filePath, JSON.stringify(session));
  return {
    filePath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function userMsg(text: string, timestamp = "2026-03-29T22:51:15.519Z") {
  return {
    id: `user-${Math.random()}`,
    timestamp,
    type: "user",
    content: [{ text }],
  };
}

function geminiMsg(
  text: string,
  opts: {
    timestamp?: string;
    model?: string;
    tokens?: {
      input: number;
      output: number;
      cached?: number;
      thoughts?: number;
    };
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    thoughts?: Array<{ subject: string; description: string }>;
  } = {},
) {
  return {
    id: `gemini-${Math.random()}`,
    timestamp: opts.timestamp ?? "2026-03-29T22:51:18.734Z",
    type: "gemini",
    content: text,
    model: opts.model ?? "gemini-3-flash-preview",
    tokens: opts.tokens ?? { input: 7000, output: 50, cached: 0, thoughts: 0 },
    ...(opts.toolCalls ? { toolCalls: opts.toolCalls } : {}),
    ...(opts.thoughts ? { thoughts: opts.thoughts } : {}),
  };
}

describe("gemini scanner parseFile", () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const c of cleanups) c();
  });

  it("parses a simple session with one user + one assistant turn", () => {
    const { filePath, cleanup } = makeTmpSession([
      userMsg("hello"),
      geminiMsg("Hi there!"),
    ]);
    cleanups.push(cleanup);

    const result = gemini.scanner!.parseFile(filePath, 0);
    expect(result).not.toBeNull();
    expect(result!.turns).toHaveLength(2);
    expect(result!.turns[0].role).toBe("user");
    expect(result!.turns[0].turnIndex).toBe(0);
    expect(result!.turns[0].contentPreview).toBe("hello");
    expect(result!.turns[1].role).toBe("assistant");
    expect(result!.turns[1].turnIndex).toBe(1);
    expect(result!.meta!.sessionId).toBe("test-session-001");
  });

  it("returns all turns with absolute indices when file grows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-gemini-grow-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, "session-grow.json");

    // Initial parse: 3 messages
    const initialMessages = [
      userMsg("what is 2+2"),
      geminiMsg("The answer is 4."),
      geminiMsg("Would you like to know more?"),
    ];
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        sessionId: "grow-session",
        startTime: "2026-03-29T22:51:15.519Z",
        messages: initialMessages,
      }),
    );

    const firstParse = gemini.scanner!.parseFile(filePath, 0);
    expect(firstParse).not.toBeNull();
    expect(firstParse!.turns).toHaveLength(3);
    expect(firstParse!.absoluteIndices).toBe(true);
    const firstSize = firstParse!.newByteOffset;

    // File grows: Gemini adds a new assistant message
    const grownMessages = [
      ...initialMessages,
      geminiMsg("Here is more detail.", {
        timestamp: "2026-03-29T22:52:00.000Z",
      }),
    ];
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        sessionId: "grow-session",
        startTime: "2026-03-29T22:51:15.519Z",
        messages: grownMessages,
      }),
    );

    // Re-parse returns ALL turns with absolute indices starting at 0.
    // The scanner loop uses INSERT OR IGNORE to dedup — old turns (0-2)
    // are skipped by the UNIQUE constraint, only turn 3 is inserted.
    const secondParse = gemini.scanner!.parseFile(filePath, firstSize);
    expect(secondParse).not.toBeNull();
    expect(secondParse!.absoluteIndices).toBe(true);
    expect(secondParse!.turns).toHaveLength(4);
    expect(secondParse!.turns[0].turnIndex).toBe(0); // absolute, not re-indexed
    expect(secondParse!.turns[3].turnIndex).toBe(3);
    expect(secondParse!.turns[3].contentPreview).toBe("Here is more detail.");
  });

  it("returns null when file has not changed", () => {
    const { filePath, cleanup } = makeTmpSession([
      userMsg("hello"),
      geminiMsg("Hi!"),
    ]);
    cleanups.push(cleanup);

    const firstParse = gemini.scanner!.parseFile(filePath, 0);
    const result = gemini.scanner!.parseFile(
      filePath,
      firstParse!.newByteOffset,
    );
    expect(result).toBeNull();
  });

  it("extracts tool calls as events", () => {
    const { filePath, cleanup } = makeTmpSession([
      userMsg("list files"),
      geminiMsg("I'll list the directory.", {
        toolCalls: [
          {
            name: "list_directory",
            args: { dir_path: "/Users/gus/workspace" },
          },
        ],
      }),
    ]);
    cleanups.push(cleanup);

    const result = gemini.scanner!.parseFile(filePath, 0);
    expect(
      result!.events.filter((e) => e.eventType === "tool_call"),
    ).toHaveLength(1);
    expect(result!.events[0].toolName).toBe("list_directory");
  });

  it("extracts reasoning/thoughts as events", () => {
    const { filePath, cleanup } = makeTmpSession([
      userMsg("analyze this"),
      geminiMsg("Let me think...", {
        thoughts: [
          {
            subject: "Planning",
            description: "I need to explore the code first",
          },
          {
            subject: "Strategy",
            description: "Will start with the entry point",
          },
        ],
      }),
    ]);
    cleanups.push(cleanup);

    const result = gemini.scanner!.parseFile(filePath, 0);
    const reasoning = result!.events.filter((e) => e.eventType === "reasoning");
    expect(reasoning).toHaveLength(2);
    expect(reasoning[0].content).toBe("I need to explore the code first");
  });

  it("returns all events when file grows (dedup at DB layer)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-gemini-events-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, "session-events.json");

    const initialMessages = [
      userMsg("list files"),
      geminiMsg("Listing...", {
        toolCalls: [{ name: "list_directory", args: { dir_path: "/tmp" } }],
        thoughts: [{ subject: "Plan", description: "List the directory" }],
      }),
    ];
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        sessionId: "events-session",
        startTime: "2026-03-29T22:51:15.519Z",
        messages: initialMessages,
      }),
    );

    const firstParse = gemini.scanner!.parseFile(filePath, 0);
    expect(firstParse!.events).toHaveLength(2); // 1 tool_call + 1 reasoning
    const firstSize = firstParse!.newByteOffset;

    // Add a new message with more tool calls
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        sessionId: "events-session",
        startTime: "2026-03-29T22:51:15.519Z",
        messages: [
          ...initialMessages,
          geminiMsg("Reading file...", {
            timestamp: "2026-03-29T22:52:00.000Z",
            toolCalls: [{ name: "read_file", args: { file_path: "/tmp/foo" } }],
          }),
        ],
      }),
    );

    // Parser returns ALL events (old + new). DB dedup via UNIQUE constraint
    // on (session_id, source, event_type, timestamp_ms, tool_name) handles it.
    const secondParse = gemini.scanner!.parseFile(filePath, firstSize);
    expect(secondParse!.events).toHaveLength(3); // 2 old + 1 new
    const toolNames = secondParse!.events
      .filter((e) => e.eventType === "tool_call")
      .map((e) => e.toolName);
    expect(toolNames).toContain("list_directory");
    expect(toolNames).toContain("read_file");
  });

  it("sets firstPrompt from the user message", () => {
    const { filePath, cleanup } = makeTmpSession([
      userMsg("do a code review of my project"),
      geminiMsg("Sure, let me look at the code."),
    ]);
    cleanups.push(cleanup);

    const result = gemini.scanner!.parseFile(filePath, 0);
    expect(result!.meta!.firstPrompt).toBe("do a code review of my project");
  });

  it("includes token counts on assistant turns", () => {
    const { filePath, cleanup } = makeTmpSession([
      userMsg("hello"),
      geminiMsg("Hi!", {
        tokens: { input: 5000, output: 100, cached: 200, thoughts: 50 },
      }),
    ]);
    cleanups.push(cleanup);

    const result = gemini.scanner!.parseFile(filePath, 0);
    const assistantTurn = result!.turns[1];
    expect(assistantTurn.inputTokens).toBe(5000);
    expect(assistantTurn.outputTokens).toBe(100);
    expect(assistantTurn.cacheReadTokens).toBe(200);
    expect(assistantTurn.reasoningTokens).toBe(50);
  });
});
