import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testPaths = vi.hoisted(() => {
  const dataDir = `/tmp/panopticon-bus-test-${process.pid}`;
  return { dataDir, dbPath: `${dataDir}/panopticon.db` };
});

vi.mock("../config.js", () => ({
  config: { dataDir: testPaths.dataDir, dbPath: testPaths.dbPath },
}));

import {
  type AgentMessageInsert,
  insertAgentMessage,
  markDelivered,
  readAgentMessages,
} from "./bus.js";
import { closeDb, getDb } from "./schema.js";

function base(overrides: Partial<AgentMessageInsert> = {}): AgentMessageInsert {
  return {
    room: "fml-inc/panopticon",
    from_session: "a",
    kind: "chat",
    body: "hello",
    created_at_ms: 1000,
    ...overrides,
  };
}

describe("agent message bus store", () => {
  beforeEach(() => {
    fs.mkdirSync(testPaths.dataDir, { recursive: true });
    getDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
  });

  it("inserts and reads back messages in id order", () => {
    insertAgentMessage(base({ body: "one" }));
    insertAgentMessage(base({ body: "two" }));
    const msgs = readAgentMessages({ room: "fml-inc/panopticon" });
    expect(msgs.map((m) => m.body)).toEqual(["one", "two"]);
  });

  it("scopes reads by room", () => {
    insertAgentMessage(base({ room: "repo:one", body: "x" }));
    insertAgentMessage(base({ room: "repo:two", body: "y" }));
    const msgs = readAgentMessages({ room: "repo:one" });
    expect(msgs.map((m) => m.body)).toEqual(["x"]);
  });

  it("filters by kind", () => {
    insertAgentMessage(base({ kind: "activity", body: "act" }));
    insertAgentMessage(base({ kind: "challenge", body: "chal" }));
    const msgs = readAgentMessages({
      room: "fml-inc/panopticon",
      kinds: ["challenge"],
    });
    expect(msgs.map((m) => m.body)).toEqual(["chal"]);
  });

  it("advances by sinceId cursor", () => {
    const id1 = insertAgentMessage(base({ body: "one" }));
    insertAgentMessage(base({ body: "two" }));
    const msgs = readAgentMessages({
      room: "fml-inc/panopticon",
      sinceId: id1,
    });
    expect(msgs.map((m) => m.body)).toEqual(["two"]);
  });

  it("address filter returns broadcasts and messages to the session, not others", () => {
    insertAgentMessage(base({ to_session: null, body: "broadcast" }));
    insertAgentMessage(base({ to_session: "me", body: "for-me" }));
    insertAgentMessage(base({ to_session: "someone-else", body: "not-mine" }));
    const msgs = readAgentMessages({
      room: "fml-inc/panopticon",
      toSession: "me",
    });
    expect(msgs.map((m) => m.body)).toEqual(["broadcast", "for-me"]);
  });

  it("excludeFrom hides the reader's own messages", () => {
    insertAgentMessage(base({ from_session: "me", body: "mine" }));
    insertAgentMessage(base({ from_session: "other", body: "theirs" }));
    const msgs = readAgentMessages({
      room: "fml-inc/panopticon",
      excludeFrom: "me",
    });
    expect(msgs.map((m) => m.body)).toEqual(["theirs"]);
  });

  it("undeliveredOnly + markDelivered implements consume-once", () => {
    const id1 = insertAgentMessage(base({ kind: "challenge", body: "c1" }));
    insertAgentMessage(base({ kind: "challenge", body: "c2" }));

    let pending = readAgentMessages({
      room: "fml-inc/panopticon",
      undeliveredOnly: true,
    });
    expect(pending).toHaveLength(2);

    const changed = markDelivered([id1], 2000);
    expect(changed).toBe(1);

    pending = readAgentMessages({
      room: "fml-inc/panopticon",
      undeliveredOnly: true,
    });
    expect(pending.map((m) => m.body)).toEqual(["c2"]);

    // Re-marking an already-delivered id is a no-op.
    expect(markDelivered([id1], 3000)).toBe(0);
  });

  it("persists subject/ref_path/source and caps the limit", () => {
    insertAgentMessage(
      base({
        subject: "path:src/auth.ts",
        ref_path: "src/auth.ts",
        source: "fs",
      }),
    );
    const [msg] = readAgentMessages({ room: "fml-inc/panopticon" });
    expect(msg.subject).toBe("path:src/auth.ts");
    expect(msg.ref_path).toBe("src/auth.ts");
    expect(msg.source).toBe("fs");

    for (let i = 0; i < 5; i++) insertAgentMessage(base());
    expect(
      readAgentMessages({ room: "fml-inc/panopticon", limit: 2 }),
    ).toHaveLength(2);
  });
});
