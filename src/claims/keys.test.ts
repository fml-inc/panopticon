import { describe, expect, it } from "vitest";
import {
  editKey,
  intentKey,
  messageEvidenceKey,
  toolEvidenceKey,
  toolLocalEvidenceKey,
} from "./keys.js";

describe("intentKey", () => {
  it("prefers message uuid when present", () => {
    expect(
      intentKey({
        sessionId: "session-1",
        ordinal: 7,
        userIndex: 3,
        uuid: "msg-uuid",
      }),
    ).toBe("intent:msg-uuid");
  });

  it("falls back to stable user index before ordinal", () => {
    expect(
      intentKey({
        sessionId: "session-1",
        ordinal: 7,
        userIndex: 3,
      }),
    ).toBe("intent:session-1:user:3");
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
        sessionId: "session-1",
        assistantOrdinal: 9,
        toolCallIndex: 2,
        toolUseId: "tool-123",
        multiEditIndex: 1,
      }),
    ).toBe("edit:tool-123:1");
  });

  it("falls back to hook event id when tool_use_id is missing", () => {
    expect(
      editKey({
        sessionId: "session-1",
        assistantOrdinal: 9,
        toolCallIndex: 2,
        hookEventId: 44,
      }),
    ).toBe("edit:hook:44");
  });

  it("falls back to assistant ordinal and tool-call index otherwise", () => {
    expect(
      editKey({
        sessionId: "session-1",
        assistantOrdinal: 9,
        toolCallIndex: 2,
      }),
    ).toBe("edit:session-1:9:2");
  });
});

describe("evidence key helpers", () => {
  it("formats stable evidence keys", () => {
    expect(messageEvidenceKey("session-1", 5)).toBe("message:session-1:5");
    expect(toolEvidenceKey("tool-123")).toBe("tool:tool-123");
    expect(toolLocalEvidenceKey("session-1", 9, 2)).toBe(
      "tool_local:session-1:9:2",
    );
  });
});
