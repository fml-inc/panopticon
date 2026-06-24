import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDoctor = vi.fn();
const mockGetValidToken = vi.fn();
const mockReadTokens = vi.fn();
const mockCreateFmlClient = vi.fn();
const mockParsePanopticonRunning = vi.fn();

vi.mock("../../../doctor.js", () => ({
  doctor: (...args: unknown[]) => mockDoctor(...args),
}));

vi.mock("../../auth/token-store.js", () => ({
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
  readTokens: (...args: unknown[]) => mockReadTokens(...args),
  SERVICE_TOKEN_LOGIN_USER_ID: "service-token",
}));

vi.mock("../../fml-client.js", () => ({
  createFmlClient: (...args: unknown[]) => mockCreateFmlClient(...args),
}));

vi.mock("../../commands/daemon.js", () => ({
  parsePanopticonRunning: (...args: unknown[]) =>
    mockParsePanopticonRunning(...args),
}));

import { handleDoctor } from "../../commands/doctor.js";

describe("doctor command", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockGetValidToken.mockResolvedValue("fml-token");
    mockReadTokens.mockReturnValue({
      accessToken: "fml-token",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
      user: { id: "u1", email: "test@example.com", name: "Test User" },
    });
    mockDoctor.mockResolvedValue({
      checks: [
        {
          label: "Sync",
          status: "ok",
          detail: "1 target: fml -> https://example.test",
        },
      ],
      system: { os: "test", node: "v1", sandbox: false },
      recentEvents: [],
      recentErrors: [],
    });
    mockParsePanopticonRunning.mockReturnValue(true);
    mockCreateFmlClient.mockReturnValue({
      callBackend: vi.fn().mockResolvedValue({ ok: true }),
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("does not add a second FML sync status when Panopticon doctor reports sync", async () => {
    await handleDoctor({ json: true });

    const output = String(consoleSpy.mock.calls[0]?.[0] ?? "");
    const checks = JSON.parse(output) as Array<{ label: string }>;

    expect(checks.filter((check) => check.label === "Sync")).toHaveLength(1);
    expect(checks.some((check) => check.label.startsWith("Sync →"))).toBe(
      false,
    );
  });
});
