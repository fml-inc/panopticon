import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockFetch } from "@/test/mocks/api";
import { renderWithProviders } from "@/test/test-utils";
import { Dashboard } from "./Dashboard";

describe("Dashboard", () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchSpy = mockFetch();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders widget titles", async () => {
    renderWithProviders(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("Total Sessions")).toBeInTheDocument();
    });

    expect(screen.getByText("Cost by Day")).toBeInTheDocument();
  });

  it("shows widget type badges", async () => {
    renderWithProviders(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("kpi")).toBeInTheDocument();
    });

    expect(screen.getByText("chart")).toBeInTheDocument();
  });

  it("fetches widgets from API", async () => {
    renderWithProviders(<Dashboard />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/v2/widgets"),
      );
    });
  });

  it("shows empty state when no widgets", async () => {
    fetchSpy.mockRestore();
    fetchSpy = mockFetch({ widgets: [] });

    renderWithProviders(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("No Widgets Yet")).toBeInTheDocument();
    });
  });
});
