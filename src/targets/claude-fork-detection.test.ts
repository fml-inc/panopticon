import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getTarget } from "./registry.js";
import "./claude.js";

const SESSION_ID = "fork-false-positive-test";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeFixture(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-claude-fork-"));
  tmpDirs.push(dir);
  const filePath = path.join(dir, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  return filePath;
}

function userLine(uuid: string, parentUuid: string, text: string) {
  return {
    type: "user",
    sessionId: SESSION_ID,
    uuid,
    parentUuid,
    timestamp: "2026-04-01T10:00:00.000Z",
    message: { content: [{ type: "text", text }] },
  };
}

function assistantLine(uuid: string, parentUuid: string, text: string) {
  return {
    type: "assistant",
    sessionId: SESSION_ID,
    uuid,
    parentUuid,
    timestamp: "2026-04-01T10:00:01.000Z",
    message: {
      model: "claude-opus-4-7",
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
    },
  };
}

function toolUseAssistantLine(
  uuid: string,
  parentUuid: string,
  toolUseId: string,
) {
  return {
    type: "assistant",
    sessionId: SESSION_ID,
    uuid,
    parentUuid,
    timestamp: "2026-04-01T10:00:01.000Z",
    message: {
      model: "claude-opus-4-7",
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Read",
          input: { file_path: "/tmp/example.ts" },
        },
      ],
    },
  };
}

function toolResultUserLine(
  uuid: string,
  parentUuid: string,
  toolUseId: string,
) {
  return {
    type: "user",
    sessionId: SESSION_ID,
    uuid,
    parentUuid,
    timestamp: "2026-04-01T10:00:02.000Z",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: "tool output",
          is_error: false,
        },
      ],
    },
  };
}

function systemLine(uuid: string, parentUuid: string, content: string) {
  return {
    type: "system",
    sessionId: SESSION_ID,
    uuid,
    parentUuid,
    timestamp: "2026-04-01T10:00:00.500Z",
    content,
  };
}

function attachmentLine(uuid: string, parentUuid: string) {
  return {
    type: "attachment",
    sessionId: SESSION_ID,
    uuid,
    parentUuid,
    timestamp: "2026-04-01T10:00:00.250Z",
    attachment: { type: "image" },
  };
}

describe("claude DAG fork detection with intermediate lines", () => {
  const claude = getTarget("claude");
  if (!claude?.scanner) throw new Error("claude scanner not registered");
  const parseFile = claude.scanner.parseFile.bind(claude.scanner);

  it("does not request a full reparse for a linear conversation with system and attachment lines", () => {
    const filePath = writeFixture([
      userLine("u1", "", "first user prompt"),
      attachmentLine("a1", "u1"),
      assistantLine("asst1", "a1", "assistant reply"),
      systemLine("s1", "asst1", "<command>/clear</command>"),
      userLine("u2", "s1", "second user prompt"),
      assistantLine("asst2", "u2", "second reply"),
    ]);

    const fileSize = fs.statSync(filePath).size;
    const result = parseFile(filePath, 0);
    expect(result).not.toBeNull();
    expect(result!.needsFullReparse).toBeFalsy();

    const halfwayResult = parseFile(filePath, Math.floor(fileSize / 2));
    if (halfwayResult) {
      expect(halfwayResult.needsFullReparse).toBeFalsy();
    }
  });

  it("still handles an actual fork on a full parse", () => {
    const filePath = writeFixture([
      userLine("u1", "", "prompt"),
      assistantLine("asst1", "u1", "reply"),
      userLine("u2a", "asst1", "branch a"),
      assistantLine("asst2a", "u2a", "branch a reply"),
      userLine("u3a", "asst2a", "branch a continued"),
      assistantLine("asst3a", "u3a", "branch a reply 2"),
      userLine("u4a", "asst3a", "branch a continued again"),
      assistantLine("asst4a", "u4a", "branch a reply 3"),
      userLine("u5a", "asst4a", "branch a long enough to split"),
      assistantLine("asst5a", "u5a", "branch a reply 4"),
      userLine("u2b", "asst1", "branch b"),
      assistantLine("asst2b", "u2b", "branch b reply"),
    ]);

    const result = parseFile(filePath, 0);
    expect(result).not.toBeNull();
    expect(result!.needsFullReparse).toBeFalsy();
    expect(result!.forks?.length ?? 0).toBeGreaterThan(0);
  });

  it("does not split parallel tool results into fork sessions", () => {
    const filePath = writeFixture([
      userLine("u1", "", "inspect these files"),
      assistantLine("asst1", "u1", "I will read them."),
      toolUseAssistantLine("tool-use-1", "asst1", "tool-1"),
      toolUseAssistantLine("tool-use-2", "tool-use-1", "tool-2"),
      toolUseAssistantLine("tool-use-3", "tool-use-2", "tool-3"),
      toolUseAssistantLine("tool-use-4", "tool-use-3", "tool-4"),
      toolResultUserLine("tool-result-1", "tool-use-1", "tool-1"),
      toolResultUserLine("tool-result-2", "tool-use-2", "tool-2"),
      toolResultUserLine("tool-result-3", "tool-use-3", "tool-3"),
      toolResultUserLine("tool-result-4", "tool-use-4", "tool-4"),
      assistantLine("asst2", "tool-result-4", "done reading."),
    ]);

    const result = parseFile(filePath, 0);
    expect(result).not.toBeNull();
    expect(result!.needsFullReparse).toBeFalsy();
    expect(result!.forks ?? []).toHaveLength(0);
    expect(result!.messages.map((m) => m.uuid)).toContain("asst2");
  });

  it("compresses stacked intermediate lines without dropping conversation messages", () => {
    const lines: object[] = [];
    let prev = "u0";
    lines.push(userLine("u0", "", "root"));
    for (let i = 0; i < 5; i++) {
      const turn = i + 1;
      for (let j = 0; j < 5; j++) {
        const uid = `int-${turn}-${j}`;
        lines.push(systemLine(uid, prev, `intermediate ${turn}-${j}`));
        prev = uid;
      }
      const aid = `asst-${turn}`;
      lines.push(assistantLine(aid, prev, `reply ${turn}`));
      prev = aid;
      const uid = `u-${turn}`;
      lines.push(userLine(uid, prev, `user ${turn}`));
      prev = uid;
    }

    const result = parseFile(writeFixture(lines), 0);
    expect(result).not.toBeNull();
    expect(result!.needsFullReparse).toBeFalsy();
    expect(result!.forks ?? []).toHaveLength(0);
    expect(result!.messages.length).toBe(11);
  });
});
