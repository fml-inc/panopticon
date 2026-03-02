import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockFetch } from "@/test/mocks/api";
import { renderWithProviders } from "@/test/test-utils";
import { Sessions } from "./Sessions";

describe("Sessions", () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchSpy = mockFetch();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders session list", async () => {
    renderWithProviders(<Sessions />);

    await waitFor(() => {
      expect(screen.getByText("test-session-1")).toBeInTheDocument();
    });

    expect(screen.getByText("test-session-2")).toBeInTheDocument();
  });

  it("displays event and tool counts", async () => {
    renderWithProviders(<Sessions />);

    await waitFor(() => {
      expect(screen.getByText("42")).toBeInTheDocument();
    });

    expect(screen.getByText("5")).toBeInTheDocument(); // tool_count for session 1
  });

  it("shows cost for sessions", async () => {
    renderWithProviders(<Sessions />);

    await waitFor(() => {
      expect(screen.getByText("$0.2500")).toBeInTheDocument();
    });
  });

  it("shows loading state initially", () => {
    renderWithProviders(<Sessions />);
    // React Query should be loading initially
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/v2/sessions"),
    );
  });

  it("fetches from correct API endpoint", async () => {
    renderWithProviders(<Sessions />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/v2/sessions"),
      );
    });
  });
});
