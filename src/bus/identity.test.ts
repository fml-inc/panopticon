import { describe, expect, it } from "vitest";
import { resolveSelfIdentity, type SelfIdentity } from "./identity.js";

describe("resolveSelfIdentity", () => {
  // A toy process tree: cli(100) -> shell(101) -> agent(102).
  const parents: Record<number, number> = { 100: 101, 101: 102, 102: 1 };
  const sessions: Record<number, SelfIdentity> = {
    102: { sessionId: "s-agent", cwd: "/repo", name: "worker" },
  };

  const deps = {
    parent: (pid: number) => parents[pid] ?? null,
    readSession: (pid: number) => sessions[pid] ?? null,
  };

  it("walks past the shell to the agent's session file", () => {
    expect(resolveSelfIdentity({ startPid: 100, ...deps })).toEqual({
      sessionId: "s-agent",
      cwd: "/repo",
      name: "worker",
    });
  });

  it("returns {} when no ancestor has a session", () => {
    expect(
      resolveSelfIdentity({
        startPid: 100,
        parent: deps.parent,
        readSession: () => null,
      }),
    ).toEqual({});
  });

  it("stops at maxLevels without finding one", () => {
    expect(
      resolveSelfIdentity({ startPid: 100, ...deps, maxLevels: 1 }),
    ).toEqual({});
  });

  it("takes the nearest ancestor session when several match", () => {
    const closer: Record<number, SelfIdentity> = {
      ...sessions,
      101: { sessionId: "s-shell-owner" },
    };
    expect(
      resolveSelfIdentity({
        startPid: 100,
        parent: deps.parent,
        readSession: (pid: number) => closer[pid] ?? null,
      }).sessionId,
    ).toBe("s-shell-owner");
  });
});
