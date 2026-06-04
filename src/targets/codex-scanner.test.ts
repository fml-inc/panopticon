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
});
