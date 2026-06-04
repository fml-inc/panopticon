import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getTarget } from "./index.js";

const pi = getTarget("pi")!;
const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs)
    fs.rmSync(dir, { recursive: true, force: true });
});

function writePiSession(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-pi-scanner-"));
  cleanupDirs.push(dir);
  const filePath = path.join(dir, "20260518_session.jsonl");
  fs.writeFileSync(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  return filePath;
}

describe("pi scanner", () => {
  it("captures injected Pi skill usage from skill prompt messages", () => {
    const filePath = writePiSession([
      {
        type: "session",
        version: 3,
        id: "pi-skill-session",
        timestamp: "2026-05-18T10:00:00.000Z",
        cwd: "/workspace/example",
      },
      {
        type: "message",
        id: "u-skill",
        parentId: null,
        timestamp: "2026-05-18T10:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: '<skill name="panopticon-review" location="/home/node/.pi/agent/skills/panopticon-review/SKILL.md">\\n# PR Review\\n</skill>',
            },
          ],
        },
      },
    ]);

    const result = pi.scanner!.parseFile(filePath, 0)!;

    expect(result.messages[0].toolCalls[0]).toMatchObject({
      toolName: "Skill",
      skillName: "panopticon-review",
      inputJson: JSON.stringify({ skill: "panopticon-review" }),
    });
  });

  it("parses persisted Pi session messages, tool calls, tool results, and tokens", () => {
    const filePath = writePiSession([
      {
        type: "session",
        version: 3,
        id: "pi-session-1",
        timestamp: "2026-05-18T10:00:00.000Z",
        cwd: "/workspace/example",
      },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-05-18T10:00:01.000Z",
        message: { role: "user", content: "Please inspect README" },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-05-18T10:00:02.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [
            { type: "thinking", thinking: "Need to read first." },
            { type: "text", text: "I'll take a look." },
            {
              type: "toolCall",
              id: "tc-1",
              name: "read_file",
              arguments: { path: "README.md" },
            },
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 7,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
            total_tokens: 24,
          },
          timestamp: 1779098402000,
        },
      },
      {
        type: "message",
        id: "tr1",
        parentId: "a1",
        timestamp: "2026-05-18T10:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "read_file",
          content: [{ type: "text", text: "# Example" }],
          isError: false,
        },
      },
    ]);

    const result = pi.scanner!.parseFile(filePath, 0)!;

    expect(result.meta).toMatchObject({
      sessionId: "pi-session-1",
      cwd: "/workspace/example",
      firstPrompt: "Please inspect README",
      model: "claude-sonnet-4-5",
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      role: "user",
      content: "Please inspect README",
      ordinal: 0,
    });
    expect(result.messages[1].content).toContain("I'll take a look.");
    expect(result.messages[1].hasThinking).toBe(true);
    expect(result.messages[1].hasToolUse).toBe(true);
    expect(result.messages[1].contextTokens).toBe(17);
    expect(result.messages[1].outputTokens).toBe(7);
    expect(result.messages[1].toolCalls[0]).toMatchObject({
      toolUseId: "tc-1",
      toolName: "read_file",
      category: "Read",
      inputJson: JSON.stringify({ path: "README.md" }),
    });
    expect(result.orphanedToolResults?.get("tc-1")).toMatchObject({
      contentLength: 9,
      contentRaw: "# Example",
    });
    expect(result.events.map((event) => event.eventType)).toEqual([
      "tool_call",
      "tool_result",
    ]);
  });

  it("parses appended messages with chunk-relative ordinals on incremental reads", () => {
    const filePath = writePiSession([
      {
        type: "session",
        version: 3,
        id: "pi-incremental-session",
        timestamp: "2026-05-18T10:00:00.000Z",
        cwd: "/workspace/example",
      },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-05-18T10:00:01.000Z",
        message: { role: "user", content: "first" },
      },
    ]);

    const first = pi.scanner!.parseFile(filePath, 0)!;
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-05-18T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "second" }],
        },
      })}\n`,
    );

    const second = pi.scanner!.parseFile(filePath, first.newByteOffset)!;
    expect(second.meta?.sessionId).toBe("pi-incremental-session");
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({
      sessionId: "pi-incremental-session",
      ordinal: 0,
      role: "assistant",
      content: "second",
    });
  });

  it("uses chunk-relative incremental ordinals when messages omit ids", () => {
    const filePath = writePiSession([
      {
        type: "session",
        version: 3,
        id: "pi-incremental-no-ids",
        timestamp: "2026-05-18T10:00:00.000Z",
      },
      {
        type: "message",
        timestamp: "2026-05-18T10:00:01.000Z",
        message: { role: "user", content: "first" },
      },
    ]);

    const first = pi.scanner!.parseFile(filePath, 0)!;
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        type: "message",
        timestamp: "2026-05-18T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "second" }],
        },
      })}\n`,
    );

    const second = pi.scanner!.parseFile(filePath, first.newByteOffset)!;
    expect(second.messages[0]).toMatchObject({
      sessionId: "pi-incremental-no-ids",
      ordinal: 0,
      role: "assistant",
      content: "second",
    });
  });

  it("returns null without crashing when no new Pi log lines exist", () => {
    const filePath = writePiSession([]);
    expect(pi.scanner!.parseFile(filePath, 0)).toBeNull();
  });
});
