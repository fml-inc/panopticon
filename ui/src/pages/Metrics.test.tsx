import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockFetch } from "@/test/mocks/api";
import { renderWithProviders } from "@/test/test-utils";
import { Metrics } from "./Metrics";

describe("Metrics", () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchSpy = mockFetch();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders KPI cards", async () => {
    renderWithProviders(<Metrics />);

    await waitFor(() => {
      expect(screen.getByText("Total Spend")).toBeInTheDocument();
    });

    expect(screen.getByText("Input Tokens")).toBeInTheDocument();
    expect(screen.getByText("Output Tokens")).toBeInTheDocument();
    expect(screen.getByText("Cache Hit Rate")).toBeInTheDocument();
    expect(screen.getByText("Tool Calls")).toBeInTheDocument();
  });

  it("renders tool stats table", async () => {
    renderWithProviders(<Metrics />);

    await waitFor(() => {
      expect(screen.getByText("Bash")).toBeInTheDocument();
    });

    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });

  it("displays success rates", async () => {
    renderWithProviders(<Metrics />);

    // Bash: 90/100 = 90%
    await waitFor(() => {
      expect(screen.getByText("90%")).toBeInTheDocument();
    });
  });

  it("renders model breakdown", async () => {
    renderWithProviders(<Metrics />);

    await waitFor(() => {
      expect(screen.getByText("claude-sonnet-4-20250514")).toBeInTheDocument();
    });

    expect(screen.getByText("claude-haiku-3.5")).toBeInTheDocument();
  });

  it("fetches metrics from correct endpoint", async () => {
    renderWithProviders(<Metrics />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/v2/metrics"),
      );
    });
  });
});
