import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

type Handler = (event: any, ctx?: any) => Promise<void> | void;

function onceListening(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

afterEach(() => {
  vi.resetModules();
  delete process.env.PANOPTICON_HOST;
  delete process.env.PANOPTICON_PORT;
  delete process.env.PANOPTICON_AUTH_TOKEN;
  delete process.env.PANOPTICON_PI_SHUTDOWN_FLUSH_TIMEOUT_MS;
  delete process.env.PANOPTICON_PI_REQUEST_TIMEOUT_MS;
});

describe("Pi extension shutdown delivery", () => {
  it("awaits in-flight hook POSTs during session_shutdown", async () => {
    const received: string[] = [];
    const sessionIds: string[] = [];
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });

    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const payload = JSON.parse(body);
        received.push(payload.hook_event_name);
        sessionIds.push(payload.session_id);
        responseGate.then(() => {
          res.statusCode = 204;
          res.end();
        });
      });
    });

    const port = await onceListening(server);
    process.env.PANOPTICON_HOST = "127.0.0.1";
    process.env.PANOPTICON_PORT = String(port);
    process.env.PANOPTICON_AUTH_TOKEN = "test-token";
    process.env.PANOPTICON_PI_SHUTDOWN_FLUSH_TIMEOUT_MS = "1000";

    try {
      const { default: install, __panopticonPiExtensionTest } = await import(
        "./extension.js"
      );
      const handlers = new Map<string, Handler>();
      install({
        on: (name: string, handler: Handler) => handlers.set(name, handler),
      } as any);

      await handlers.get("session_start")?.(
        {},
        {
          cwd: process.cwd(),
          sessionManager: { getSessionId: () => "pi-real-session-id" },
        },
      );
      await handlers.get("input")?.({ text: "hello from headless" });

      const shutdown = handlers.get("session_shutdown")?.({});
      await vi.waitFor(() => {
        expect(received).toContain("SessionEnd");
        expect(__panopticonPiExtensionTest.pendingPostCount()).toBeGreaterThan(
          0,
        );
      });

      releaseResponse();
      await shutdown;
      expect(received).toEqual([
        "SessionStart",
        "UserPromptSubmit",
        "SessionEnd",
      ]);
      expect(new Set(sessionIds)).toEqual(new Set(["pi-real-session-id"]));
      expect(__panopticonPiExtensionTest.pendingPostCount()).toBe(0);
    } finally {
      releaseResponse();
      await closeServer(server);
    }
  });
});
