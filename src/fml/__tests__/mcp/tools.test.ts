import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createDirectPanopticonServiceMock,
  getAuthenticatedClientMock,
  captureExceptionMock,
  serviceMock,
} = vi.hoisted(() => {
  const service = {
    activitySummary: vi.fn(),
    listSessions: vi.fn(),
    sessionTimeline: vi.fn(),
    hookTimeline: vi.fn(),
    costBreakdown: vi.fn(),
    listPlans: vi.fn(),
    search: vi.fn(),
    print: vi.fn(),
    rawQuery: vi.fn(),
    intentForCode: vi.fn(),
    searchIntent: vi.fn(),
    outcomesForIntent: vi.fn(),
    listSessionSummaries: vi.fn(),
    sessionSummaryDetail: vi.fn(),
    whyCode: vi.fn(),
    recentWorkOnPath: vi.fn(),
    fileOverview: vi.fn(),
  };

  return {
    createDirectPanopticonServiceMock: vi.fn(() => service),
    getAuthenticatedClientMock: vi.fn(),
    captureExceptionMock: vi.fn(),
    serviceMock: service,
  };
});

vi.mock("../../../service/direct.js", () => ({
  createDirectPanopticonService: createDirectPanopticonServiceMock,
}));

vi.mock("../../../repo.js", () => ({
  resolveRepoFromCwd: vi.fn(() => ({ repo: "fml-inc/panopticon" })),
}));

vi.mock("../../auth/token-store.js", () => ({
  getSelectedOrg: vi.fn(() => "fml-inc"),
  getValidToken: vi.fn(),
  readTokens: vi.fn(() => null),
}));

vi.mock("../../fml-client.js", () => ({
  createFmlClient: vi.fn(),
  getAuthenticatedClient: (...args: unknown[]) =>
    getAuthenticatedClientMock(...args),
}));

vi.mock("../../sentry.js", () => ({
  Sentry: { captureException: captureExceptionMock },
}));

import { registerTools } from "../../mcp/tools.js";

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<ToolResult> | ToolResult;

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface RegisteredTool {
  description: string;
  schema: Record<string, unknown>;
  handler: ToolHandler;
}

function fakeServer() {
  const tools = new Map<string, RegisteredTool>();
  return {
    server: {
      tool: vi.fn(
        (
          name: string,
          description: string,
          schema: Record<string, unknown>,
          handler: ToolHandler,
        ) => {
          tools.set(name, { description, schema, handler });
        },
      ),
    },
    tools,
  };
}

function registerFakeTools() {
  const { server, tools } = fakeServer();
  registerTools(server as never);
  return { server, tools };
}

function parseTextResult(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe("FML MCP local data tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers FML-prefixed local read tools", () => {
    const { tools } = registerFakeTools();

    expect([...tools.keys()]).toEqual(
      expect.arrayContaining([
        "fml_local_activity",
        "fml_local_sessions",
        "fml_local_timeline",
        "fml_local_hook_timeline",
        "fml_local_spending",
        "fml_local_plans",
        "fml_local_search",
        "fml_local_get",
        "fml_local_query",
        "fml_local_intent_for_code",
        "fml_local_search_intent",
        "fml_local_outcomes_for_intent",
        "fml_local_session_summaries",
        "fml_local_session_summary_detail",
        "fml_local_why_code",
        "fml_local_recent_work_on_path",
        "fml_local_file_overview",
      ]),
    );
  });

  it("routes local sessions through the direct local service", async () => {
    const { tools } = registerFakeTools();
    serviceMock.listSessions.mockResolvedValue({
      sessions: [{ sessionId: "session-1" }],
      totalCount: 1,
      source: "local",
    });

    const result = await tools
      .get("fml_local_sessions")
      ?.handler({ since: "24h", limit: 5 });

    expect(createDirectPanopticonServiceMock).toHaveBeenCalledOnce();
    expect(serviceMock.listSessions).toHaveBeenCalledWith({
      since: "24h",
      limit: 5,
    });
    expect(parseTextResult(result as ToolResult)).toEqual({
      sessions: [{ sessionId: "session-1" }],
      totalCount: 1,
      source: "local",
    });
  });

  it("maps timeline pagination and full-payload options", async () => {
    const { tools } = registerFakeTools();
    serviceMock.sessionTimeline.mockResolvedValue({
      session: { sessionId: "session-1" },
      messages: [],
      totalMessages: 0,
      hasMore: false,
      source: "local",
    });

    await tools.get("fml_local_timeline")?.handler({
      sessionId: "session-1",
      limit: 20,
      offset: 10,
      fullPayloads: true,
    });

    expect(serviceMock.sessionTimeline).toHaveBeenCalledWith({
      sessionId: "session-1",
      limit: 20,
      offset: 10,
      fullPayloads: true,
    });
  });

  it("maps local provenance tools to the direct service", async () => {
    const { tools } = registerFakeTools();
    serviceMock.fileOverview.mockResolvedValue({ path: "src/fml/cli.ts" });

    await tools.get("fml_local_file_overview")?.handler({
      path: "src/fml/cli.ts",
      repository: "/repo",
      recent_limit: 3,
      related_limit: 4,
    });

    expect(serviceMock.fileOverview).toHaveBeenCalledWith({
      path: "src/fml/cli.ts",
      repository: "/repo",
      recent_limit: 3,
      related_limit: 4,
    });
  });

  it("surfaces local service failures as MCP errors", async () => {
    const { tools } = registerFakeTools();
    serviceMock.rawQuery.mockRejectedValue(new Error("Only SELECT allowed"));

    const result = (await tools
      .get("fml_local_query")
      ?.handler({ sql: "DELETE FROM sessions" })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Local FML data error");
    expect(result.content[0].text).toContain("Only SELECT allowed");
    expect(captureExceptionMock).toHaveBeenCalledOnce();
  });

  it("points cloud auth failures at FML local tools, not Panopticon MCP", async () => {
    const { tools } = registerFakeTools();
    getAuthenticatedClientMock.mockResolvedValue(null);

    const result = (await tools
      .get("get_ai_spending")
      ?.handler({ timeRange: "7d" })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("fml login");
    expect(result.content[0].text).toContain("fml_local_sessions");
    expect(result.content[0].text).not.toContain("panopticon MCP");
  });
});
