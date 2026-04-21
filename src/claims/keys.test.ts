import { describe, expect, it } from "vitest";
import {
  editKey,
  hookEventSyncEvidenceKey,
  intentKey,
  messageEvidenceKey,
  messageSyncEvidenceKey,
  semanticEditIdentity,
  toolCallSyncEvidenceKey,
  toolEvidenceKey,
  toolLocalEvidenceKey,
} from "./keys.js";

describe("intentKey", () => {
  it("prefers stable user index when present, even if a uuid exists", () => {
    expect(
      intentKey({
        sessionId: "session-1",
        ordinal: 7,
        userIndex: 3,
        uuid: "msg-uuid",
      }),
    ).toBe("intent:session-1:user:3");
  });

  it("falls back to uuid when there is no user index", () => {
    expect(
      intentKey({
        sessionId: "session-1",
        ordinal: 7,
        uuid: "msg-uuid",
      }),
    ).toBe("intent:msg-uuid");
  });

  it("falls back to ordinal when no uuid or user index exists", () => {
    expect(
      intentKey({
        sessionId: "session-1",
        ordinal: 7,
      }),
    ).toBe("intent:session-1:7");
  });
});

describe("editKey", () => {
  it("prefers tool_use_id and preserves multi-edit suffixes", () => {
    expect(
      editKey({
        intentKey: "intent:session-1:user:3",
        toolCallIndex: 2,
        toolUseId: "tool-123",
        multiEditIndex: 1,
      }),
    ).toBe("edit:tool-123:1");
  });

  it("falls back to per-intent tool-call index when tool_use_id is missing", () => {
    expect(
      editKey({
        intentKey: "intent:session-1:user:3",
        toolCallIndex: 2,
      }),
    ).toBe("edit:intent:session-1:user:3:tool:2");
  });

  it("supports semantic fallback keys for mixed-source edit convergence", () => {
    const semanticIdentity = semanticEditIdentity({
      filePath: "/tmp/example.ts",
      newString: "NEXT",
      oldStrings: ["PREV"],
      deletedFile: false,
    });

    expect(
      editKey({
        intentKey: "intent:session-1:user:3",
        semanticIdentity,
        semanticOccurrence: 1,
      }),
    ).toMatch(/^edit:intent:session-1:user:3:sem:[0-9a-f]{64}:1$/);
  });

  it("falls back to hook event id when no stronger key exists", () => {
    expect(
      editKey({
        sessionId: "session-1",
        hookEventId: 44,
      }),
    ).toBe("edit:hook:44");
  });
});

describe("evidence key helpers", () => {
  it("formats stable evidence keys", () => {
    expect(messageEvidenceKey("session-1", 5)).toBe("message:session-1:5");
    expect(messageSyncEvidenceKey("msg-sync-1")).toBe("msg:msg-sync-1");
    expect(toolEvidenceKey("tool-123")).toBe("tool:tool-123");
    expect(toolCallSyncEvidenceKey("tc-sync-1")).toBe("tc:tc-sync-1");
    expect(toolLocalEvidenceKey("session-1", 9, 2)).toBe(
      "tool_local:session-1:9:2",
    );
    expect(hookEventSyncEvidenceKey("hook-sync-1")).toBe(
      "hook_event:hook-sync-1",
    );
  });
});
