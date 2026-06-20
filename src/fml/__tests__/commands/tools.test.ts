import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockListTools = vi.fn();
const mockCallBackend = vi.fn();
const mockGetAuthenticatedClient = vi.fn();

vi.mock("../../fml-client.js", () => ({
  getAuthenticatedClient: (...args: unknown[]) =>
    mockGetAuthenticatedClient(...args),
}));

import {
  handleToolsCall,
  handleToolsDescribe,
  handleToolsList,
} from "../../commands/tools.js";

const DESCRIPTORS = [
  {
    name: "integration-github",
    description: "Query the GitHub integration",
    inputSchema: {
      type: "object",
      properties: { endpoint: { type: "string" } },
      required: ["endpoint"],
      additionalProperties: false,
    },
    category: "integrations",
    experimental: false,
  },
  {
    name: "list-integrations",
    description: "List connected integrations",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    category: "integrations",
    experimental: false,
  },
  {
    name: "run-experimental",
    description: "An experimental feature",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    category: "analysis",
    experimental: true,
  },
];

describe("handleToolsList", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`process.exit(${_code})`);
      });
    mockGetAuthenticatedClient.mockResolvedValue({
      listTools: mockListTools,
      callBackend: mockCallBackend,
    });
    mockListTools.mockResolvedValue(DESCRIPTORS);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("renders human guidance and table by default", async () => {
    await handleToolsList({});
    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("Backend tools available");
    expect(output).toContain("fml tools describe <tool>");
    expect(output).toContain("fml tools call <tool>");
    expect(output).toContain("integration-github");
    expect(output).toContain("integrations");
    expect(output).toContain("Query the GitHub integration");
  });

  it("appends (experimental) suffix for experimental tools in table mode", async () => {
    await handleToolsList({});
    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("(experimental)");
  });

  it("outputs valid JSON with --json", async () => {
    await handleToolsList({ json: true });
    const raw = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
  });

  it("filters by category", async () => {
    await handleToolsList({ category: "integrations" });
    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("integration-github");
    expect(output).not.toContain("run-experimental");
  });

  it("filters by category with --json", async () => {
    await handleToolsList({ category: "integrations", json: true });
    const raw = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw) as Array<{ name: string }>;
    expect(parsed.every((d) => d.name !== "run-experimental")).toBe(true);
  });

  it("exits 1 and shows login message when unauthenticated", async () => {
    mockGetAuthenticatedClient.mockResolvedValue(null);
    await expect(handleToolsList({})).rejects.toThrow("process.exit(1)");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("fml login"));
  });
});

describe("handleToolsDescribe", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`process.exit(${_code})`);
      });
    mockGetAuthenticatedClient.mockResolvedValue({
      listTools: mockListTools,
      callBackend: mockCallBackend,
    });
    mockListTools.mockResolvedValue(DESCRIPTORS);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("prints tool details in default mode", async () => {
    await handleToolsDescribe("integration-github", {});
    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("integration-github");
    expect(output).toContain("Query the GitHub integration");
    expect(output).toContain("Input schema:");
  });

  it("outputs raw descriptor as JSON with --json", async () => {
    await handleToolsDescribe("integration-github", { json: true });
    const raw = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw) as { name: string };
    expect(parsed.name).toBe("integration-github");
  });

  it("exits 1 for unknown tool", async () => {
    await expect(handleToolsDescribe("no-such-tool", {})).rejects.toThrow(
      "process.exit(1)",
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown tool"),
    );
  });

  it("suggests near matches for typos", async () => {
    // "integration-githb" is one edit away from "integration-github"
    await expect(handleToolsDescribe("integration-githb", {})).rejects.toThrow(
      "process.exit(1)",
    );
    const errorOutput = errorSpy.mock.calls
      .map((c: unknown[]) => c.join(" "))
      .join("\n");
    expect(errorOutput).toContain("Did you mean");
    expect(errorOutput).toContain("integration-github");
  });
});

describe("handleToolsCall", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`process.exit(${_code})`);
      });
    mockGetAuthenticatedClient.mockResolvedValue({
      listTools: mockListTools,
      callBackend: mockCallBackend,
    });
    mockListTools.mockResolvedValue(DESCRIPTORS);
    mockCallBackend.mockResolvedValue({ ok: true, result: { success: true } });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("happy path: calls backend and prints JSON result", async () => {
    await handleToolsCall("integration-github", {
      args: JSON.stringify({ endpoint: "/repos/foo/bar" }),
    });
    expect(mockCallBackend).toHaveBeenCalledWith("integration-github", {
      endpoint: "/repos/foo/bar",
    });
    const raw = logSpy.mock.calls[0][0] as string;
    expect(JSON.parse(raw)).toEqual({ success: true });
  });

  it("exits 1 when both --args and --file provided", async () => {
    await expect(
      handleToolsCall("integration-github", {
        args: "{}",
        file: "some.json",
      }),
    ).rejects.toThrow("process.exit(1)");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("mutually exclusive"),
    );
  });

  it("exits 1 on malformed JSON in --args", async () => {
    await expect(
      handleToolsCall("integration-github", { args: "not json" }),
    ).rejects.toThrow("process.exit(1)");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid JSON"),
    );
  });

  it("exits 1 on non-existent --file", async () => {
    await expect(
      handleToolsCall("integration-github", {
        file: "/nonexistent/path/args.json",
      }),
    ).rejects.toThrow("process.exit(1)");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not read args file"),
    );
  });

  it("reads args from --file", async () => {
    const tmpFile = path.join(tmpdir(), `fml-test-${Date.now()}.json`);
    writeFileSync(tmpFile, JSON.stringify({ endpoint: "/users" }), "utf8");
    try {
      await handleToolsCall("integration-github", { file: tmpFile });
      expect(mockCallBackend).toHaveBeenCalledWith("integration-github", {
        endpoint: "/users",
      });
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("exits 1 for unknown tool name", async () => {
    await expect(
      handleToolsCall("no-such-tool", { args: "{}" }),
    ).rejects.toThrow("process.exit(1)");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown tool"),
    );
  });

  it("exits 1 when backend returns { ok: false }", async () => {
    mockCallBackend.mockResolvedValue({ ok: false, error: "backend error" });
    await expect(
      handleToolsCall("list-integrations", { args: "{}" }),
    ).rejects.toThrow("process.exit(1)");
    expect(errorSpy).toHaveBeenCalledWith("backend error");
  });
});
