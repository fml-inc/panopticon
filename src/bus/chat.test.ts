import { describe, expect, it, vi } from "vitest";
import type { AgentMessageRow } from "../db/bus.js";
import type { InstancesResult } from "../service/types.js";
import {
  type ChatDeps,
  formatAgo,
  formatMessage,
  formatPeerLiveness,
  runChatWait,
} from "./chat.js";

function msg(over: Partial<AgentMessageRow>): AgentMessageRow {
  return {
    id: 1,
    room: "r",
    from_session: "peer",
    to_session: null,
    kind: "chat",
    body: "hi",
    subject: null,
    ref_tool: null,
    ref_path: null,
    source: "chat",
    created_at_ms: 0,
    delivered_at_ms: null,
    ...over,
  };
}

function roster(
  insts: Array<{
    session_id: string;
    status?: string;
    role?: string | null;
    last_seen_ms?: number;
  }>,
): InstancesResult {
  return {
    now_ms: 0,
    room: "r",
    counts: { active: 0, idle: 0, exited: 0, total: insts.length },
    instances: insts.map((i) => ({
      status: "active",
      role: null,
      last_seen_ms: 0,
      ...i,
    })) as unknown as InstancesResult["instances"],
  };
}

describe("formatAgo", () => {
  it("renders sub-second, seconds, minutes, hours", () => {
    expect(formatAgo(500)).toBe("just now");
    expect(formatAgo(3000)).toBe("3s ago");
    expect(formatAgo(120_000)).toBe("2m ago");
    expect(formatAgo(7_200_000)).toBe("2h ago");
  });
});

describe("formatPeerLiveness", () => {
  it("excludes self, frenemy, and exited; summarizes the rest", () => {
    const line = formatPeerLiveness(
      roster([
        { session_id: "me-12345678", status: "active" },
        { session_id: "frenemy-1", role: "frenemy" },
        { session_id: "dead-1", status: "exited" },
        { session_id: "peer-abcdef00", status: "working", last_seen_ms: -3000 },
      ]),
      "me-12345678",
      0,
    );
    expect(line).toContain("peer-abc");
    expect(line).toContain("working");
    expect(line).not.toContain("frenemy");
    expect(line).not.toContain("dead-1");
    expect(line).not.toContain("me-12345");
  });

  it("reports when nobody else is present", () => {
    expect(formatPeerLiveness(roster([{ session_id: "me" }]), "me", 0)).toBe(
      "no other agents in the room",
    );
  });
});

describe("formatMessage", () => {
  it("marks directed mail and truncates the sender id", () => {
    expect(formatMessage(msg({ id: 7, from_session: "abcdef123456" }))).toBe(
      "#7 abcdef12: hi",
    );
    expect(formatMessage(msg({ to_session: "me" }))).toContain("(→ you)");
  });
});

describe("runChatWait", () => {
  const baseDeps = (over: Partial<ChatDeps>): ChatDeps => ({
    recv: vi.fn(async () => ({ room: "r", cursor: 0, messages: [] })),
    waitForActivity: vi.fn(async () => ({ activityMs: null, room: "r" })),
    busRoster: vi.fn(async () => roster([])),
    now: () => 0,
    onHeartbeat: vi.fn(),
    ...over,
  });

  it("returns unseen chat immediately (no tip race) and advances the cursor", async () => {
    const deps = baseDeps({
      recv: vi.fn(async () => ({
        room: "r",
        cursor: 5,
        messages: [msg({ id: 5, body: "ping" })],
      })),
    });
    const res = await runChatWait({ room: "r", sinceId: 0 }, deps);
    expect(res.timedOut).toBe(false);
    expect(res.messages.map((m) => m.body)).toEqual(["ping"]);
    expect(res.cursor).toBe(5);
    expect(deps.waitForActivity).not.toHaveBeenCalled();
  });

  it("blocks then times out, emitting a heartbeat", async () => {
    let clock = 0;
    const deps = baseDeps({
      now: () => {
        const v = clock;
        clock += 100;
        return v;
      },
    });
    const res = await runChatWait(
      // heartbeatMs: 0 forces a heartbeat each loop
      { room: "r", sinceId: 0, budgetMs: 250, longPollMs: 10, heartbeatMs: 0 },
      deps,
    );
    expect(res.timedOut).toBe(true);
    expect(res.messages).toEqual([]);
    expect(deps.waitForActivity).toHaveBeenCalled();
    expect(deps.onHeartbeat).toHaveBeenCalled();
  });
});
