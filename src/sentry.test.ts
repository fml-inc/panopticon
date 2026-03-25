import type * as Sentry from "@sentry/node";
import { describe, expect, it } from "vitest";
import { filterBreadcrumb, scrubEvent } from "./sentry.js";

function makeEvent(
  overrides: Partial<Sentry.ErrorEvent> = {},
): Sentry.ErrorEvent {
  return { event_id: "test-id", ...overrides } as Sentry.ErrorEvent;
}

describe("scrubEvent", () => {
  describe("breadcrumb data scrubbing", () => {
    it("scrubs prompt fields in breadcrumb data", () => {
      const event = makeEvent({
        breadcrumbs: [
          {
            category: "hooks",
            data: {
              prompt: "tell me your secrets",
              user_prompt: "my password is hunter2",
              session_id: "abc-123",
            },
          },
        ],
      });
      const result = scrubEvent(event)!;
      expect(result.breadcrumbs![0].data!.prompt).toBe("[scrubbed]");
      expect(result.breadcrumbs![0].data!.user_prompt).toBe("[scrubbed]");
      expect(result.breadcrumbs![0].data!.session_id).toBe("abc-123");
    });

    it("scrubs all sensitive breadcrumb fields", () => {
      const fields = [
        "prompt",
        "user_prompt",
        "content",
        "body",
        "command",
        "file_content",
        "stdin",
      ];
      for (const field of fields) {
        const event = makeEvent({
          breadcrumbs: [{ data: { [field]: "sensitive-value" } }],
        });
        const result = scrubEvent(event)!;
        expect(result.breadcrumbs![0].data![field]).toBe("[scrubbed]");
      }
    });

    it("scrubs authorization headers in breadcrumb data", () => {
      const event = makeEvent({
        breadcrumbs: [
          {
            data: {
              headers: {
                authorization: "Bearer sk-secret",
                "content-type": "application/json",
              },
            },
          },
        ],
      });
      const result = scrubEvent(event)!;
      const headers = result.breadcrumbs![0].data!.headers as Record<
        string,
        unknown
      >;
      expect(headers.authorization).toBe("[scrubbed]");
      expect(headers["content-type"]).toBe("application/json");
    });

    it("scrubs Authorization (capitalized) in breadcrumb data", () => {
      const event = makeEvent({
        breadcrumbs: [
          { data: { headers: { Authorization: "Bearer eyJtoken" } } },
        ],
      });
      const result = scrubEvent(event)!;
      const headers = result.breadcrumbs![0].data!.headers as Record<
        string,
        unknown
      >;
      expect(headers.Authorization).toBe("[scrubbed]");
    });

    it("handles breadcrumbs without data", () => {
      const event = makeEvent({
        breadcrumbs: [{ category: "http", message: "GET /health" }],
      });
      const result = scrubEvent(event)!;
      expect(result.breadcrumbs![0].data).toBeUndefined();
    });
  });

  describe("request header scrubbing", () => {
    it("removes authorization and cookie from request headers", () => {
      const event = makeEvent({
        request: {
          url: "http://localhost:4318/hooks",
          headers: {
            authorization: "Bearer secret",
            cookie: "session=abc",
            "content-type": "application/json",
          },
        },
      });
      const result = scrubEvent(event)!;
      expect(result.request!.headers!.authorization).toBeUndefined();
      expect(result.request!.headers!.cookie).toBeUndefined();
      expect(result.request!.headers!["content-type"]).toBe("application/json");
    });

    it("handles events without request", () => {
      const event = makeEvent({});
      expect(scrubEvent(event)).toBeTruthy();
    });
  });

  describe("stack frame variable scrubbing", () => {
    it("scrubs variables containing sensitive patterns", () => {
      const event = makeEvent({
        exception: {
          values: [
            {
              type: "Error",
              value: "test",
              stacktrace: {
                frames: [
                  {
                    filename: "test.ts",
                    vars: {
                      apiToken: "sk-secret-key",
                      userPrompt: "tell me something",
                      requestBody: '{"data": "value"}',
                      secretKey: "my-secret",
                      password: "hunter2",
                      sentryDsn: "https://abc@sentry.io/123",
                      normalVar: "safe-value",
                      count: 42,
                    },
                  },
                ],
              },
            },
          ],
        },
      });
      const result = scrubEvent(event)!;
      const vars = result.exception!.values![0].stacktrace!.frames![0].vars!;
      expect(vars.apiToken).toBe("[scrubbed]");
      expect(vars.userPrompt).toBe("[scrubbed]");
      expect(vars.requestBody).toBe("[scrubbed]");
      expect(vars.secretKey).toBe("[scrubbed]");
      expect(vars.password).toBe("[scrubbed]");
      expect(vars.sentryDsn).toBe("[scrubbed]");
      expect(vars.normalVar).toBe("safe-value");
      expect(vars.count).toBe(42);
    });

    it("handles frames without vars", () => {
      const event = makeEvent({
        exception: {
          values: [
            {
              type: "Error",
              value: "test",
              stacktrace: { frames: [{ filename: "test.ts" }] },
            },
          ],
        },
      });
      expect(scrubEvent(event)).toBeTruthy();
    });
  });
});

describe("filterBreadcrumb", () => {
  it("drops debug-level console breadcrumbs", () => {
    expect(
      filterBreadcrumb({
        category: "console",
        level: "debug",
        message: "sync log",
      }),
    ).toBeNull();
  });

  it("keeps non-debug console breadcrumbs", () => {
    const bc = { category: "console", level: "error" as const, message: "err" };
    expect(filterBreadcrumb(bc)).toBe(bc);
  });

  it("keeps info-level console breadcrumbs", () => {
    const bc = { category: "console", level: "info" as const, message: "info" };
    expect(filterBreadcrumb(bc)).toBe(bc);
  });

  it("drops successful HTTP breadcrumbs", () => {
    expect(
      filterBreadcrumb({
        category: "http",
        data: { status_code: 200, url: "http://localhost:14318/v1/logs" },
      }),
    ).toBeNull();
  });

  it("keeps failed HTTP breadcrumbs", () => {
    const bc = {
      category: "http",
      data: { status_code: 502, url: "http://localhost:14318/v1/logs" },
    };
    expect(filterBreadcrumb(bc)).toBe(bc);
  });

  it("keeps non-http/non-console breadcrumbs", () => {
    const bc = { category: "hooks", message: "SessionStart" };
    expect(filterBreadcrumb(bc)).toBe(bc);
  });
});
