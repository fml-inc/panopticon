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

  it("round-trips reply_to and defaults it to null", () => {
    const challengeId = insertAgentMessage(base({ body: "challenge" }));
    insertAgentMessage(base({ body: "resolution", reply_to: challengeId }));
    const msgs = readAgentMessages({ room: "fml-inc/panopticon" });
    expect(msgs.map((m) => [m.body, m.reply_to])).toEqual([
      ["challenge", null],
      ["resolution", challengeId],
    ]);
  });

  it("without a cursor, returns the NEWEST N in ascending order", () => {
    for (const b of ["m1", "m2", "m3", "m4", "m5"]) {
      insertAgentMessage(base({ body: b }));
    }
    // Newest 2 messages, oldest-first within the page.
    const msgs = readAgentMessages({ room: "fml-inc/panopticon", limit: 2 });
    expect(msgs.map((m) => m.body)).toEqual(["m4", "m5"]);
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

  it("filters history by sender and subject prefixes", () => {
    insertAgentMessage(
      base({
        from_session: "frenemy",
        kind: "challenge",
        body: "open",
        subject: "review:src/a.ts#1111",
      }),
    );
    insertAgentMessage(
      base({
        from_session: "frenemy",
        kind: "challenge",
        body: "closed",
        subject: "resolved:src/a.ts#2222",
      }),
    );
    insertAgentMessage(
      base({
        from_session: "teammate",
        kind: "challenge",
        body: "not frenemy",
        subject: "review:src/a.ts#3333",
      }),
    );
    insertAgentMessage(
      base({
        from_session: "frenemy",
        kind: "challenge",
        body: "not lifecycle",
        subject: "path:src/a.ts",
      }),
    );

    const msgs = readAgentMessages({
      room: "fml-inc/panopticon",
      fromSession: "frenemy",
      kinds: ["challenge"],
      subjectPrefixes: ["review:", "resolved:"],
    });
    expect(msgs.map((m) => m.body)).toEqual(["open", "closed"]);
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

  it("broadcast fans out: each session drains it once, independently", () => {
    const id = insertAgentMessage(base({ kind: "chat", body: "hello room" }));

    // Both sessions see it as undelivered-to-them.
    expect(
      readAgentMessages({
        room: "fml-inc/panopticon",
        undeliveredTo: "alice",
      }).map((m) => m.body),
    ).toEqual(["hello room"]);
    expect(
      readAgentMessages({
        room: "fml-inc/panopticon",
        undeliveredTo: "bob",
      }).map((m) => m.body),
    ).toEqual(["hello room"]);

    // Alice consumes it — only for Alice.
    expect(markDelivered([id], "alice", 2000)).toBe(1);
    expect(
      readAgentMessages({ room: "fml-inc/panopticon", undeliveredTo: "alice" }),
    ).toHaveLength(0);
    // Bob still has it pending.
    expect(
      readAgentMessages({
        room: "fml-inc/panopticon",
        undeliveredTo: "bob",
      }).map((m) => m.body),
    ).toEqual(["hello room"]);

    // Bob consumes it; re-marking for either session is a no-op.
    expect(markDelivered([id], "bob", 2000)).toBe(1);
    expect(markDelivered([id], "alice", 3000)).toBe(0);
    expect(
      readAgentMessages({ room: "fml-inc/panopticon", undeliveredTo: "bob" }),
    ).toHaveLength(0);
  });

  it("directed message is only pending for its addressee", () => {
    insertAgentMessage(base({ to_session: "alice", body: "for alice" }));
    expect(
      readAgentMessages({
        room: "fml-inc/panopticon",
        toSession: "alice",
        undeliveredTo: "alice",
      }).map((m) => m.body),
    ).toEqual(["for alice"]);
    expect(
      readAgentMessages({
        room: "fml-inc/panopticon",
        toSession: "bob",
        undeliveredTo: "bob",
      }),
    ).toHaveLength(0);
  });

  it("sinceMs excludes messages created before a reader joined", () => {
    insertAgentMessage(base({ body: "old", created_at_ms: 1000 }));
    insertAgentMessage(base({ body: "new", created_at_ms: 5000 }));
    expect(
      readAgentMessages({
        room: "fml-inc/panopticon",
        undeliveredTo: "late",
        sinceMs: 3000,
      }).map((m) => m.body),
    ).toEqual(["new"]);
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
