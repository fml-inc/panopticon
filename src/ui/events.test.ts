import type http from "node:http";
import { describe, expect, it } from "vitest";
import {
  addClient,
  broadcast,
  clientCount,
  hasClients,
  removeClient,
} from "./events.js";

/** Minimal SSE response double that records the frames written to it. */
function fakeClient(opts: { throwOnWrite?: boolean } = {}) {
  const frames: string[] = [];
  const res = {
    frames,
    write(chunk: string) {
      if (opts.throwOnWrite) throw new Error("socket closed");
      frames.push(chunk);
      return true;
    },
  };
  return res as unknown as http.ServerResponse & { frames: string[] };
}

describe("ui/events broadcaster", () => {
  it("reports no clients and does not throw when empty", () => {
    expect(hasClients()).toBe(false);
    expect(() =>
      broadcast({ type: "instance", data: {} as never }),
    ).not.toThrow();
  });

  it("delivers a named SSE frame to a registered client", () => {
    const client = fakeClient();
    addClient(client);
    expect(hasClients()).toBe(true);

    broadcast({
      type: "instance",
      data: { session_id: "s1", status: "active" } as never,
    });

    expect(client.frames).toHaveLength(1);
    expect(client.frames[0]).toContain("event: instance\n");
    expect(client.frames[0]).toContain('"session_id":"s1"');
    expect(client.frames[0].endsWith("\n\n")).toBe(true);

    removeClient(client);
    expect(hasClients()).toBe(false);
  });

  it("stops delivering after removeClient", () => {
    const client = fakeClient();
    addClient(client);
    removeClient(client);
    broadcast({ type: "message", data: { kind: "challenge" } });
    expect(client.frames).toHaveLength(0);
  });

  it("prunes a client whose write throws", () => {
    const good = fakeClient();
    const bad = fakeClient({ throwOnWrite: true });
    addClient(good);
    addClient(bad);
    expect(clientCount()).toBe(2);

    broadcast({ type: "message", data: { kind: "activity" } });

    // The throwing client is dropped; the healthy one still received the frame.
    expect(clientCount()).toBe(1);
    expect(good.frames).toHaveLength(1);

    removeClient(good);
  });
});
