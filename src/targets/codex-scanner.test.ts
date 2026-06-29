import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getTarget } from "./index.js";

const codex = getTarget("codex")!;
const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs)
    fs.rmSync(dir, { recursive: true, force: true });
});

function writeCodexSession(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-codex-scanner-"));
  cleanupDirs.push(dir);
  const filePath = path.join(dir, "session.jsonl");
  fs.writeFileSync(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  return filePath;
}

describe("codex scanner", () => {
  it("captures persisted agent reasoning events as assistant thinking", () => {
    const filePath = writeCodexSession([
      {
        timestamp: "2026-05-24T15:45:59.000Z",
        type: "session_meta",
        payload: {
          id: "codex-reasoning-event-session",
          cwd: "/workspace/panopticon",
          timestamp: "2026-05-24T15:45:59.000Z",
        },
      },
      {
        timestamp: "2026-05-24T15:46:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_reasoning_raw_content",
          text: "Raw reasoning from the legacy event",
        },
      },
      {
        timestamp: "2026-05-24T15:46:01.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [],
          content: null,
          encrypted_content: "opaque",
        },
      },
      {
        timestamp: "2026-05-24T15:46:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 10,
              output_tokens: 2,
              cached_input_tokens: 0,
              reasoning_output_tokens: 3,
            },
          },
        },
      },
    ]);

    const result = codex.scanner!.parseFile(filePath, 0)!;

    expect(result.messages[0]).toMatchObject({
      role: "assistant",
      hasThinking: true,
    });
    expect(result.messages[0].content).toBe(
      "[Thinking]\nRaw reasoning from the legacy event\n[/Thinking]",
    );
    const rawReasoning = result.events.find(
      (event) => event.eventType === "reasoning_raw_content",
    );
    expect(rawReasoning?.content).toBe("Raw reasoning from the legacy event");
  });

  it("prefers raw reasoning item content over reasoning summaries", () => {
    const filePath = writeCodexSession([
      {
        timestamp: "2026-05-24T15:45:59.000Z",
        type: "session_meta",
        payload: {
          id: "codex-raw-reasoning-session",
          cwd: "/workspace/panopticon",
          timestamp: "2026-05-24T15:45:59.000Z",
        },
      },
      {
        timestamp: "2026-05-24T15:46:00.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Summary reasoning" }],
          content: [
            {
              type: "reasoning_text",
              text: "Raw reasoning from the response item",
            },
          ],
          encrypted_content: null,
        },
      },
      {
        timestamp: "2026-05-24T15:46:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 10,
              output_tokens: 2,
              cached_input_tokens: 0,
              reasoning_output_tokens: 3,
            },
          },
        },
      },
    ]);

    const result = codex.scanner!.parseFile(filePath, 0)!;

    expect(result.messages[0].content).toBe(
      "[Thinking]\nRaw reasoning from the response item\n[/Thinking]",
    );
    expect(
      result.events.find((event) => event.eventType === "reasoning"),
    ).toMatchObject({
      content: "Raw reasoning from the response item",
      metadata: {
        content_count: 1,
        summary_count: 1,
      },
    });
  });

  it("captures skill usage when Codex opens a SKILL.md file", () => {
    const skillPath = path.join(
      os.homedir(),
      ".codex",
      "skills",
      "panopticon-review",
      "SKILL.md",
    );
    const filePath = writeCodexSession([
      {
        timestamp: "2026-05-24T15:45:59.000Z",
        type: "session_meta",
        payload: {
          id: "codex-skill-session",
          cwd: "/workspace/panopticon",
          timestamp: "2026-05-24T15:45:59.000Z",
        },
      },
      {
        timestamp: "2026-05-24T15:46:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-skill",
          arguments: JSON.stringify({ cmd: `sed -n '1,120p' ${skillPath}` }),
        },
      },
      {
        timestamp: "2026-05-24T15:46:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-skill",
          output: "# PR Review\n",
        },
      },
      {
        timestamp: "2026-05-24T15:46:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 10,
              output_tokens: 2,
              cached_input_tokens: 0,
              reasoning_output_tokens: 0,
            },
          },
        },
      },
    ]);

    const result = codex.scanner!.parseFile(filePath, 0)!;

    expect(result.messages[0].toolCalls[0]).toMatchObject({
      toolName: "exec_command",
      skillName: "panopticon-review",
    });
  });

  it("handles common Codex skill path edge cases without overmatching", () => {
    const filePath = writeCodexSession([
      {
        timestamp: "2026-05-24T15:45:59.000Z",
        type: "session_meta",
        payload: {
          id: "codex-skill-edge-session",
          cwd: "/workspace/panopticon",
          timestamp: "2026-05-24T15:45:59.000Z",
        },
      },
      {
        timestamp: "2026-05-24T15:46:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-home",
          arguments: JSON.stringify({
            cmd: "cat $HOME/.codex/skills/review/SKILL.md",
          }),
        },
      },
      {
        timestamp: "2026-05-24T15:46:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-braced-home",
          arguments: JSON.stringify({
            cmd: "cat $" + "{HOME}/.codex/skills/plan/SKILL.md",
          }),
        },
      },
      {
        timestamp: "2026-05-24T15:46:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-system",
          arguments: JSON.stringify({
            cmd: "cat ~/.codex/skills/.system/SKILL.md",
          }),
        },
      },
      {
        timestamp: "2026-05-24T15:46:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "read_file",
          call_id: "call-read-file",
          arguments: JSON.stringify({
            path: "~/.codex/skills/not-a-command/SKILL.md",
          }),
        },
      },
      {
        timestamp: "2026-05-24T15:46:04.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-invalid-json",
          arguments: "not json",
        },
      },
      {
        timestamp: "2026-05-24T15:46:05.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 10,
              output_tokens: 2,
              cached_input_tokens: 0,
              reasoning_output_tokens: 0,
            },
          },
        },
      },
    ]);

    const result = codex.scanner!.parseFile(filePath, 0)!;

    expect(
      result.messages[0].toolCalls.map((toolCall) => toolCall.skillName),
    ).toEqual(["review", "plan", undefined, undefined, undefined]);
  });
});
